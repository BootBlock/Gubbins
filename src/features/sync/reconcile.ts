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
import { BUILTIN_USER_IDS, SYSTEM_USER_ID } from '@/db/repositories/constants';
// Imported from the defining modules rather than the `@/db/repositories` barrel: this module
// now runs inside the database worker (issue #173), and the barrel wires the repository layer
// to the main thread's session/preferences stores — pulling those into the worker would give
// it a second, never-updated copy of state it has no business holding.
import { UNASSIGNED_LOCATION_ID } from '@/db/repositories/constants';
import {
  SYNC_TABLES,
  ITEM_HISTORY_TABLE,
  ITEM_TAGS_TABLE,
  ITEM_REGIONS_TABLE,
  LOCATION_TAGS_TABLE,
  itemTagEdgeId,
  itemRegionEdgeId,
  locationTagEdgeId,
  parseItemTagEdgeId,
  parseLocationTagEdgeId,
} from '@/db/repositories/tombstone';
import type { SqlRow } from '@/db/rpc/driver';
import { applyOffset } from './clock';
import { buildConflict, nonLwwColumns } from './conflict-detect';
import { reconcileGauge } from './delta-crdt';
import { FK_REFS } from './fk-refs';
import { resolveLww } from './lww';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import { SUPPLIER_PART_FLAG_COLUMNS, flagWinner, type FlagRanked } from './supplier-part-flags';
import { resolveUniqueKeyCollisions } from './unique-keys';
import type {
  FlagRepair,
  GaugeHistoryDelta,
  GaugeResolution,
  ItemTagEdge,
  ItemTagEdgeDelete,
  ItemRegionEdge,
  ItemRegionEdgeDelete,
  LocationTagEdge,
  LocationTagEdgeDelete,
  ReconciliationPlan,
  ReparentLog,
  SchemaDictionary,
  SerialisedLoanClosure,
  SyncConflict,
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
  /**
   * §7.6.3-A prune watermark: a remote `item_history` row older than this instant is
   * NOT re-imported, so a device that deliberately pruned its ledger keeps that space
   * reclaimed instead of re-downloading the pruned era from a peer. Defaults to 0.
   */
  readonly historyPrunedBefore?: number;
  /**
   * Issue #72: the **local-frame** instant of the last successful sync. A row edited on
   * this device *after* this instant, that then loses LWW to a remote change or deletion,
   * is a genuine concurrent collision — the user's offline work is being overwritten — and
   * is surfaced as a {@link SyncConflict}. Left undefined (or ≤ 0) detection is off: the
   * first-ever sync has no prior common state, so nothing there is "concurrent".
   */
  readonly conflictSince?: number;
  /** Clock stamped onto detected conflicts (the sync's effective now). Defaults to `Date.now()`. */
  readonly now?: number;
}

const EMPTY_PLAN: ReconciliationPlan = {
  localUpserts: [],
  localDeletes: [],
  gaugeResolutions: [],
  reparented: [],
  rejectedCycles: [],
  serialisedLoansClosed: [],
  collisions: [],
  flagRepairs: [],
  historyInserts: [],
  itemTagUpserts: [],
  itemTagDeletes: [],
  locationTagUpserts: [],
  locationTagDeletes: [],
  itemRegionUpserts: [],
  itemRegionDeletes: [],
  conflicts: [],
};

/**
 * Metadata columns that carry no user intent, excluded when deciding whether a losing local
 * row and the winning remote row genuinely *differ* — a re-stamped timestamp alone is churn,
 * not a collision worth surfacing (issue #72).
 */
const CONFLICT_IGNORED_COLUMNS = new Set(['updated_at', 'created_at']);

/**
 * Do two rows of `table` differ in any LWW-authoritative column? (issue #72 collision test).
 * Bookkeeping columns and the table's non-LWW columns (CRDT / trigger-derived — see
 * {@link nonLwwColumns}) are ignored: a difference there is not a lost edit.
 */
function rowsDiffer(a: SqlRow, b: SqlRow, table: SyncTable): boolean {
  const skip = nonLwwColumns(table);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (CONFLICT_IGNORED_COLUMNS.has(key) || skip.has(key)) continue;
    if (String(a[key] ?? '') !== String(b[key] ?? '')) return true;
  }
  return false;
}

/**
 * Would upserting `winner` over the existing local row `l` write nothing but a re-stamp?
 * (issue #161). Unlike {@link rowsDiffer} — which asks "is this a lost edit" and so ignores
 * bookkeeping/non-LWW columns — this asks "is applying this upsert a genuine no-op", so it
 * compares `updated_at` and every other column too.
 *
 * Why it matters: a §7.3 timestamp tie resolves `REMOTE_WINS` (see {@link resolveLww}), so the
 * engine emits an upsert even when the winning row is byte-identical to the one already stored.
 * Applying it sets `updated_at` to the value the row already holds, which the auto-stamp trigger
 * (`WHEN NEW.updated_at = OLD.updated_at`, see `updatedAtTrigger` in `v1-initial.ts`) cannot tell
 * from the caller leaving the column untouched: it fires and bumps the row, so this device now
 * looks strictly newer and pushes the unchanged row back. The peer re-pulls, re-bumps, and the two
 * ping-pong an unedited row forever, inflating every delta. Suppressing the no-op upsert makes a
 * tie genuinely idempotent, exactly as `resolveLww` documents.
 *
 * The comparison ranges over `winner`'s keys — the exact columns the apply's UPSERT will write
 * (`applyPlan` builds `SET col = excluded.col` only for the columns present in the sanitised
 * `winner`). A column on `l` that `winner` does not carry — a per-device sync-excluded column such
 * as `item_images.full_res_downgraded_at`, or a column an older peer's schema lacks — is never
 * written by the upsert, so it cannot make the apply anything other than a no-op and must not
 * defeat the skip. (In practice `buildLocalSnapshot` already strips the excluded columns from `l`
 * too, so this is also robust against a future reader that stops doing so.)
 *
 * Comparing `updated_at` keeps the check frame-safe: it is a no-op **only** when applying would
 * change nothing at all. A strictly-newer remote (or a tie observed across a non-zero clock offset,
 * where the applied server-frame stamp differs from the stored local-frame one) differs in
 * `updated_at`, fails this test, and still applies — adopting that timestamp is a real write and
 * cannot churn, because `NEW.updated_at ≠ OLD.updated_at` leaves the trigger dormant.
 */
function upsertWouldNoOp(l: SqlRow, winner: SqlRow): boolean {
  for (const key of Object.keys(winner)) {
    if (String(l[key] ?? '') !== String(winner[key] ?? '')) return false;
  }
  return true;
}

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

  // --- per-table LWW + tombstone resolution (§7.3) ------------------------------
  const { localUpserts, localDeletes, conflicts } = resolveTableMerges(
    local,
    remote,
    dictionary,
    offset,
    options.conflictSince,
    options.now ?? Date.now(),
  );

  // --- §7.5 natural-key collision resolution (issue #187) -----------------------
  // Runs before every later phase: it can drop upserts, retire ids and repoint references,
  // all of which the FK guard, the tag-edge sections and the apply must see settled.
  const { collisions, rekeys } = resolveUniqueKeyCollisions(local, localUpserts, localDeletes, offset);

  // --- Issue #193 serialised-loan cardinality -----------------------------------
  // Collapse a serialised item that the id-keyed union left on loan more than once. Runs after
  // collision resolution so it sees the settled (possibly contact-repointed) checkout upserts.
  const serialisedLoansClosed = resolveSerialisedLoanConflicts(local, localUpserts, localDeletes);

  // --- §7.5.2 orphan re-parenting ------------------------------------------------
  const { reparented, finalItems, activeLocationIds } = reparentOrphans(local, localUpserts, localDeletes);

  // --- §7.5.3 cyclical-nesting rejection ----------------------------------------
  const rejectedCycles = rejectLocationCycles(local, localUpserts);

  // --- §7.5 relational integrity: don't resurrect a child of a deleted parent ----
  const finalItemIds = new Set(finalItems.keys());
  const removedParents = computeRemovedParents(
    local,
    remote,
    localUpserts,
    localDeletes,
    finalItemIds,
    activeLocationIds,
  );
  enforceForeignKeys(localUpserts, removedParents);

  // --- Issues #157 / #192: "one flag per item" cross-row repair ------------------
  // Runs after the FK guard so it sees the final upsert set, and mutates the losing upserts in
  // place. Per-row LWW cannot enforce a one-of-N flag, so two devices pinning different supplier
  // parts converge to two flagged rows; this reduces each (item, flag) to one deterministic winner.
  const flagRepairs = repairSupplierPartFlags(local, localUpserts, localDeletes, offset);

  // --- §7.3 Delta-CRDT gauge reconciliation -------------------------------------
  const gaugeResolutions = reconcileGauges(local, remote, finalItems);

  // --- Phase 11: non-LWW sections (append-only ledger + M:N membership) ----------
  // Both reference parents (items/tags), so they are filtered to the rows that will
  // survive the merge to keep the atomic apply FK-safe.
  const tagRekeys = rekeys.get('tags') ?? new Map<string, string>();
  const finalTagIds = survivingIds('tags', local, localUpserts, localDeletes);
  // A tag that lost its name to a peer's row is retired, not surviving (issue #187).
  for (const loserId of tagRekeys.keys()) finalTagIds.delete(loserId);
  const finalLocationIds = survivingIds('locations', local, localUpserts, localDeletes);

  // The users an inbound ledger row may be attributed to (issue #79). The built-in System and
  // Admin users are added unconditionally: they are seeded by the baseline on every device and
  // deliberately excluded from the snapshot (see `TABLE_FILTER`), so they never appear in
  // `local.tables.users` — without this, every row written by Admin would arrive orphaned and
  // be re-attributed to System.
  const userRekeys = rekeys.get('users') ?? new Map<string, string>();
  const finalUserIds = survivingIds('users', local, localUpserts, localDeletes);
  for (const loserId of userRekeys.keys()) finalUserIds.delete(loserId);
  for (const builtin of BUILTIN_USER_IDS) finalUserIds.add(builtin);

  const historyInserts = reconcileHistory(
    local,
    remote,
    options.dictionary[ITEM_HISTORY_TABLE],
    options.historyPrunedBefore ?? 0,
    finalItemIds,
    finalUserIds,
    userRekeys,
  );
  const { itemTagUpserts, itemTagDeletes } = reconcileItemTags(
    local,
    remote,
    offset,
    finalItemIds,
    finalTagIds,
    tagRekeys,
  );
  const { locationTagUpserts, locationTagDeletes } = reconcileLocationTags(
    local,
    remote,
    offset,
    finalLocationIds,
    finalTagIds,
    tagRekeys,
  );
  // Issue #81: item-to-region placements. Filtered to the regions that survive the merge for
  // the same FK-safety reason as the tag joins above — a placement in a region whose photo
  // was deleted elsewhere must not be re-inserted.
  const finalRegionIds = survivingIds('location_regions', local, localUpserts, localDeletes);
  const { itemRegionUpserts, itemRegionDeletes } = reconcileItemRegions(
    local,
    remote,
    offset,
    finalItemIds,
    finalRegionIds,
  );

  return {
    localUpserts,
    localDeletes,
    gaugeResolutions,
    reparented,
    rejectedCycles,
    serialisedLoansClosed,
    collisions,
    flagRepairs,
    historyInserts,
    itemTagUpserts,
    itemTagDeletes,
    locationTagUpserts,
    locationTagDeletes,
    itemRegionUpserts,
    itemRegionDeletes,
    conflicts,
  };
}

/**
 * Per-table LWW + tombstone resolution (§7.3). For every synced table, diff the local
 * and remote snapshots id-by-id: a remote tombstone deletes the local row unless a
 * strictly-newer local row resurrects it; otherwise the newer of two concurrent rows
 * wins (remote rows are sanitised against the schema dictionary before download), and a
 * row new on the remote is downloaded unless our own (offset-adjusted) tombstone is at
 * least as new. Local-only rows are left for the push half. Returns the initial upsert
 * and delete lists, which later phases mutate in place.
 */
function resolveTableMerges(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  dictionary: SchemaDictionary,
  offset: number,
  conflictSince: number | undefined,
  now: number,
): { localUpserts: TableRow[]; localDeletes: Tombstone[]; conflicts: SyncConflict[] } {
  const localUpserts: TableRow[] = [];
  const localDeletes: Tombstone[] = [];
  const conflicts: SyncConflict[] = [];
  // Detection is off until the device has a prior successful sync to reason from (§7.3 / #72).
  const detecting = conflictSince !== undefined && conflictSince > 0;

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
      // A local edit made *after* the last sync that now loses is a genuine collision (#72).
      const localEditedSinceSync = detecting && lUpd !== undefined && lUpd > conflictSince!;

      // Remote deleted this row.
      if (rTomb !== undefined) {
        // Local has a strictly-newer row → resurrect (keep local, drop tombstone).
        if (lUpd !== undefined && lUpd > rTomb) continue;
        // Otherwise the remote tombstone wins: delete locally + record it.
        if (l !== undefined) {
          localDeletes.push({ tableName: table, id, deletedAt: rTomb });
          // Our newer-than-last-sync edit lost to a remote deletion — surface it (#72).
          if (localEditedSinceSync) conflicts.push(buildConflict(table, l, null, now));
        }
        continue;
      }

      if (l && r) {
        if (resolveLww(lUpd!, rUpd!) === 'REMOTE_WINS') {
          const winner = sanitiseRow(r, allowed);
          // Issue #161: a tie resolves REMOTE_WINS, but if the winning row is byte-identical to
          // what is already stored the upsert would change nothing except re-fire the auto-stamp
          // trigger — making this device look "newer" and pushing the unchanged row back into an
          // indefinite cross-device loop. Skip the no-op upsert so a tie is genuinely idempotent.
          if (upsertWouldNoOp(l, winner)) continue;
          localUpserts.push({ table, row: winner });
          // A concurrent remote edit won over our newer-than-last-sync local edit (#72). Only
          // when the winning content actually differs — an identical value is not a lost edit.
          if (localEditedSinceSync && rowsDiffer(l, winner, table)) {
            conflicts.push(buildConflict(table, l, winner, now));
          }
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

  return { localUpserts, localDeletes, conflicts };
}

/**
 * §7.5.2 orphan re-parenting. Computes the set of items that will exist locally after the
 * merge (untouched local items minus deletes, plus upserts) and re-homes any whose target
 * location did not survive, mutating `localUpserts` in place. Returns the re-parent log
 * alongside the `finalItems` map and surviving-location set that later phases reuse.
 *
 * Note: `finalItems` retains the pre-fix row references — downstream consumers read only
 * its keys and the gauge columns, never `location_id`, so the re-parent fix lives solely
 * on the corresponding upsert.
 */
function reparentOrphans(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
): { reparented: ReparentLog[]; finalItems: Map<string, SqlRow>; activeLocationIds: Set<string> } {
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

  return { reparented, finalItems, activeLocationIds };
}

/**
 * Issue #193: a SERIALISED item is a single physical instance, so it can have **at most one open
 * checkout**. `CheckoutRepository.checkout`'s pre-flight probe enforces that on one device, but
 * two offline devices can each pass it and INSERT a checkout with its own UUID; the id-keyed LWW
 * union then keeps both, leaving the instance on loan to two borrowers at once. This pass
 * collapses that: for every serialised item left with more than one open loan after the merge, it
 * keeps exactly one and closes the rest, mutating `localUpserts` in place.
 *
 * The survivor is the loan **checked out first** (smallest `checked_out_at`, ties broken by the
 * lexicographically smaller id) — the unit physically left with that borrower, so a later "loan"
 * of the same instance could not really have happened. Both devices run this same pure rule over
 * the same rows and pick the same survivor without reference to which side is local; `checked_out_at`
 * is safe to compare because `shiftSnapshotTimestamps` shifts only `updated_at`, never it, so it is
 * byte-identical on every device (the determinism `unique-keys.ts` relies on for the same reason).
 *
 * A loser is **closed, not deleted**: stamping `returned_at` keeps the loan in the item's history
 * (an honest record that the instance was double-booked) and makes the derived on-loan status
 * correct, so returning the survivor now clears the item — the symptom the issue describes. The
 * stamp is deterministic: `returned_at` = the loser's own `checked_out_at` (a zero-duration loan,
 * which satisfies the `returned_at >= checked_out_at` CHECK) and `updated_at` bumped by 1. That
 * bump is frame-invariant under the linear push-shift, so both devices converge on the identical
 * pushed row with no last-write-wins churn, and — being strictly greater than the old value — it
 * also skips the `updated_at` self-stamp trigger so the deterministic value survives. Serialised
 * loans never move stock (they are pinned to quantity 1), so closing one needs no stock restore.
 */
function resolveSerialisedLoanConflicts(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
): SerialisedLoanClosure[] {
  // Tracking mode of every item that will exist after the merge (upserts override local rows).
  const trackingMode = new Map<string, string>();
  for (const row of local.tables.items ?? []) trackingMode.set(String(row.id), String(row.tracking_mode));
  for (const u of localUpserts) {
    if (u.table === 'items') trackingMode.set(String(u.row.id), String(u.row.tracking_mode));
  }

  // The checkout rows that survive the merge: local rows overlaid with winning upserts, minus deletes.
  const finalCheckouts = new Map<string, SqlRow>();
  for (const row of local.tables.checkouts ?? []) finalCheckouts.set(String(row.id), row);
  for (const u of localUpserts) if (u.table === 'checkouts') finalCheckouts.set(String(u.row.id), u.row);
  for (const d of localDeletes) if (d.tableName === 'checkouts') finalCheckouts.delete(d.id);

  // Group the still-open loans of each serialised item.
  const openByItem = new Map<string, SqlRow[]>();
  for (const row of finalCheckouts.values()) {
    if (row.returned_at !== null && row.returned_at !== undefined) continue; // already returned
    const itemId = String(row.item_id);
    if (trackingMode.get(itemId) !== 'SERIALISED') continue;
    const list = openByItem.get(itemId) ?? [];
    list.push(row);
    openByItem.set(itemId, list);
  }

  const upsertIndex = new Map<string, number>();
  localUpserts.forEach((u, i) => {
    if (u.table === 'checkouts') upsertIndex.set(String(u.row.id), i);
  });

  const closures: SerialisedLoanClosure[] = [];
  for (const [itemId, open] of openByItem) {
    if (open.length < 2) continue; // the ordinary case — nothing to collapse
    const winner = open.reduce(earlierLoan);
    for (const loser of open) {
      if (loser === winner) continue;
      const loserId = String(loser.id);
      // Zero-duration return + a deterministic +1 bump (see the doc comment): both devices
      // produce the byte-identical closed row after the push-shift, so it converges churn-free.
      const closed: SqlRow = {
        ...loser,
        returned_at: num(loser.checked_out_at),
        updated_at: num(loser.updated_at) + 1,
      };
      const existing = upsertIndex.get(loserId);
      if (existing !== undefined) localUpserts[existing] = { table: 'checkouts', row: closed };
      else localUpserts.push({ table: 'checkouts', row: closed });
      closures.push({ itemId, closedCheckoutId: loserId, keptCheckoutId: String(winner.id) });
    }
  }
  return closures;
}

/** The loan checked out first (smaller `checked_out_at`, id-tiebroken) — the merge survivor. */
function earlierLoan(a: SqlRow, b: SqlRow): SqlRow {
  const ca = num(a.checked_out_at);
  const cb = num(b.checked_out_at);
  if (ca !== cb) return ca < cb ? a : b;
  return String(a.id) < String(b.id) ? a : b;
}

/**
 * §7.5 relational integrity: compute the parents that will not survive the merge, so an
 * upsert that references a *known and removed* parent can be dropped (or null-cleared).
 *
 * A hard delete cascades its children locally but records only the *parent* tombstone
 * (§7.2), so a peer still holds the orphaned child rows. Without this guard the deleting
 * device would re-download them on its next sync and the atomic apply would trip a foreign
 * key. (`enforceForeignKeys` consumes the result: it nulls a *nullable* FK instead of
 * dropping the row, mirroring the schema's ON DELETE SET NULL, e.g. a BOM line whose item
 * was removed.)
 */
function computeRemovedParents(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
  finalItemIds: ReadonlySet<string>,
  activeLocationIds: ReadonlySet<string>,
): Partial<Record<SyncTable, Set<string>>> {
  const removedCategories = removedIds(
    'categories',
    local,
    remote,
    survivingIds('categories', local, localUpserts, localDeletes),
  );
  return {
    items: removedIds('items', local, remote, finalItemIds),
    // A placement at a removed location must not be resurrected — its location's RESTRICT
    // FK would reject it (Phase 25). The active set already drives the §7.5.2 item re-parent.
    locations: removedIds('locations', local, remote, activeLocationIds),
    categories: removedCategories,
    contacts: removedIds(
      'contacts',
      local,
      remote,
      survivingIds('contacts', local, localUpserts, localDeletes),
    ),
    projects: removedIds(
      'projects',
      local,
      remote,
      survivingIds('projects', local, localUpserts, localDeletes),
    ),
    // The global custom-field dictionary (issue #97). Every field-value table now hangs off
    // a *definition* rather than off a category's use of one, so the definitions are the
    // parent to guard: a value row referencing a deleted definition would trip its FK.
    // Definitions are a top-level dictionary deleted only explicitly (never by cascade), so
    // the surviving set is the plain local-rows − deletes + upserts, with no
    // cascade-of-cascade to fold in.
    field_defs: removedIds(
      'field_defs',
      local,
      remote,
      survivingIds('field_defs', local, localUpserts, localDeletes),
    ),
    // Phase 62: a removed supplier-part NULLs a PO line's nullable supplier_part_id, and a
    // removed PO drops its lines (CASCADE). Both parents are plain LWW tables, so their
    // surviving set is local rows − deletes + upserts.
    // Issue #384: the canonical supplier list. Its two children take deliberately different
    // routes in FK_REFS below — a supplier part cannot outlive its supplier (CASCADE), while a
    // purchase order keeps its row and merely loses the link (SET NULL), because an order is a
    // record of money spent and must survive the other device tidying its supplier list.
    suppliers: removedIds(
      'suppliers',
      local,
      remote,
      survivingIds('suppliers', local, localUpserts, localDeletes),
    ),
    supplier_parts: removedIds(
      'supplier_parts',
      local,
      remote,
      survivingIds('supplier_parts', local, localUpserts, localDeletes),
    ),
    purchase_orders: removedIds(
      'purchase_orders',
      local,
      remote,
      survivingIds('purchase_orders', local, localUpserts, localDeletes),
    ),
    // Principals (issue #79). A removed role NULLs its users' `role_id`; a removed user is
    // guarded by `reconcileHistory`, which re-attributes their inbound ledger rows to System
    // rather than dropping them. Both are plain LWW dictionaries, so the surviving set is the
    // usual local rows − deletes + upserts.
    roles: removedIds('roles', local, remote, survivingIds('roles', local, localUpserts, localDeletes)),
    users: removedIds('users', local, remote, survivingIds('users', local, localUpserts, localDeletes)),
  };
}

/**
 * Ids of `table` that are **known** (present in either snapshot) but will not survive
 * the merge — i.e. genuinely removed parents. An id absent from both snapshots is *not*
 * "removed" (the snapshot just doesn't carry it), so its children are left untouched.
 */
function removedIds(
  table: SyncTable,
  local: SyncSnapshot,
  remote: SyncSnapshot,
  surviving: ReadonlySet<string>,
): Set<string> {
  const removed = new Set<string>();
  for (const r of local.tables[table] ?? []) {
    const id = String(r.id);
    if (!surviving.has(id)) removed.add(id);
  }
  for (const r of remote.tables[table] ?? []) {
    const id = String(r.id);
    if (!surviving.has(id)) removed.add(id);
  }
  return removed;
}

/**
 * Drop (or null) any upsert whose parent was removed in the merge, mutating
 * `localUpserts` in place. A NOT-NULL orphan is removed; a nullable orphan keeps the row
 * with the FK column cleared.
 */
function enforceForeignKeys(
  localUpserts: TableRow[],
  removedParents: Partial<Record<SyncTable, Set<string>>>,
): void {
  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    const refs = FK_REFS[u.table];
    if (!refs) continue;
    let row = u.row;
    let drop = false;
    for (const { col, parent, nullable } of refs) {
      const value = row[col];
      if (value === null || value === undefined) continue;
      const removed = removedParents[parent];
      if (!removed || !removed.has(String(value))) continue; // parent intact (or unknown)
      if (nullable) {
        row = { ...row, [col]: null };
      } else {
        drop = true;
        break;
      }
    }
    if (drop) localUpserts.splice(i, 1);
    else if (row !== u.row) localUpserts[i] = { table: u.table, row };
  }
}

/** A row that will carry a flag after the merge — either a surviving local row or a pending upsert. */
interface FlagCandidate extends FlagRanked {
  /** Index into `localUpserts` when this candidate is a pending upsert rather than a stored row. */
  readonly upsertIndex?: number;
}

/**
 * Reduce every `supplier_parts` one-of-N flag to a single winner per item (issues #157, #192).
 *
 * Per-row LWW converges two devices that each pinned a *different* supplier part to two rows with
 * the same flag set — a state the app's demote-then-set never produces locally, and which the
 * schema's partial unique index now forbids. Left alone the merge would either draft a
 * double-order (#157) or refresh the wrong supplier's cost (#192), and the apply would trip the
 * index. This picks one deterministic winner per (item, flag) — {@link flagWinner}: newest
 * `updated_at`, ties broken by the smaller id so **both** devices reach the same verdict without
 * reference to which side is "local" — and clears the flag everywhere else:
 *
 *  - a losing *upsert* row has its flag zeroed in place, so its own write no longer re-sets it;
 *  - losing *stored* rows are cleared by the {@link FlagRepair} the caller hands `applyPlan`, which
 *    runs a demoting UPDATE ahead of the upserts (freeing the index before the winner's write).
 *
 * The winner keeps `updated_at`; the demotions re-stamp via the §7.1 trigger, so a genuine
 * de-selection propagates by LWW and the repair reaches a fixpoint once a single row is flagged.
 */
function repairSupplierPartFlags(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
  offset: number,
): FlagRepair[] {
  const table: SyncTable = 'supplier_parts';
  const deletedParts = new Set<string>();
  const deletedItems = new Set<string>();
  for (const d of localDeletes) {
    if (d.tableName === table) deletedParts.add(d.id);
    else if (d.tableName === 'items') deletedItems.add(d.id);
  }

  // The rows that will exist after the merge: stored rows overlaid by upserts, minus deletes.
  // A stored row's timestamp is offset-adjusted (the frame the upserts already sit in); an
  // upsert's is taken as-is. This is the same footing `resolveUniqueKeyCollisions` compares on.
  interface FinalRow {
    readonly itemId: string;
    readonly updatedAt: number;
    readonly row: SqlRow;
    readonly upsertIndex?: number;
  }
  const finalById = new Map<string, FinalRow>();
  for (const row of local.tables[table] ?? []) {
    const id = String(row.id);
    if (deletedParts.has(id)) continue;
    finalById.set(id, {
      itemId: String(row.item_id),
      updatedAt: applyOffset(num(row.updated_at), offset),
      row,
    });
  }
  localUpserts.forEach((u, i) => {
    if (u.table !== table) return;
    const id = String(u.row.id);
    if (deletedParts.has(id)) return;
    finalById.set(id, {
      itemId: String(u.row.item_id),
      updatedAt: num(u.row.updated_at),
      row: u.row,
      upsertIndex: i,
    });
  });

  const repairs: FlagRepair[] = [];
  for (const column of SUPPLIER_PART_FLAG_COLUMNS) {
    // Stored rows that physically hold the flag right now. A DELETE the merge is applying is
    // ordered AFTER the upserts, so a to-be-deleted flagged row still occupies the index the
    // instant the winner's write runs — it must be demoted exactly like a surviving loser.
    const storedFlaggedByItem = new Map<string, string[]>();
    for (const row of local.tables[table] ?? []) {
      if (num(row[column]) !== 1) continue;
      const item = String(row.item_id);
      const ids = storedFlaggedByItem.get(item);
      if (ids) ids.push(String(row.id));
      else storedFlaggedByItem.set(item, [String(row.id)]);
    }

    // Surviving rows that will carry the flag after the merge — the winner is chosen among these,
    // never a row the merge is deleting.
    const flaggedByItem = new Map<string, FlagCandidate[]>();
    for (const [id, entry] of finalById) {
      if (deletedItems.has(entry.itemId)) continue; // the item is going, its parts cascade away
      if (num(entry.row[column]) !== 1) continue;
      const list = flaggedByItem.get(entry.itemId);
      const candidate: FlagCandidate = { id, updatedAt: entry.updatedAt, upsertIndex: entry.upsertIndex };
      if (list) list.push(candidate);
      else flaggedByItem.set(entry.itemId, [candidate]);
    }

    for (const [itemId, flagged] of flaggedByItem) {
      let winner = flagged[0]!;
      for (const c of flagged) winner = flagWinner(winner, c);
      // Zero every losing *upsert* in place so its own write no longer competes for the key.
      for (const c of flagged) {
        if (c.id === winner.id || c.upsertIndex === undefined) continue;
        const u = localUpserts[c.upsertIndex]!;
        localUpserts[c.upsertIndex] = { table, row: { ...u.row, [column]: 0 } };
      }
      // A demoting UPDATE is needed only when a *stored* DB row other than the winner still holds
      // the flag: a surviving stored loser, or one being deleted this merge (see above). A losing
      // upsert of a brand-new row needs none — it simply inserts already zeroed.
      const stored = storedFlaggedByItem.get(itemId);
      if (stored?.some((id) => id !== winner.id)) {
        repairs.push({ table, itemId, column, winnerId: winner.id });
      }
    }
  }
  return repairs;
}

/** Ids of a (LWW) table that survive the merge: local rows − deletes + upserts. */
function survivingIds(
  table: SyncTable,
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
): Set<string> {
  const ids = new Set<string>();
  for (const row of local.tables[table] ?? []) ids.add(String(row.id));
  for (const u of localUpserts) if (u.table === table) ids.add(String(u.row.id));
  for (const d of localDeletes) if (d.tableName === table) ids.delete(d.id);
  return ids;
}

/**
 * Append-only Activity Ledger reconciliation (§7.3, Phase 11). The ledger is immutable,
 * so the same event has the same UUID everywhere: simply INSERT any remote row missing
 * locally (**union-by-id**, never LWW). Two guards: a row older than the §7.6.3-A prune
 * watermark is skipped (the device deliberately reclaimed that space), and a row whose
 * `item_id` will not survive the merge is skipped (its FK parent is gone — it would
 * cascade away anyway).
 */
function reconcileHistory(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  allowedCols: readonly string[] | undefined,
  prunedBefore: number,
  finalItemIds: ReadonlySet<string>,
  finalUserIds: ReadonlySet<string>,
  userRekeys: ReadonlyMap<string, string>,
): SqlRow[] {
  const localIds = new Set((local.itemHistory ?? []).map((r) => String(r.id)));
  const inserts: SqlRow[] = [];
  for (const r of remote.itemHistory ?? []) {
    if (localIds.has(String(r.id))) continue;
    if (num(r.created_at) < prunedBefore) continue;
    if (!finalItemIds.has(String(r.item_id))) continue;
    const row = allowedCols ? sanitiseRow(r, allowedCols) : r;
    inserts.push(resolveActor(row, finalUserIds, userRekeys));
  }
  return inserts;
}

/**
 * Resolve an inbound ledger row's `actor_user_id` against the post-merge user set (issue #79).
 *
 * `item_history` is not a `SyncTable`, so neither `FK_REFS` nor `UNIQUE_KEY_SPECS.references`
 * can reach it — this is the same structural gap the `tags` M:N joins have, and it is closed
 * the same way, by applying the resolved re-key map here by hand.
 *
 * Two repairs, in order: a row whose author lost a `users.username` collision follows the
 * winning id, and a row whose author will not exist locally at all is re-attributed to System.
 * The fallback is deliberate — dropping the row instead would silently discard an immutable
 * ledger entry (losing *what* happened) to avoid losing *who* did it, which is the worse
 * trade. A row that arrives without the column at all keeps that shape and picks up the
 * column's `DEFAULT` (System) on insert.
 */
function resolveActor(
  row: SqlRow,
  finalUserIds: ReadonlySet<string>,
  userRekeys: ReadonlyMap<string, string>,
): SqlRow {
  const actor = row.actor_user_id;
  if (actor === null || actor === undefined) return row;
  const rekeyed = userRekeys.get(String(actor)) ?? String(actor);
  if (finalUserIds.has(rekeyed)) {
    return rekeyed === String(actor) ? row : { ...row, actor_user_id: rekeyed };
  }
  return { ...row, actor_user_id: SYSTEM_USER_ID };
}

/**
 * Generic M:N membership reconciliation — a **tombstone-wins union** (2P-set) shared by
 * `item_tags` (Phase 11) and `location_tags` (issue #84). Neither join has a per-row
 * timestamp, so neither can resolve by LWW. An edge is present after the merge iff either
 * side still holds it AND neither side carries a deletion tombstone for it. A surviving
 * edge missing locally is added (only when `survives` confirms both endpoints outlive the
 * merge, keeping the atomic apply FK-safe); an edge present locally but tombstoned by the
 * peer is deleted and the (newest) tombstone adopted. A re-link is only possible once the
 * edge tombstone is TTL-pruned.
 */
function reconcileEdgeMembership<E>(
  localEdges: readonly E[] | undefined,
  remoteEdges: readonly E[] | undefined,
  localTomb: Map<string, number>,
  remoteTomb: Map<string, number>,
  edgeId: (edge: E) => string,
  survives: (edge: E) => boolean,
  /**
   * Edge ids that exist locally only under a *retired* endpoint id (issue #187). The stored
   * row still points at the loser, so the collision DELETE cascades it away: such an edge
   * counts as present for the union, but must still be re-inserted against the winner.
   */
  reinsertKeys: ReadonlySet<string> = new Set(),
): { upserts: E[]; deletes: (E & { deletedAt: number })[] } {
  const localMap = new Map<string, E>();
  for (const e of localEdges ?? []) localMap.set(edgeId(e), e);
  const remoteMap = new Map<string, E>();
  for (const e of remoteEdges ?? []) remoteMap.set(edgeId(e), e);

  const keys = new Set<string>([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...localTomb.keys(),
    ...remoteTomb.keys(),
  ]);

  const upserts: E[] = [];
  const deletes: (E & { deletedAt: number })[] = [];

  for (const key of keys) {
    const edge = localMap.get(key) ?? remoteMap.get(key)!;
    const lt = localTomb.get(key);
    const rt = remoteTomb.get(key);
    const tombstoned = lt !== undefined || rt !== undefined;
    const present = (localMap.has(key) || remoteMap.has(key)) && !tombstoned;
    const localHas = localMap.has(key);

    if (present && (!localHas || reinsertKeys.has(key))) {
      // Add the edge locally — only if both endpoints survive the merge (FK-safe).
      if (survives(edge)) upserts.push(edge);
    } else if (!present && localHas) {
      // Peer removed it (we hold no tombstone, since localHas implies none) → delete +
      // adopt the winning tombstone instant.
      deletes.push({ ...edge, deletedAt: Math.max(lt ?? 0, rt ?? 0) });
    }
  }
  return { upserts, deletes };
}

/**
 * M:N `item_tags` membership reconciliation (§7.3, Phase 11).
 *
 * `tagRekeys` maps tag ids retired by §7.5 natural-key resolution (issue #187) onto the id
 * that kept the name. Edges are mapped *before* the union, so both devices' links to their
 * own "Bolts" row become the same edge and merge into one membership rather than colliding —
 * this is what makes a re-key preserve associations instead of losing one side's.
 */
function reconcileItemTags(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  offset: number,
  finalItemIds: ReadonlySet<string>,
  finalTagIds: ReadonlySet<string>,
  tagRekeys: ReadonlyMap<string, string>,
): { itemTagUpserts: ItemTagEdge[]; itemTagDeletes: ItemTagEdgeDelete[] } {
  const map = (e: ItemTagEdge): ItemTagEdge => ({ ...e, tagId: tagRekeys.get(e.tagId) ?? e.tagId });
  const mapKey = (id: string) => {
    const { itemId, tagId } = parseItemTagEdgeId(id);
    return itemTagEdgeId(itemId, tagRekeys.get(tagId) ?? tagId);
  };
  const { upserts, deletes } = reconcileEdgeMembership<ItemTagEdge>(
    local.itemTags?.map(map),
    remote.itemTags?.map(map),
    rekeyEdgeTombstones(edgeTombstones(local.tombstones, ITEM_TAGS_TABLE, offset), tagRekeys, mapKey),
    rekeyEdgeTombstones(edgeTombstones(remote.tombstones, ITEM_TAGS_TABLE, 0), tagRekeys, mapKey),
    (e) => itemTagEdgeId(e.itemId, e.tagId),
    (e) => finalItemIds.has(e.itemId) && finalTagIds.has(e.tagId),
    rekeyedEdgeKeys(local.itemTags, tagRekeys, (e) => itemTagEdgeId(e.itemId, e.tagId)),
  );
  return { itemTagUpserts: upserts, itemTagDeletes: deletes };
}

/**
 * The post-re-key ids of local edges that pointed at a retired tag (issue #187) — the edges
 * the collision DELETE will cascade away, so the merge must re-insert them against the
 * winner even though the union already counts them as present.
 */
function rekeyedEdgeKeys<E extends { tagId: string }>(
  localEdges: readonly E[] | undefined,
  tagRekeys: ReadonlyMap<string, string>,
  edgeId: (edge: E) => string,
): ReadonlySet<string> {
  const keys = new Set<string>();
  if (tagRekeys.size === 0) return keys;
  for (const e of localEdges ?? []) {
    const winner = tagRekeys.get(e.tagId);
    if (winner !== undefined) keys.add(edgeId({ ...e, tagId: winner }));
  }
  return keys;
}

/**
 * Re-key an edge-tombstone map through a tag re-key (issue #187). A no-op — returning the
 * map untouched — when nothing was retired, which is every ordinary sync. Where two keys
 * collapse onto one, the newest deletion instant wins, matching the 2P-set's tombstone rule.
 */
function rekeyEdgeTombstones(
  tombstones: Map<string, number>,
  tagRekeys: ReadonlyMap<string, string>,
  mapKey: (id: string) => string,
): Map<string, number> {
  if (tagRekeys.size === 0) return tombstones;
  const mapped = new Map<string, number>();
  for (const [id, deletedAt] of tombstones) {
    const key = mapKey(id);
    mapped.set(key, Math.max(mapped.get(key) ?? 0, deletedAt));
  }
  return mapped;
}

/** M:N `location_tags` membership reconciliation (issue #84 — the location counterpart). */
function reconcileLocationTags(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  offset: number,
  finalLocationIds: ReadonlySet<string>,
  finalTagIds: ReadonlySet<string>,
  tagRekeys: ReadonlyMap<string, string>,
): { locationTagUpserts: LocationTagEdge[]; locationTagDeletes: LocationTagEdgeDelete[] } {
  const map = (e: LocationTagEdge): LocationTagEdge => ({
    ...e,
    tagId: tagRekeys.get(e.tagId) ?? e.tagId,
  });
  const mapKey = (id: string) => {
    const { locationId, tagId } = parseLocationTagEdgeId(id);
    return locationTagEdgeId(locationId, tagRekeys.get(tagId) ?? tagId);
  };
  const { upserts, deletes } = reconcileEdgeMembership<LocationTagEdge>(
    local.locationTags?.map(map),
    remote.locationTags?.map(map),
    rekeyEdgeTombstones(edgeTombstones(local.tombstones, LOCATION_TAGS_TABLE, offset), tagRekeys, mapKey),
    rekeyEdgeTombstones(edgeTombstones(remote.tombstones, LOCATION_TAGS_TABLE, 0), tagRekeys, mapKey),
    (e) => locationTagEdgeId(e.locationId, e.tagId),
    (e) => finalLocationIds.has(e.locationId) && finalTagIds.has(e.tagId),
    rekeyedEdgeKeys(local.locationTags, tagRekeys, (e) => locationTagEdgeId(e.locationId, e.tagId)),
  );
  return { locationTagUpserts: upserts, locationTagDeletes: deletes };
}

/**
 * M:N `item_regions` membership reconciliation (issue #81 — items placed in a region drawn
 * on a location photo).
 *
 * Simpler than the tag joins: regions carry no name-collision rekeying, because a region is
 * identified by its UUID and two devices naming a region "Top shelf" are describing two
 * genuinely different places on two different photos. So there is no rekey map to thread
 * through, and the edge key is the raw pair.
 */
function reconcileItemRegions(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  offset: number,
  finalItemIds: ReadonlySet<string>,
  finalRegionIds: ReadonlySet<string>,
): { itemRegionUpserts: ItemRegionEdge[]; itemRegionDeletes: ItemRegionEdgeDelete[] } {
  const { upserts, deletes } = reconcileEdgeMembership<ItemRegionEdge>(
    local.itemRegions,
    remote.itemRegions,
    edgeTombstones(local.tombstones, ITEM_REGIONS_TABLE, offset),
    edgeTombstones(remote.tombstones, ITEM_REGIONS_TABLE, 0),
    (e) => itemRegionEdgeId(e.itemId, e.regionId),
    (e) => finalItemIds.has(e.itemId) && finalRegionIds.has(e.regionId),
    new Set((local.itemRegions ?? []).map((e) => itemRegionEdgeId(e.itemId, e.regionId))),
  );
  return { itemRegionUpserts: upserts, itemRegionDeletes: deletes };
}

/** Edge tombstones for one edge table (key → offset-adjusted deletedAt). */
function edgeTombstones(
  tombstones: readonly Tombstone[],
  tableName: string,
  offset: number,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tombstones) {
    if (t.tableName === tableName) map.set(t.id, t.deletedAt + offset);
  }
  return map;
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
