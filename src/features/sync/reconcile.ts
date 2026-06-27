/**
 * The pure reconciliation engine (spec §7.3 diffing, §7.5 relational integrity).
 *
 * Given the local snapshot, the remote snapshot, a clock offset and the schema
 * dictionary, it produces a {@link ReconciliationPlan} describing the **local**
 * mutations to apply atomically:
 *
 *  - per-table LWW with tombstone resolution (§7.3) — remote rows win when strictly
 *    newer (after the §7.3 offset is applied to local timestamps), tombstones win
 *    when newer than the opposing row, and a row strictly newer than a tombstone
 *    "resurrects" (the tombstone is dropped from the merge);
 *  - §7.3 schema-dictionary sanitisation of every downloaded row;
 *  - §7.3 Delta-CRDT replay for `current_net_value` on gauges touched on both sides;
 *  - §7.5.2 re-parenting of any item whose target location did not survive the merge;
 *  - §7.5.3 rejection of location moves that would create a nesting cycle.
 *
 * The engine never touches the database — the orchestrator applies the plan and
 * re-reads the merged state to push — so it is exhaustively unit-tested in isolation.
 */
import { UNASSIGNED_LOCATION_ID, SYNC_TABLES } from '@/db/repositories';
import type { SqlRow } from '@/db/rpc/driver';
import { applyOffset } from './clock';
import { reconcileGauge } from './delta-crdt';
import { resolveLww } from './lww';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import type {
  GaugeHistoryDelta,
  GaugeResolution,
  ReconciliationPlan,
  ReparentLog,
  SchemaDictionary,
  SyncSnapshot,
  SyncTable,
  TableRow,
  Tombstone,
} from './types';

export interface ReconcileOptions {
  /** Offset added to every local `updated_at`/`deleted_at` before diffing (§7.3). */
  readonly offset: number;
  /** Live column sets per table for §7.3 payload sanitisation. */
  readonly dictionary: SchemaDictionary;
}

const EMPTY_PLAN: ReconciliationPlan = {
  localUpserts: [],
  localDeletes: [],
  gaugeResolutions: [],
  reparented: [],
  rejectedCycles: [],
};

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function rowsById(rows: readonly SqlRow[]): Map<string, SqlRow> {
  const map = new Map<string, SqlRow>();
  for (const row of rows) map.set(String(row.id), row);
  return map;
}

/** Tombstones for one table, id → deletedAt. */
function tombstonesFor(tombstones: readonly Tombstone[], table: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tombstones) if (t.tableName === table) map.set(t.id, t.deletedAt);
  return map;
}

export function reconcile(
  local: SyncSnapshot,
  remote: SyncSnapshot | null,
  options: ReconcileOptions,
): ReconciliationPlan {
  // No remote yet — first publish. Nothing to pull; the orchestrator pushes local.
  if (remote === null) return EMPTY_PLAN;

  const { offset, dictionary } = options;
  const localUpserts: TableRow[] = [];
  const localDeletes: Tombstone[] = [];

  // --- per-table LWW + tombstone resolution (§7.3) ------------------------------
  for (const table of SYNC_TABLES) {
    const localRows = rowsById(local.tables[table] ?? []);
    const remoteRows = rowsById(remote.tables[table] ?? []);
    const localTomb = tombstonesFor(local.tombstones, table);
    const remoteTomb = tombstonesFor(remote.tombstones, table);
    const allowed = dictionary[table] ?? [];

    const ids = new Set<string>([...localRows.keys(), ...remoteRows.keys()]);

    for (const id of ids) {
      const l = localRows.get(id);
      const r = remoteRows.get(id);
      const lUpd = l ? applyOffset(num(l.updated_at), offset) : undefined;
      const rUpd = r ? num(r.updated_at) : undefined;
      const rTomb = remoteTomb.get(id);

      // Remote deleted this row.
      if (rTomb !== undefined) {
        // Local has a strictly-newer row → resurrect (keep local, drop tombstone).
        if (lUpd !== undefined && lUpd > rTomb) continue;
        // Otherwise the remote tombstone wins: delete locally + record it.
        if (l !== undefined) localDeletes.push({ tableName: table, id, deletedAt: rTomb });
        continue;
      }

      if (l && r) {
        if (resolveLww(lUpd!, rUpd!) === 'REMOTE_WINS') {
          localUpserts.push({ table, row: sanitiseRow(r, allowed) });
        }
        // LOCAL_WINS → nothing to apply; the push half carries it.
      } else if (r && !l) {
        // New on the remote (and not locally tombstoned newer) → download it.
        const lTomb = localTomb.get(id);
        const lTombOffset = lTomb !== undefined ? applyOffset(lTomb, offset) : undefined;
        if (lTombOffset !== undefined && lTombOffset >= rUpd!) continue; // our delete wins
        localUpserts.push({ table, row: sanitiseRow(r, allowed) });
      }
      // l && !r with no remote tombstone → purely local; push half carries it.
    }
  }

  // --- §4/§7.5 alias-text collision resolution ----------------------------------
  // `item_aliases.alias` is globally UNIQUE (COLLATE NOCASE). Two devices mapping the
  // same supplier part number to *different* items would otherwise make the atomic
  // apply trip that constraint. Resolve by LWW on the alias rows themselves: the newer
  // mapping wins the text; the loser is dropped (tombstoned if it was local).
  resolveAliasCollisions(local, localUpserts, localDeletes, offset);

  // --- §7.5.2 orphan re-parenting ------------------------------------------------
  const reparented: ReparentLog[] = [];
  const activeLocationIds = computeActiveLocations(local, localUpserts, localDeletes);
  const itemUpsertIndex = new Map<string, number>();
  localUpserts.forEach((u, i) => {
    if (u.table === 'items') itemUpsertIndex.set(String(u.row.id), i);
  });

  const deletedItemIds = new Set(localDeletes.filter((d) => d.tableName === 'items').map((d) => d.id));

  // Every item that will exist locally after the merge: untouched local items +
  // items being upserted. Re-home any whose target location did not survive.
  const finalItems = new Map<string, SqlRow>();
  for (const row of local.tables.items ?? []) {
    if (!deletedItemIds.has(String(row.id))) finalItems.set(String(row.id), row);
  }
  for (const u of localUpserts) if (u.table === 'items') finalItems.set(String(u.row.id), u.row);

  for (const [id, row] of finalItems) {
    const target = String(row.location_id);
    const res = resolveLocationTarget(target, activeLocationIds);
    if (!res.reparented) continue;
    reparented.push({ itemId: id, fromLocationId: target });
    const fixed: SqlRow = { ...row, location_id: res.locationId };
    const existing = itemUpsertIndex.get(id);
    if (existing !== undefined) {
      localUpserts[existing] = { table: 'items', row: fixed };
    } else {
      localUpserts.push({ table: 'items', row: fixed });
    }
  }

  // --- §7.5.3 cyclical-nesting rejection ----------------------------------------
  const rejectedCycles = rejectLocationCycles(local, localUpserts);

  // --- §7.3 Delta-CRDT gauge reconciliation -------------------------------------
  const gaugeResolutions = reconcileGauges(local, remote, finalItems);

  return { localUpserts, localDeletes, gaugeResolutions, reparented, rejectedCycles };
}

/**
 * Resolve §4 Universal-Alias-Mapping text collisions before the atomic apply. An
 * incoming alias upsert whose `alias` text already belongs to a *different* local id
 * (and that local row is not being deleted) would violate the UNIQUE(alias) index.
 * Resolve by LWW on `updated_at`: if the incoming row is newer it wins the text and
 * the local conflicting row is deleted+tombstoned; otherwise the incoming upsert is
 * dropped (the local mapping stands and the push half re-asserts it). Mutates
 * `localUpserts`/`localDeletes` in place.
 */
function resolveAliasCollisions(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: Tombstone[],
  offset: number,
): void {
  const TABLE = 'item_aliases';
  const deletedIds = new Set(localDeletes.filter((d) => d.tableName === TABLE).map((d) => d.id));
  // Surviving local alias rows, keyed by lower-cased alias text.
  const localByText = new Map<string, { id: string; updatedAt: number }>();
  for (const row of local.tables[TABLE] ?? []) {
    const id = String(row.id);
    if (deletedIds.has(id)) continue;
    localByText.set(String(row.alias).toLowerCase(), { id, updatedAt: applyOffset(num(row.updated_at), offset) });
  }

  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    if (u.table !== TABLE) continue;
    const upId = String(u.row.id);
    const text = String(u.row.alias).toLowerCase();
    const upUpd = num(u.row.updated_at);
    const hit = localByText.get(text);
    if (!hit || hit.id === upId) continue; // no clash, or it's the same row updating

    if (upUpd > hit.updatedAt) {
      // Incoming mapping wins the text → remove the local conflicting row.
      localDeletes.push({ tableName: TABLE, id: hit.id, deletedAt: upUpd });
      localByText.set(text, { id: upId, updatedAt: upUpd });
    } else {
      // Local mapping wins → discard the incoming upsert.
      localUpserts.splice(i, 1);
    }
  }
}

/** Location ids that survive the merge (plus the always-present Unassigned). */
function computeActiveLocations(
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
): Set<string> {
  const active = new Set<string>([UNASSIGNED_LOCATION_ID]);
  for (const row of local.tables.locations ?? []) active.add(String(row.id));
  for (const u of localUpserts) if (u.table === 'locations') active.add(String(u.row.id));
  for (const d of localDeletes) if (d.tableName === 'locations') active.delete(d.id);
  return active;
}

/**
 * Discard any location upsert whose new `parent_id` would close a nesting cycle
 * against the merged tree (§7.5.3), returning the rejected location ids. Mutates
 * `localUpserts` in place to drop the offending move (the local hierarchy stands).
 */
function rejectLocationCycles(local: SyncSnapshot, localUpserts: TableRow[]): string[] {
  const rejected: string[] = [];
  // Build the merged parent map: local rows overlaid with the winning upserts.
  const parentOf = new Map<string, string | null>();
  for (const row of local.tables.locations ?? []) {
    parentOf.set(String(row.id), row.parent_id === null ? null : String(row.parent_id));
  }
  for (const u of localUpserts) {
    if (u.table === 'locations') {
      parentOf.set(String(u.row.id), u.row.parent_id === null ? null : String(u.row.parent_id));
    }
  }

  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    if (u.table !== 'locations') continue;
    const id = String(u.row.id);
    const newParent = u.row.parent_id === null ? null : String(u.row.parent_id);
    if (wouldCreateCycle(id, newParent, parentOf)) {
      rejected.push(id);
      // Restore the local parent edge and drop the upsert.
      const localRow = (local.tables.locations ?? []).find((r) => String(r.id) === id);
      parentOf.set(id, localRow && localRow.parent_id !== null ? String(localRow.parent_id) : null);
      localUpserts.splice(i, 1);
    }
  }
  return rejected;
}

/** §7.3 Delta-CRDT: replay merged gauge deltas for items present on both sides. */
function reconcileGauges(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  finalItems: ReadonlyMap<string, SqlRow>,
): GaugeResolution[] {
  const resolutions: GaugeResolution[] = [];
  const localItems = rowsById(local.tables.items ?? []);
  const remoteItems = rowsById(remote.tables.items ?? []);
  const localDeltas = byItem(local.gaugeHistory);
  const remoteDeltas = byItem(remote.gaugeHistory);

  for (const [id, row] of finalItems) {
    if (String(row.tracking_mode) !== 'CONSUMABLE_GAUGE') continue;
    // Only the concurrent case needs delta replay; a one-sided gauge keeps its LWW value.
    if (!localItems.has(id) || !remoteItems.has(id)) continue;
    const gross = num(row.gross_capacity);
    if (!Number.isFinite(gross)) continue;
    const netValue = reconcileGauge(gross, localDeltas.get(id) ?? [], remoteDeltas.get(id) ?? []);
    resolutions.push({ itemId: id, netValue });
  }
  return resolutions;
}

function byItem(deltas: readonly GaugeHistoryDelta[]): Map<string, GaugeHistoryDelta[]> {
  const map = new Map<string, GaugeHistoryDelta[]>();
  for (const d of deltas) {
    const list = map.get(d.itemId) ?? [];
    list.push(d);
    map.set(d.itemId, list);
  }
  return map;
}

export { SYNC_TABLES };
export type { SyncTable };
