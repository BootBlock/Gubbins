/**
 * Making a freshly-built snapshot internally foreign-key-consistent (issue #405).
 *
 * `buildLocalSnapshot` reads each table with its own unisolated query — the driver has no
 * row-returning transaction, so there is no way to hold one point-in-time view across the
 * dozens of reads a snapshot makes. `SYNC_TABLES` is ordered parents-first, so a row written
 * between the read of its parent's table and the read of its own arrives in the snapshot with
 * **its parent missing**. Concurrent writers are expected: the Node bridge is a peer writing to
 * the same dataset, and in-app background work is not excluded either.
 *
 * Issue #204 made each *individual* table read self-correcting (keyset paging). This is the
 * cross-table half, and it matters more than the row loss #204 fixed: a restore applies the
 * whole snapshot in **one transaction**, and SQLite's `OR IGNORE` / `ON CONFLICT` resolution
 * covers UNIQUE, NOT NULL, CHECK and PRIMARY KEY — but *not* FOREIGN KEY. So one orphaned row
 * does not cost that row, it aborts the transaction and costs the entire restore.
 *
 * The repair here keeps the bad data out of the snapshot rather than teaching each apply path to
 * tolerate it: `applyPlan`, `restoreSnapshot` and `buildCloneStatements` all consume snapshots,
 * a backup file is an artefact users keep for years, and "local data → filter on read" is the
 * standing rule for data already in our own database. It mirrors what `filterSnapshot` in the
 * backup codec already does for user-excluded items — the same shape, a different cause.
 *
 * **What this does not do:** it does not give the snapshot a true point-in-time read. It
 * converts "the restore aborts and everything is lost" into "a row caught mid-write is omitted
 * from this snapshot" — which the next snapshot picks up, the same self-correcting property
 * #204 established.
 */
import {
  ADMIN_USER_ID,
  IN_TRANSIT_LOCATION_ID,
  SYSTEM_USER_ID,
  UNASSIGNED_LOCATION_ID,
} from '@/db/repositories/constants';
import { SYNC_TABLES, type SyncTable } from '@/db/repositories/tombstone';
import type { SqlRow } from '@/db/rpc/driver';
import { FK_REFS, type FkRef } from './fk-refs';
import type { SyncSnapshot } from './types';

/**
 * Rows every device is guaranteed to hold, and which therefore must **never** be treated as an
 * absent parent — even though they are deliberately absent from the snapshot itself.
 *
 * The system-locked locations and the built-in System/Admin principals are seeded with these
 * exact constant ids by the baseline on every device, and are excluded from the snapshot on
 * purpose (a remote UPSERT would trip their protect triggers). Without this set the repair below
 * would read "Unassigned is not in `tables.locations`" and re-home or drop **every item in the
 * inventory** — a spectacular own goal. Identified by id for the same reason the rescue read is:
 * the id is stable across every revision of the baseline, whereas the columns the read filter
 * names (`locations.is_system`, `users.kind`) may not exist in a differently-shaped database.
 */
export const ALWAYS_PRESENT_ROW_IDS: Partial<Record<SyncTable, readonly string[]>> = {
  locations: [UNASSIGNED_LOCATION_ID, IN_TRANSIT_LOCATION_ID],
  users: [SYSTEM_USER_ID, ADMIN_USER_ID],
};

/**
 * A foreign-key reference as the *snapshot* repair sees it, extending the shared {@link FkRef}
 * with the one repair the merge engine has no need to express.
 *
 * `fallback` re-points a dangling reference at a row that always exists, for a column that is
 * NOT NULL and so can be neither cleared nor safely dropped. It mirrors what the schema itself
 * does on delete, and exists because dropping the row would be far more destructive than the
 * dangling reference: an item whose location was written mid-read is real inventory.
 */
interface SnapshotFkRef extends FkRef {
  readonly fallback?: string;
}

/**
 * References the repair must honour that {@link FK_REFS} deliberately does not carry, because
 * the merge engine resolves them another way.
 *
 * - `items.location_id` — NOT NULL with no ON DELETE action. `FK_REFS` omits it because the
 *   §7.5.2 re-parent already re-homes orphaned items during a merge; that pass does not run when
 *   a snapshot is merely *built*, so the repair re-homes to Unassigned here. Dropping the item
 *   instead would delete real inventory over a location that exists perfectly well locally.
 * - `locations.parent_id` — nullable self-reference. A location can dangle against its own
 *   table: paging reads `locations` in id order, so a parent written behind the cursor is missed
 *   while a child written ahead of it is not. Clearing the link flattens the branch to the root
 *   rather than losing the location and everything stored in it.
 */
const EXTRA_REFS: Partial<Record<SyncTable, readonly SnapshotFkRef[]>> = {
  items: [{ col: 'location_id', parent: 'locations', nullable: false, fallback: UNASSIGNED_LOCATION_ID }],
  locations: [{ col: 'parent_id', parent: 'locations', nullable: true }],
  // The location activity record's actor (issue #691) — NOT NULL `ON DELETE SET DEFAULT`, so its
  // repair is the schema's own: re-attribute to System. `FK_REFS` cannot express that, and the
  // `nullable: false` it *can* express would drop the entry over an account created mid-read. The
  // same reasoning, and the same fallback, as {@link HISTORY_REFS} below.
  location_history: [{ col: 'actor_user_id', parent: 'users', nullable: false, fallback: SYSTEM_USER_ID }],
};

/** Every reference the repair checks for a given table. */
function refsFor(table: SyncTable): readonly SnapshotFkRef[] {
  const base = FK_REFS[table] ?? [];
  const extra = EXTRA_REFS[table] ?? [];
  return extra.length === 0 ? base : [...base, ...extra];
}

/**
 * The `item_history` references. The ledger is not a synced table, so it has no `FK_REFS` entry
 * of its own, but it is carried in the snapshot and has the same exposure.
 *
 * `actor_user_id` is NOT NULL `REFERENCES users(id) ON DELETE SET DEFAULT`, so its repair is the
 * schema's own: re-attribute to System. That keeps the ledger entry — what happened is a fact
 * worth more than who is recorded as having done it — where dropping it would lose history
 * because an account was created mid-read.
 */
const HISTORY_REFS: readonly SnapshotFkRef[] = [
  { col: 'item_id', parent: 'items', nullable: false },
  { col: 'actor_user_id', parent: 'users', nullable: false, fallback: SYSTEM_USER_ID },
];

/**
 * The `stock_deltas` references (issue #188). Only `item_id` is a foreign key — NOT NULL /
 * ON DELETE CASCADE, so a delta whose item was written mid-read is dropped (a delta for an absent
 * item would replay the convergence CRDT against nothing). `location_id` / `batch_key` are plain
 * historical coordinates with no FK, so they need no repair.
 */
const STOCK_DELTAS_REFS: readonly SnapshotFkRef[] = [{ col: 'item_id', parent: 'items', nullable: false }];

/** The ids of `table` that a consumer of this snapshot will actually be able to reference. */
function presentIds(rows: readonly SqlRow[] | undefined, table: SyncTable): Set<string> {
  const ids = new Set<string>(ALWAYS_PRESENT_ROW_IDS[table] ?? []);
  for (const row of rows ?? []) ids.add(String(row.id));
  return ids;
}

/** Options for {@link repairSnapshotIntegrity}. */
export interface RepairOptions {
  /**
   * Tables whose read failed outright, under `buildLocalSnapshot`'s `skipUnreadable` rescue mode.
   *
   * Such a table is empty in the snapshot because it could not be read at all, **not** because
   * its rows are gone. Repairing against it would read every child as orphaned and cascade the
   * loss outward — an unreadable `items` would take every image, alias, stock row and history
   * entry with it, turning a partial rescue snapshot into an almost-empty one. So a skipped
   * parent is treated as intact, exactly as the merge engine treats a parent it has never heard
   * of. Those children may then fail to restore, which is the correct trade: the rescue path
   * exists to salvage what it can, and a snapshot that restores most of a broken database beats
   * one that quietly discarded the rest of it.
   */
  readonly unreadableTables?: ReadonlySet<string>;
}

/**
 * Drop or repair every row of `snapshot` whose parent is missing from it, returning a snapshot
 * that is foreign-key-consistent by construction. **Pure** — returns a new snapshot.
 *
 * A single pass in `SYNC_TABLES` order resolves the whole graph, including chains two deep
 * (`locations → location_photos → location_regions`), because that list is ordered parents-first:
 * by the time a table is reached, its parents have already been reduced to their surviving rows,
 * so dropping a parent cascades to its children in the same pass.
 */
export function repairSnapshotIntegrity(snapshot: SyncSnapshot, options: RepairOptions = {}): SyncSnapshot {
  const unreadable = options.unreadableTables ?? new Set<string>();
  const surviving = new Map<SyncTable, Set<string>>();
  for (const table of SYNC_TABLES) surviving.set(table, presentIds(snapshot.tables[table], table));

  /** Whether `parent` is a table the repair is entitled to draw conclusions from. */
  const known = (parent: SyncTable) => !unreadable.has(parent);

  /**
   * Repair one row, or `undefined` to drop it. Returns the row unchanged when nothing dangles,
   * so an untouched snapshot keeps its original row objects.
   */
  const repairRow = (row: SqlRow, refs: readonly SnapshotFkRef[]): SqlRow | undefined => {
    let repaired = row;
    for (const { col, parent, nullable, fallback } of refs) {
      const value = repaired[col];
      // A reference that is already absent needs no repair, and a parent table we could not read
      // tells us nothing about whether the row it names exists.
      if (value === null || value === undefined || !known(parent)) continue;
      if (surviving.get(parent)?.has(String(value))) continue;
      if (fallback !== undefined) repaired = { ...repaired, [col]: fallback };
      else if (nullable) repaired = { ...repaired, [col]: null };
      else return undefined;
    }
    return repaired;
  };

  const tables: Record<string, SqlRow[]> = {};
  for (const [name, rows] of Object.entries(snapshot.tables)) tables[name] = [...rows];
  for (const table of SYNC_TABLES) {
    const rows = snapshot.tables[table];
    if (!rows) continue;
    const refs = refsFor(table);
    if (refs.length > 0) {
      const kept: SqlRow[] = [];
      for (const row of rows) {
        const repaired = repairRow(row, refs);
        if (repaired !== undefined) kept.push(repaired);
      }
      tables[table] = kept;
    }
    // Narrow the parent set to what actually survived *before* any child table is reached, so a
    // dropped parent takes its children with it rather than leaving them dangling one level down.
    surviving.set(table, presentIds(tables[table], table));
  }

  const items = surviving.get('items') ?? new Set<string>();
  const tags = surviving.get('tags') ?? new Set<string>();
  const locations = surviving.get('locations') ?? new Set<string>();
  const regions = surviving.get('location_regions') ?? new Set<string>();
  /** Whether an edge endpoint holds, given a parent table we may not have been able to read. */
  const holds = (parent: SyncTable, ids: ReadonlySet<string>, id: string) => !known(parent) || ids.has(id);

  const itemHistory: SqlRow[] = [];
  for (const row of snapshot.itemHistory ?? []) {
    const repaired = repairRow(row, HISTORY_REFS);
    if (repaired !== undefined) itemHistory.push(repaired);
  }
  // The stock-delta convergence ledger, repaired against its only reference (item_id) exactly as
  // the history ledger above — a delta whose item was caught mid-read is dropped rather than
  // aborting the whole restore transaction (issue #405).
  const stockDeltas: SqlRow[] = [];
  for (const row of snapshot.stockDeltas ?? []) {
    const repaired = repairRow(row, STOCK_DELTAS_REFS);
    if (repaired !== undefined) stockDeltas.push(repaired);
  }
  // The gauge deltas are filtered by their **item**, not by whether the matching ledger row
  // survived. The two are read by separate queries — the gauge read has its own `WHERE`, and
  // `readItemHistory` pages by `(created_at, id)` and can fail on its own — so `itemHistory`
  // being empty does not mean the ledger is. Keying off it would discard every delta in the
  // snapshot the moment that one read failed, which is the cascade the rescue guard exists to
  // prevent. The item is the only reference a delta actually has (matching how the backup codec
  // filters them), and a delta replayed for an item the snapshot does not carry would resolve the
  // §7.3 Delta-CRDT against nothing.
  const gaugeHistory = (snapshot.gaugeHistory ?? []).filter((delta) => holds('items', items, delta.itemId));

  return {
    ...snapshot,
    tables,
    itemHistory,
    stockDeltas,
    gaugeHistory,
    itemTags: (snapshot.itemTags ?? []).filter(
      (edge) => holds('items', items, edge.itemId) && holds('tags', tags, edge.tagId),
    ),
    locationTags: (snapshot.locationTags ?? []).filter(
      (edge) => holds('locations', locations, edge.locationId) && holds('tags', tags, edge.tagId),
    ),
    itemRegions: (snapshot.itemRegions ?? []).filter(
      (edge) => holds('items', items, edge.itemId) && holds('location_regions', regions, edge.regionId),
    ),
  };
}
