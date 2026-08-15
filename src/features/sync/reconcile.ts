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
import { UNASSIGNED_LOCATION_ID, type HistoryAction } from '@/db/repositories/constants';
import {
  SYNC_TABLES,
  ITEM_HISTORY_TABLE,
  STOCK_DELTAS_TABLE,
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
import { resolveBookingConflicts, type BookingWindow } from '@/features/bookings/booking-overlap';
import { applyOffset } from './clock';
import { buildConflict, detectsConflicts, nonLwwColumns } from './conflict-detect';
import { reconcileGauge, reconcileStockQuantity, replayGaugeValue, replayStockQuantity } from './delta-crdt';
import { FK_REFS } from './fk-refs';
import { resolveLww } from './lww';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import { SUPPLIER_PART_FLAG_COLUMNS, flagWinner, type FlagRanked } from './supplier-part-flags';
import { resolveUniqueKeyCollisions } from './unique-keys';
import type {
  BookingOverlapCancellation,
  FlagRepair,
  GaugeHistoryDelta,
  GaugeResolution,
  HistoryClear,
  StockQuantityDelta,
  StockResolution,
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
  stockResolutions: [],
  reparented: [],
  rejectedCycles: [],
  serialisedLoansClosed: [],
  bookingsCancelled: [],
  collisions: [],
  flagRepairs: [],
  defaultLocationWinnerId: null,
  historyInserts: [],
  historyClears: [],
  stockDeltaInserts: [],
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

  // --- Issue #194 asset-booking double-booking ----------------------------------
  // Cancel the surplus of any asset the id-keyed union left booked more than once over the same
  // days. Runs alongside the serialised-loan pass and before the FK guard, so a cancellation of a
  // booking whose asset the merge removed is dropped with the rest of that asset's rows.
  const bookingsCancelled = resolveBookingOverlapConflicts(local, localUpserts, localDeletes);

  // --- §7.5.2 orphan re-parenting ------------------------------------------------
  const { reparented, finalItems, activeLocationIds } = reparentOrphans(local, localUpserts, localDeletes);

  // --- §7.5.3 cyclical-nesting rejection ----------------------------------------
  // Both self-referencing parent hierarchies — locations (§7.5.3) and item variant parents
  // (issue #190) — can be closed into a cycle by concurrent LWW writes that are each
  // locally valid. Reject whichever merge edge closes the loop, on both tables.
  const rejectedCycles = [
    ...rejectParentCycles(local, localUpserts, 'locations'),
    ...rejectParentCycles(local, localUpserts, 'items'),
  ];

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

  // --- Issue #191: "at most one default location" cross-row repair ---------------
  // The same shape as the supplier-part repair above, but for the *global* `locations.is_default`:
  // per-row LWW cannot enforce a single default, so two devices each nominating a different one
  // converge to two flagged rows; this keeps one deterministic winner across the whole table.
  const defaultLocationWinnerId = repairDefaultLocation(local, localUpserts, localDeletes, offset);

  // --- §7.3 Delta-CRDT gauge reconciliation -------------------------------------
  const gaugeResolutions = reconcileGauges(local, remote, finalItems);

  // --- Issue #188 Delta-CRDT discrete-stock reconciliation ----------------------
  const stockResolutions = reconcileStock(local, remote, finalItemIds);

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

  // Issue #620: the per-item ledger-clear marks, read from both sides' ledgers before the union
  // below, so a clear on either device removes the same era of entries on both.
  const clearMarks = historyClearMarks([local.itemHistory, remote.itemHistory]);
  const historyInserts = reconcileHistory(
    local,
    remote,
    options.dictionary[ITEM_HISTORY_TABLE],
    options.historyPrunedBefore ?? 0,
    finalItemIds,
    finalUserIds,
    userRekeys,
    clearMarks,
  );
  const historyClears = reconcileHistoryClears(local, clearMarks, finalItemIds);
  // Issue #188: the discrete-stock convergence ledger, unioned by id like the history ledger.
  const stockDeltaInserts = reconcileStockDeltas(
    local,
    remote,
    options.dictionary[STOCK_DELTAS_TABLE],
    finalItemIds,
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
    stockResolutions,
    reparented,
    rejectedCycles,
    serialisedLoansClosed,
    bookingsCancelled,
    collisions,
    flagRepairs,
    defaultLocationWinnerId,
    historyInserts,
    historyClears,
    stockDeltaInserts,
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
    // Some tables are resolved by LWW *as promised* rather than in spite of the user's intent, so a
    // losing row there is a settled outcome and not a lost edit to report (issue #72 / #382).
    const reportable = detecting && detectsConflicts(table);

    const ids = new Set<string>([...localRows.keys(), ...remoteRows.keys()]);

    for (const id of ids) {
      const l = localRows.get(id);
      const r = remoteRows.get(id);
      const lUpd = l ? applyOffset(num(l.updated_at), offset) : undefined;
      const rUpd = r ? num(r.updated_at) : undefined;
      const rTomb = remoteTomb.get(id);
      // A local edit made *after* the last sync that now loses is a genuine collision (#72).
      const localEditedSinceSync = reportable && lUpd !== undefined && lUpd > conflictSince!;

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
 * Issue #194: an asset booking holds one identifiable unit for a span of days, so two *active*
 * (non-cancelled, non-converted) bookings of the same asset whose whole-day ranges overlap are a
 * double-booking. `AssetBookingRepository.create` refuses an overlapping booking, but that is a
 * read-then-write check across sibling rows — it holds only within one device. Two offline devices
 * can each pass it and INSERT a booking with its own UUID; the id-keyed LWW union then keeps both,
 * so the calendar renders the same unit reserved twice over the same days with no signal that one
 * is illegitimate. This pass collapses that: for every asset left with overlapping active bookings
 * after the merge it keeps the earlier-reserved booking(s) and cancels the surplus, mutating
 * `localUpserts` in place.
 *
 * The survivor of any clash is the booking **reserved first** (smallest `created_at`, ties broken by
 * the lexicographically smaller id — see {@link resolveBookingConflicts}), so both devices run the
 * same pure rule over the same rows and pick the same survivors without reference to which side is
 * local. `created_at` is safe to compare because `shiftSnapshotTimestamps` never shifts it, so it is
 * byte-identical on every device (the determinism `resolveSerialisedLoanConflicts` relies on for the
 * same reason). Overlap is not transitive, so a booking is cancelled only when it clashes with a
 * *surviving earlier* one, never blindly reduced to a single winner per asset.
 *
 * A loser is **cancelled, not deleted**: stamping `cancelled_at` keeps the booking in the asset's
 * history (an honest record that it was double-booked), removes it from the active/overlap set so
 * the calendar stops rendering it, and — being derived — blocks any later `convertToCheckout`. The
 * stamp is deterministic: `cancelled_at` = the loser's own `created_at` (frame-stable, so identical
 * on every device) and `updated_at` bumped by 1. That bump is frame-invariant under the linear
 * push-shift, so both devices converge on the identical pushed row with no last-write-wins churn,
 * and — being strictly greater than the old value — it also skips the `updated_at` self-stamp
 * trigger so the deterministic value survives (the same reasoning as the serialised-loan closure).
 */
function resolveBookingOverlapConflicts(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
): BookingOverlapCancellation[] {
  // The booking rows that survive the merge: local rows overlaid with winning upserts, minus deletes.
  const finalBookings = new Map<string, SqlRow>();
  for (const row of local.tables.asset_bookings ?? []) finalBookings.set(String(row.id), row);
  for (const u of localUpserts) if (u.table === 'asset_bookings') finalBookings.set(String(u.row.id), u.row);
  for (const d of localDeletes) if (d.tableName === 'asset_bookings') finalBookings.delete(d.id);

  // Group the still-active (non-cancelled, non-converted) bookings of each asset.
  const activeByItem = new Map<string, BookingWindow[]>();
  const rowById = new Map<string, SqlRow>();
  for (const row of finalBookings.values()) {
    if (row.cancelled_at !== null && row.cancelled_at !== undefined) continue; // already cancelled
    if (row.converted_checkout_id !== null && row.converted_checkout_id !== undefined) continue; // checked out
    const itemId = String(row.item_id);
    const id = String(row.id);
    const window: BookingWindow = {
      id,
      start: num(row.start_date),
      end: num(row.end_date),
      createdAt: num(row.created_at),
    };
    const list = activeByItem.get(itemId) ?? [];
    list.push(window);
    activeByItem.set(itemId, list);
    rowById.set(id, row);
  }

  const upsertIndex = new Map<string, number>();
  localUpserts.forEach((u, i) => {
    if (u.table === 'asset_bookings') upsertIndex.set(String(u.row.id), i);
  });

  const cancellations: BookingOverlapCancellation[] = [];
  for (const [itemId, windows] of activeByItem) {
    if (windows.length < 2) continue; // a single booking cannot overlap anything
    const { cancelled } = resolveBookingConflicts(windows);
    for (const { id: loserId, clashesWith } of cancelled) {
      const loser = rowById.get(loserId)!;
      // Deterministic cancel + a +1 bump (see the doc comment): both devices produce the
      // byte-identical cancelled row after the push-shift, so it converges churn-free.
      const cancelledRow: SqlRow = {
        ...loser,
        cancelled_at: num(loser.created_at),
        updated_at: num(loser.updated_at) + 1,
      };
      const existing = upsertIndex.get(loserId);
      if (existing !== undefined) localUpserts[existing] = { table: 'asset_bookings', row: cancelledRow };
      else localUpserts.push({ table: 'asset_bookings', row: cancelledRow });
      cancellations.push({ itemId, cancelledBookingId: loserId, keptBookingId: clashesWith });
    }
  }
  return cancellations;
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

/**
 * Reduce the `locations` table to a single default after the merge (issue #191).
 *
 * The structural twin of {@link repairSupplierPartFlags}, but for the *global* `locations.is_default`:
 * it marks the one place "Add item" pre-selects, maintained locally by a demote-then-set so the
 * schema's partial unique index never trips on a single device. Per-row LWW cannot see that
 * demotion across a merge, though: two devices that each nominated a *different* default converge to
 * two flagged rows — a state the index now forbids. This picks one deterministic winner across the
 * whole table ({@link flagWinner}: newest `updated_at`, ties broken by the smaller id so **both**
 * devices reach the same verdict without reference to which side is "local") and clears the flag
 * everywhere else:
 *
 *  - a losing *upsert* row has its flag zeroed in place, so its own write no longer re-sets it;
 *  - losing *stored* rows are cleared by the returned winner id, which `applyPlan` uses to run a
 *    demoting UPDATE ahead of the upserts (freeing the index before the winner's write).
 *
 * Returns the winner id only when a *stored* DB row other than the winner still holds the flag —
 * a surviving loser, or one being deleted this merge (its DELETE is ordered after the upserts, so
 * it still occupies the index when the winner's write runs). Otherwise `null`: nothing carries the
 * flag among survivors, or the only offenders were losing upserts (already zeroed above).
 *
 * The winner keeps `updated_at`; the demotion re-stamps via the §7.1 trigger, so a genuine
 * de-selection propagates by LWW and the repair reaches a fixpoint once a single row is flagged.
 */
function repairDefaultLocation(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
  offset: number,
): string | null {
  const table: SyncTable = 'locations';
  const deleted = new Set<string>();
  for (const d of localDeletes) if (d.tableName === table) deleted.add(d.id);

  // Stored rows that physically hold the flag right now. A DELETE the merge is applying is ordered
  // AFTER the upserts, so a to-be-deleted flagged row still occupies the index the instant the
  // winner's write runs — it must be demoted exactly like a surviving loser.
  const storedFlagged: string[] = [];
  for (const row of local.tables[table] ?? []) {
    if (num(row.is_default) === 1) storedFlagged.push(String(row.id));
  }

  // The rows that will exist after the merge: stored rows overlaid by upserts, minus deletes. A
  // stored row's timestamp is offset-adjusted (the frame the upserts already sit in); an upsert's
  // is taken as-is — the same footing `resolveUniqueKeyCollisions` compares on.
  interface FinalRow {
    readonly updatedAt: number;
    readonly isDefault: boolean;
    readonly upsertIndex?: number;
  }
  const finalById = new Map<string, FinalRow>();
  for (const row of local.tables[table] ?? []) {
    const id = String(row.id);
    if (deleted.has(id)) continue;
    finalById.set(id, {
      updatedAt: applyOffset(num(row.updated_at), offset),
      isDefault: num(row.is_default) === 1,
    });
  }
  localUpserts.forEach((u, i) => {
    if (u.table !== table) return;
    const id = String(u.row.id);
    if (deleted.has(id)) return;
    finalById.set(id, {
      updatedAt: num(u.row.updated_at),
      isDefault: num(u.row.is_default) === 1,
      upsertIndex: i,
    });
  });

  // Surviving rows that will carry the flag after the merge — the winner is chosen among these,
  // never a row the merge is deleting.
  const flagged: FlagCandidate[] = [];
  for (const [id, entry] of finalById) {
    if (!entry.isDefault) continue;
    flagged.push({ id, updatedAt: entry.updatedAt, upsertIndex: entry.upsertIndex });
  }
  if (flagged.length === 0) return null;

  let winner = flagged[0]!;
  for (const c of flagged) winner = flagWinner(winner, c);

  // Zero every losing *upsert* in place so its own write no longer competes for the key.
  for (const c of flagged) {
    if (c.id === winner.id || c.upsertIndex === undefined) continue;
    const u = localUpserts[c.upsertIndex]!;
    localUpserts[c.upsertIndex] = { table, row: { ...u.row, is_default: 0 } };
  }

  // A demoting UPDATE is needed only when a *stored* DB row other than the winner still holds the
  // flag: a surviving stored loser, or one being deleted this merge (see above). A losing upsert of
  // a brand-new row needs none — it simply inserts already zeroed.
  return storedFlagged.some((id) => id !== winner.id) ? winner.id : null;
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
 * The action marking a deliberately cleared per-item ledger (issue #620) — see
 * {@link historyClearMarks} for what the engine does with it.
 *
 * Typed as a {@link HistoryAction} so it is checked against the ledger's vocabulary: renaming
 * or dropping the action would fail to compile here rather than silently leaving the engine
 * matching a string nothing writes any more.
 */
const HISTORY_CLEARED_ACTION: HistoryAction = 'HISTORY_CLEARED';

/**
 * The instant each item's Activity Log was last cleared, across **both** snapshots
 * (issue #620) — the per-item counterpart to the global §7.6.3-A prune watermark.
 *
 * Clearing an item's log deletes its entries and writes one `HISTORY_CLEARED` entry in
 * their place. That marker is an ordinary ledger row, so it unions across to every peer
 * like any other — and reading the newest one per item, from local and remote together,
 * gives both devices the same cut-off without either needing to know which side cleared:
 * entries older than it are neither imported ({@link reconcileHistory}) nor kept
 * ({@link reconcileHistoryClears}). Clear on one device, sync twice, and both agree.
 *
 * Earlier markers are themselves older than the newest one, so a log cleared twice
 * converges on the single most recent marker rather than accumulating one per clear.
 *
 * The comparison is on `created_at`, which `shiftSnapshotTimestamps` never shifts, so it
 * means the same instant on both sides. A device whose clock runs ahead therefore clears
 * slightly into a peer's future — the same clock-skew exposure the global prune watermark
 * has always carried, and the reason a clear is worded as "everything up to now".
 *
 * Takes the ledgers rather than the snapshots so the clone-and-salvage path can pass the
 * two halves it holds separately (see `cloneWithSalvage`).
 */
export function historyClearMarks(ledgers: readonly (readonly SqlRow[] | undefined)[]): Map<string, number> {
  const marks = new Map<string, number>();
  for (const rows of ledgers) {
    for (const r of rows ?? []) {
      if (r.action !== HISTORY_CLEARED_ACTION) continue;
      const itemId = String(r.item_id);
      const at = num(r.created_at);
      if (at > (marks.get(itemId) ?? 0)) marks.set(itemId, at);
    }
  }
  return marks;
}

/**
 * Append-only Activity Ledger reconciliation (§7.3, Phase 11). The ledger is immutable,
 * so the same event has the same UUID everywhere: simply INSERT any remote row missing
 * locally (**union-by-id**, never LWW). Three guards: a row older than the §7.6.3-A prune
 * watermark is skipped (the device deliberately reclaimed that space), a row whose
 * `item_id` will not survive the merge is skipped (its FK parent is gone — it would
 * cascade away anyway), and a row from before its item's newest clear mark is skipped
 * (issue #620 — importing it would undo the clear).
 */
function reconcileHistory(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  allowedCols: readonly string[] | undefined,
  prunedBefore: number,
  finalItemIds: ReadonlySet<string>,
  finalUserIds: ReadonlySet<string>,
  userRekeys: ReadonlyMap<string, string>,
  clearMarks: ReadonlyMap<string, number>,
): SqlRow[] {
  const localIds = new Set((local.itemHistory ?? []).map((r) => String(r.id)));
  const inserts: SqlRow[] = [];
  for (const r of remote.itemHistory ?? []) {
    if (localIds.has(String(r.id))) continue;
    if (num(r.created_at) < prunedBefore) continue;
    if (!finalItemIds.has(String(r.item_id))) continue;
    if (num(r.created_at) < (clearMarks.get(String(r.item_id)) ?? 0)) continue;
    const row = allowedCols ? sanitiseRow(r, allowedCols) : r;
    inserts.push(resolveActor(row, finalUserIds, userRekeys));
  }
  return inserts;
}

/**
 * The per-item ledger clears this device has to adopt (issue #620): an item whose newest
 * clear mark post-dates entries this device still holds.
 *
 * The mirror of {@link reconcileHistory}'s clear guard — that one refuses to *import* a
 * cleared entry, this one deletes one already stored, which is what makes a peer's clear
 * land here rather than only stopping the traffic in one direction. Only items with
 * something to delete are listed, so a merge between two devices that already agree emits
 * nothing. Items that will not survive the merge are skipped: their ledger cascades away
 * with them anyway.
 */
function reconcileHistoryClears(
  local: SyncSnapshot,
  clearMarks: ReadonlyMap<string, number>,
  finalItemIds: ReadonlySet<string>,
): HistoryClear[] {
  if (clearMarks.size === 0) return [];
  // One pass over the ledger rather than one per marked item: the ledger is the largest
  // section of the snapshot, and a device that has cleared many items would otherwise
  // re-scan all of it for each of them.
  const stale = new Set<string>();
  for (const r of local.itemHistory ?? []) {
    const itemId = String(r.item_id);
    if (stale.has(itemId) || !finalItemIds.has(itemId)) continue;
    if (num(r.created_at) < (clearMarks.get(itemId) ?? 0)) stale.add(itemId);
  }
  return [...stale].map((itemId) => ({ itemId, before: clearMarks.get(itemId)! }));
}

/**
 * The remote `stock_deltas` rows this device is missing (issue #188; union-by-id), to INSERT.
 *
 * A leaner sibling of {@link reconcileHistory}: the convergence ledger has no `actor_user_id`, so
 * there is no actor re-key to apply, and (in this first cut) no prune watermark. A delta is
 * imported when its id is new here and its `item_id` will survive the merge — a delta for an item
 * that will not exist locally would replay the CRDT against nothing, and its `item_id` is
 * ON DELETE CASCADE, so it could never be inserted anyway. `location_id` / `batch_key` are plain
 * columns, not synced FKs, so they need no survival guard.
 */
function reconcileStockDeltas(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  allowedCols: readonly string[] | undefined,
  finalItemIds: ReadonlySet<string>,
): SqlRow[] {
  const localIds = new Set((local.stockDeltas ?? []).map((r) => String(r.id)));
  const inserts: SqlRow[] = [];
  for (const r of remote.stockDeltas ?? []) {
    if (localIds.has(String(r.id))) continue;
    if (!finalItemIds.has(String(r.item_id))) continue;
    inserts.push(allowedCols ? sanitiseRow(r, allowedCols) : r);
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
 * Discard any upsert to a self-referencing `parent_id` hierarchy whose new parent would
 * close a nesting cycle against the merged tree, returning the rejected row ids. Mutates
 * `localUpserts` in place to drop the offending move (the local hierarchy stands).
 *
 * Two tables carry such a hierarchy: `locations` (§7.5.3) and `items` (variant parents,
 * issue #190). Per-row LWW cannot enforce acyclicity — two devices each make a locally
 * valid move (A: X→Y, B: Y→X) that only forms a loop once merged — so the merge must
 * reject whichever edge closes it. For items this is doubly important: the write-time
 * ancestor walk that guards variant links is recursive, so a persisted cycle would make
 * the next attach/detach on that chain hang the database worker.
 */
function rejectParentCycles(local: SyncSnapshot, localUpserts: TableRow[], table: SyncTable): string[] {
  const rejected: string[] = [];
  const localRows = local.tables[table] ?? [];
  // Build the merged parent map: local rows overlaid with the winning upserts.
  const parentOf = new Map<string, string | null>();
  for (const row of localRows) {
    parentOf.set(String(row.id), row.parent_id === null ? null : String(row.parent_id));
  }
  for (const u of localUpserts) {
    if (u.table === table) {
      parentOf.set(String(u.row.id), u.row.parent_id === null ? null : String(u.row.parent_id));
    }
  }

  for (let i = localUpserts.length - 1; i >= 0; i -= 1) {
    const u = localUpserts[i]!;
    if (u.table !== table) continue;
    const id = String(u.row.id);
    const newParent = u.row.parent_id === null ? null : String(u.row.parent_id);
    if (wouldCreateCycle(id, newParent, parentOf)) {
      rejected.push(id);
      // Restore the local parent edge and drop the upsert.
      const localRow = localRows.find((r) => String(r.id) === id);
      parentOf.set(id, localRow && localRow.parent_id !== null ? String(localRow.parent_id) : null);
      localUpserts.splice(i, 1);
    }
  }
  return rejected;
}

/**
 * Tolerance for the gauge ledger-completeness check below, **relative to the capacity**.
 *
 * A gauge's value and its deltas are REALs summed in floating point. Each individual delta is
 * recorded exactly, but a long running sum sitting near `−gross` accumulates error on the order
 * of `n × ulp(gross)` — so the drift scales with the *capacity*, not with the size of the
 * movements. A fixed absolute tolerance therefore holds for a 1 kg spool and fails for the same
 * spool expressed in milligrams. Scaling by the capacity keeps it a millionth of the gauge's own
 * span either way: far below any real measurement, and far above the rounding.
 */
const GAUGE_REPLAY_EPSILON = 1e-6;

/**
 * Whether one side's gauge ledger reconstructs the value that side actually stores — i.e. it
 * still holds every delta since the gauge was last at capacity, so replaying it loses no
 * baseline.
 *
 * A side whose ledger was **deliberately emptied** does not: the §7.6.3-A retention prune, the
 * Danger-Zone "activity history" erase and the per-item Activity Log clear (issue #620) all
 * delete `GAUGE_UPDATE` rows while leaving `current_net_value` untouched, so replaying what
 * remains reconstructs `gross + 0` — a half-empty bottle that reports itself full.
 *
 * Nor does a gauge that never had a complete ledger to begin with: one **created part-full**
 * (or cloned, which resets the value) has no opening delta to be its baseline, and one whose
 * **capacity was reconfigured** carries deltas measured against the old span. Those are not
 * emptied ledgers but they are equally baseline-less, and this check cannot tell them apart —
 * nor does it need to. All of them fall back to Last-Write-Wins, which is what the value on the
 * row already is; only a gauge whose whole history is present keeps the delta replay.
 */
function gaugeLedgerReconstructs(row: SqlRow, deltas: readonly GaugeHistoryDelta[]): boolean {
  const gross = num(row.gross_capacity);
  const stored = num(row.current_net_value);
  // A row missing either figure describes no gauge this can check — refuse rather than compare
  // against a coerced NULL, which would quietly read as "is the replay zero?".
  if (!Number.isFinite(gross) || !Number.isFinite(stored)) return false;
  return Math.abs(replayGaugeValue(gross, deltas) - stored) <= GAUGE_REPLAY_EPSILON * Math.max(1, gross);
}

/**
 * §7.3 Delta-CRDT: replay merged gauge deltas for items present on both sides.
 *
 * Two guards, matching {@link reconcileStock}'s (1) and (2) — they are the same rules, and the
 * gauge is the older half of the same idea:
 *
 *  1. **Contested** — only a gauge both devices hold can have diverged; a one-sided one keeps
 *     the LWW value the merge upsert already carried.
 *  2. **Ledger complete on both sides** — the deltas only reconstruct the value when every
 *     movement since the gauge was last at capacity is present. A *baseline-less* side (see
 *     {@link gaugeLedgerReconstructs} for how one comes about) would otherwise converge both
 *     devices on a figure the ledger cannot support — `gross + 0`, i.e. a full gauge — and then
 *     propagate it. Such a side falls back to LWW, which is never worse than the value the row
 *     already carries. Each side is checked against its **own** stored row, since the whole
 *     question is whether *that* device's ledger explains *that* device's value.
 */
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
    // (1) Only the concurrent case needs delta replay; a one-sided gauge keeps its LWW value.
    const localRow = localItems.get(id);
    const remoteRow = remoteItems.get(id);
    if (!localRow || !remoteRow) continue;
    const gross = num(row.gross_capacity);
    if (!Number.isFinite(gross)) continue;
    const localSide = localDeltas.get(id) ?? [];
    const remoteSide = remoteDeltas.get(id) ?? [];
    // (2) Each side against its own stored row — see the note on the function.
    if (!gaugeLedgerReconstructs(localRow, localSide)) continue;
    if (!gaugeLedgerReconstructs(remoteRow, remoteSide)) continue;
    const netValue = reconcileGauge(gross, localSide, remoteSide);
    resolutions.push({ itemId: id, netValue });
  }
  return resolutions;
}

/**
 * Issue #188 Delta-CRDT: replay the merged `stock_deltas` for every `(item, location, batch)`
 * placement **contested on both sides** whose ledger is complete on both, converging
 * `stock_batches.quantity` to `clamp₀(replay of the id-unioned deltas)` — movements accumulate,
 * and a cycle count's assertion restarts the total rather than adding to it (issue #633; see
 * {@link replayStockQuantity}).
 *
 * Deliberately conservative, mirroring {@link reconcileGauges}, with three guards that each make it
 * *safe* to override the Last-Write-Wins quantity:
 *
 *  1. **Contested** — a placement with deltas on only one side is left at its LWW value (the merge
 *     upsert already carried the newer side's quantity); only a placement both devices moved can
 *     have diverged. This also means the pass never sets a quantity from an empty sum.
 *  2. **Ledger complete on both sides** — the replay only reconstructs the quantity when every
 *     movement since the placement began is present. A snapshot whose ledger was dropped (a
 *     history-excluded backup) or never captured (a pre-#188 export) is *baseline-less*
 *     (its replay ≠ quantity); replaying it would lose the missing base (converging to a wrong,
 *     possibly floored-to-zero, value — worse than LWW). So a side is trusted only when its own S0
 *     capture invariant holds, `replay(deltas) == stock_batches.quantity`; otherwise the placement
 *     falls back to LWW, which is never worse than the pre-#188 behaviour. A cycle count *heals* a
 *     baseline-less placement rather than being blocked by it (issue #633): its assertion states
 *     the quantity outright, so the replay from that point reconstructs the row without needing
 *     the movements that went missing before it.
 *  3. **Remote brings something new** — skip when every remote delta is already held locally: the
 *     placements have not diverged, so re-`UPDATE`ing to the same value would only bump
 *     `updated_at` and re-push the row every sync (a fresh source of the
 *     `[[sync-redundant-resync-churn]]` ping-pong).
 */
function reconcileStock(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  finalItemIds: ReadonlySet<string>,
): StockResolution[] {
  const localByPlacement = byPlacement(local.stockDeltas ?? []);
  const remoteByPlacement = byPlacement(remote.stockDeltas ?? []);
  const localQuantities = placementQuantities(local.tables.stock_batches ?? []);
  const remoteQuantities = placementQuantities(remote.tables.stock_batches ?? []);
  const resolutions: StockResolution[] = [];
  for (const [placementId, localEntry] of localByPlacement) {
    const remoteEntry = remoteByPlacement.get(placementId);
    // (1) Only a placement both devices moved can have diverged; a one-sided one keeps its LWW value.
    if (!remoteEntry) continue;
    if (!finalItemIds.has(localEntry.key.itemId)) continue;
    // (2) Both ledgers must be complete — `replay(deltas) == quantity` — or the replay would lose
    // an uncaptured baseline. A baseline-less side falls back to LWW rather than to a wrong figure.
    if (replayStockQuantity(localEntry.deltas) !== localQuantities.get(placementId)) continue;
    if (replayStockQuantity(remoteEntry.deltas) !== remoteQuantities.get(placementId)) continue;
    // (3) Skip when the remote carries no movement this device lacks (no divergence → no churn).
    const localIds = new Set(localEntry.deltas.map((d) => d.id));
    if (remoteEntry.deltas.every((d) => localIds.has(d.id))) continue;
    const quantity = reconcileStockQuantity(localEntry.deltas, remoteEntry.deltas);
    resolutions.push({
      itemId: localEntry.key.itemId,
      locationId: localEntry.key.locationId,
      batchKey: localEntry.key.batchKey,
      quantity,
    });
  }
  return resolutions;
}

/** Map each `stock_batches` row to its placement id → quantity, for the ledger-completeness check. */
function placementQuantities(rows: readonly SqlRow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of rows) {
    // Same `\0`-joined placement id as {@link byPlacement}, so the two maps align by key.
    map.set(
      `${String(row.item_id)}\0${String(row.location_id)}\0${String(row.batch_key)}`,
      num(row.quantity),
    );
  }
  return map;
}

/** A `(item, location, batch)` placement key. */
interface PlacementKey {
  readonly itemId: string;
  readonly locationId: string;
  readonly batchKey: string;
}

/**
 * Group raw `stock_deltas` rows by their placement, keyed by a stable string id so the same
 * placement matches across two independently-built snapshots. Each entry projects its rows to the
 * {@link StockQuantityDelta} the pure {@link reconcileStockQuantity} replays.
 *
 * `asserted_quantity` is read as `null` unless it holds a finite number, so a snapshot from a peer
 * that predates issue #633 (the column absent, hence `undefined`) reads as the ordinary movement
 * it was recorded as, rather than as an assertion of `NaN`.
 */
function byPlacement(
  deltas: readonly SqlRow[],
): Map<string, { key: PlacementKey; deltas: StockQuantityDelta[] }> {
  const map = new Map<string, { key: PlacementKey; deltas: StockQuantityDelta[] }>();
  for (const d of deltas) {
    const key: PlacementKey = {
      itemId: String(d.item_id),
      locationId: String(d.location_id),
      batchKey: String(d.batch_key),
    };
    // `\0` cannot occur in a UUID or a batch key, so this composite id never collides.
    const placementId = `${key.itemId}\0${key.locationId}\0${key.batchKey}`;
    let entry = map.get(placementId);
    if (!entry) {
      entry = { key, deltas: [] };
      map.set(placementId, entry);
    }
    const asserted = num(d.asserted_quantity);
    entry.deltas.push({
      id: String(d.id),
      quantityDelta: num(d.quantity_delta),
      createdAt: num(d.created_at),
      assertedQuantity: Number.isFinite(asserted) ? asserted : null,
    });
  }
  return map;
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
