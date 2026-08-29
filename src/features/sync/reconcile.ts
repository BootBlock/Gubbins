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
import { findKitCycleBreaks, type KitEdge } from '@/features/inventory/kits';
import { applyOffset } from './clock';
import { buildConflict, detectsConflicts, nonLwwColumns } from './conflict-detect';
import { reconcileGauge, reconcileStockQuantity, replayGaugeValue, replayStockQuantity } from './delta-crdt';
import {
  placementIdOf,
  placementQuantities,
  resolveSplitLoanStock,
  type SplitLoanStockRepair,
} from './loan-split-stock';
import { enforceForeignKeys } from './fk-refs';
import { resolveLww } from './lww';
import { overwrittenFields } from './merge-audit';
import { resolveLocationTarget, wouldCreateCycle } from './reparent';
import { sanitiseRow } from './schema-dictionary';
import { SUPPLIER_PART_FLAG_COLUMNS, flagWinner, type FlagRanked } from './supplier-part-flags';
import { planKeyParks, resolveUniqueKeyCollisions } from './unique-keys';
import type {
  BookingOverlapCancellation,
  CollisionResolution,
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
  MergeOverwrite,
  ReconciliationPlan,
  ReparentLog,
  SchemaDictionary,
  LoanReturnRepair,
  KitLinkBreak,
  SerialisedLoanClosure,
  SyncConflict,
  SyncSnapshot,
  SyncTable,
  TableRow,
  Tombstone,
  TombstoneClear,
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
  /**
   * Issue #711: loan id → the operation key that loan's **return** captured its stock under, i.e.
   * `checkInId('stock', loanId)`. Supplied by the caller because that derivation is asynchronous
   * and this pass is not; {@link resolveSplitLoanStock} uses it to spot a return two devices ran
   * against two different placements. Left undefined, only the *draw* is examined, which is the
   * pre-#711 behaviour for the return rather than a wrong answer.
   */
  readonly loanReturnKeys?: ReadonlyMap<string, string>;
}

const EMPTY_PLAN: ReconciliationPlan = {
  localUpserts: [],
  localDeletes: [],
  gaugeResolutions: [],
  stockResolutions: [],
  reparented: [],
  mergeOverwrites: [],
  rejectedCycles: [],
  serialisedLoansClosed: [],
  bookingsCancelled: [],
  kitLinksBroken: [],
  loanReturnsPreserved: [],
  collisions: [],
  keyParks: [],
  tombstoneClears: [],
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

  // --- Issue #542 a return is terminal -------------------------------------------
  // `returned_at` is write-once, which whole-row LWW cannot see: a peer's newer still-open copy of
  // a loan this device has returned would re-open it, stranding the stock the return gave back.
  // Runs before the serialised pass below, so that pass counts a re-opened loan as the closed one
  // it really is rather than collapsing a phantom pair.
  const loanReturnsPreserved = resolveLoanReturnConflicts(
    local,
    remote,
    localUpserts,
    localDeletes,
    dictionary.checkouts,
  );

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

  // --- Issue #487: what the merge overwrote --------------------------------------
  // Deliberately after the FK guard: an `items` upsert that guard drops overwrites nothing, so
  // it must not be recorded as a loss. Nothing later touches the `items` upserts.
  const mergeOverwrites = planMergeOverwrites(conflicts, localUpserts, finalItemIds);

  // --- Issue #539: kit containment cycles ---------------------------------------
  // The kit graph is an edge table, so `rejectParentCycles` above structurally cannot see it: two
  // devices each making a locally valid nesting move converge on a kit that contains itself. Runs
  // after the FK guard so it judges the settled edge set — an edge whose item this merge removes is
  // already gone from the upserts and cascades out of the stored rows, so it must not count towards
  // a loop, nor be tombstoned as if it were the offender.
  const kitLinksBroken = resolveKitComponentCycles(
    local,
    localUpserts,
    localDeletes,
    finalItemIds,
    collisions,
  );

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

  // --- Issue #711: one loan, two placements --------------------------------------
  // A loan derived from a booking conversion is one row on both devices, but each device drew the
  // unit from wherever *it* last saw the asset — so two devices that disagreed about the placement
  // wrote the draw twice, and the per-placement replay below cannot see that the two are one
  // movement. This cancels the surplus first, and hands the stock CRDT the placements it touched
  // so their quantities settle in the same pass.
  const splitLoanStock = resolveSplitLoanStock(
    local,
    remote,
    finalCheckouts(local, localUpserts, localDeletes),
    options.loanReturnKeys ?? new Map(),
    finalItemIds,
  );

  // --- Issue #188 Delta-CRDT discrete-stock reconciliation ----------------------
  const stockResolutions = reconcileStock(local, remote, finalItemIds, splitLoanStock);

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
  const stockDeltaInserts = [
    ...reconcileStockDeltas(local, remote, options.dictionary[STOCK_DELTAS_TABLE], finalItemIds),
    // The issue #711 cancellations ride the same append-only union: ordinary movement rows, minted
    // here rather than pulled from a peer, and `INSERT OR IGNORE` skips one this device holds.
    ...splitLoanStock.cancellations,
  ];
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
  //
  // Issue #536: that filter has to fold in the photo cascade, not just the region's own
  // tombstone. Deleting a photo sweeps its regions away without tombstoning them (§7.2 records
  // the parent only), so a plain surviving-ids set reads a cascade-deleted region as alive and
  // re-inserts the edge against a row the same transaction deletes.
  const finalRegionIds = survivingCascadeIds(
    'location_regions',
    [{ col: 'photo_id', removed: removedParents.location_photos }],
    local,
    localUpserts,
    localDeletes,
  );
  const { itemRegionUpserts, itemRegionDeletes } = reconcileItemRegions(
    local,
    remote,
    offset,
    finalItemIds,
    finalRegionIds,
  );

  // --- Issue #707: free a natural key one upsert takes from another --------------
  // Last of the upsert-facing passes on purpose. A parked row is restored only by its own
  // upsert, so this must see the set every earlier pass has finished dropping from.
  const keyParks = planKeyParks(local, localUpserts);

  // --- Issue #537: stop republishing a deletion this merge has just undone -------
  // Read-only, and last, so it sees the upsert set every pass above has finished dropping from.
  const tombstoneClears = planTombstoneClears(local, localUpserts, localDeletes, collisions);

  return {
    localUpserts,
    localDeletes,
    gaugeResolutions,
    stockResolutions,
    reparented,
    mergeOverwrites,
    rejectedCycles,
    serialisedLoansClosed,
    bookingsCancelled,
    kitLinksBroken,
    loanReturnsPreserved,
    collisions,
    keyParks,
    tombstoneClears,
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
 * Issue #537: the local tombstones this merge contradicts, to delete alongside the upserts.
 *
 * A row this device deleted, that a peer then edited, is downloaded again by the LWW pass — but
 * nothing clears the tombstone recording our deletion, and `buildLocalSnapshot` reads that table
 * wholesale. The device would go on publishing the row and a tombstone for it under one id, so a
 * peer holding neither refuses the row for the tombstone's whole 180-day TTL. Every id the merge
 * writes a row for is therefore paired with a DELETE of any tombstone this device still holds for
 * it, which is what `restoreSnapshot` and the manual conflict restore already do on their paths.
 *
 * Two id sets are deliberately left alone:
 *
 *  - an id this same merge is also **deleting** — the delete records its own tombstone moments
 *    later, and clearing it would be a contradiction whichever order the statements ran in;
 *  - a **collision loser** (issue #187), whose tombstone this merge recorded on purpose to retire
 *    the id. Clearing it would undo the retirement and re-publish the losing id to every peer —
 *    the hazard issue #538 already fixed on the restore path.
 */
function planTombstoneClears(
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
  collisions: readonly CollisionResolution[],
): TombstoneClear[] {
  if (local.tombstones.length === 0 || localUpserts.length === 0) return [];
  // Membership is nested per table rather than flattened onto a composite key: an id is only
  // unique within its own table, and `item_relations` keys a row by the `from|to|kind` triple.
  const perTable = (entries: Iterable<readonly [string, string]>) => {
    const map = new Map<string, Set<string>>();
    for (const [table, id] of entries) {
      let set = map.get(table);
      if (set === undefined) map.set(table, (set = new Set<string>()));
      set.add(id);
    }
    return map;
  };
  const held = perTable(local.tombstones.map((t) => [t.tableName, t.id] as const));
  const excluded = perTable([
    ...localDeletes.map((d) => [d.tableName, d.id] as const),
    ...collisions.map((c) => [c.table, c.loserId] as const),
  ]);

  // One entry per surviving upsert. `localUpserts` holds at most one row per (table, id) —
  // `resolveTableMerges` walks a per-table id set, and every later pass replaces an entry in
  // place rather than appending a second — so the list needs no de-duplication of its own.
  const clears: TombstoneClear[] = [];
  for (const { table, row } of localUpserts) {
    const id = String(row.id);
    if (held.get(table)?.has(id) !== true) continue;
    if (excluded.get(table)?.has(id) === true) continue;
    clears.push({ tableName: table, id });
  }
  return clears;
}

/**
 * Per-table LWW + tombstone resolution (§7.3). For every synced table, diff the local
 * and remote snapshots id-by-id: a remote tombstone deletes the local row unless a
 * strictly-newer row resurrects it — which either side's snapshot can carry, the remote's
 * own row included (issue #537); otherwise the newer of two concurrent rows
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

      // Issue #537: the remote's *own* row can outlive the tombstone beside it — a peer
      // resurrected the id, and the snapshot carries both records because nothing cleared the
      // tombstone when the row came back. That pair is resolved by the same strictly-newer rule
      // already applied to the local pair below, rather than letting the tombstone win by
      // position: otherwise a device holding no copy of the row falls through both conditions of
      // the branch and never downloads it, permanently, while its peers keep the row.
      const remoteResurrects = rTomb !== undefined && rUpd !== undefined && rUpd > rTomb;

      // Remote deleted this row.
      if (rTomb !== undefined && !remoteResurrects) {
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
 * Issue #487: the ledger records for the item edits this merge is about to discard.
 *
 * Derived from the {@link SyncConflict}s the LWW pass already raised rather than from a second
 * scan, so the audit trail and the review UI can never disagree about what was lost. That also
 * settles the "unconditional or bounded?" question the issue raised: an entry is written only
 * where a local edit made **since the last sync** lost to a newer remote one — a genuine
 * concurrent collision. Ordinary propagation of a peer's edit is not a loss (this device changed
 * nothing, and the peer's own `ATTRIBUTES_CHANGED` entry travels with it in the unioned ledger),
 * so it writes nothing and the volume stays proportional to real offline divergence rather than
 * to the size of the pull. Within that gate it is unconditional: a partial audit trail is worse
 * than a large one, because the entries a cap dropped are indistinguishable from edits that were
 * never overwritten.
 *
 * Filtered to the items that both survive the merge and are actually being upserted — the
 * entry's `item_id` is a foreign key into a table the same atomic transaction is writing, and an
 * upsert a later pass dropped overwrote nothing to begin with.
 */
function planMergeOverwrites(
  conflicts: readonly SyncConflict[],
  localUpserts: readonly TableRow[],
  finalItemIds: ReadonlySet<string>,
): MergeOverwrite[] {
  const upsertedItemIds = new Set<string>();
  for (const { table, row } of localUpserts) {
    if (table === 'items') upsertedItemIds.add(String(row.id));
  }

  const overwrites: MergeOverwrite[] = [];
  for (const conflict of conflicts) {
    if (conflict.tableName !== 'items' || conflict.remoteVersion === null) continue;
    if (!upsertedItemIds.has(conflict.rowId) || !finalItemIds.has(conflict.rowId)) continue;
    const changes = overwrittenFields(conflict.localVersion, conflict.remoteVersion);
    if (changes.length === 0) continue;
    overwrites.push({
      itemId: conflict.rowId,
      // The **unadjusted** stamps both rows carry, so the derived id is the same on every
      // device and on every replay. The §7.3 offset is a per-sync measurement of two clocks;
      // folding it in would make the id depend on when the merge ran.
      losingUpdatedAt: num(conflict.localVersion.updated_at),
      winningUpdatedAt: num(conflict.remoteVersion.updated_at),
      changes,
    });
  }
  return overwrites;
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
 * The `checkouts` rows that survive the merge: this device's rows overlaid with the upserts the
 * merge settled on, minus everything it is deleting. Shared by the serialised-loan cardinality
 * repair and the issue #711 split-stock pass so the two read the same post-merge loan set.
 */
function finalCheckouts(
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
): Map<string, SqlRow> {
  const rows = new Map<string, SqlRow>();
  for (const row of local.tables.checkouts ?? []) rows.set(String(row.id), row);
  for (const u of localUpserts) if (u.table === 'checkouts') rows.set(String(u.row.id), u.row);
  for (const d of localDeletes) if (d.tableName === 'checkouts') rows.delete(d.id);
  return rows;
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

  // Group the still-open loans of each serialised item.
  const openByItem = new Map<string, SqlRow[]>();
  for (const row of finalCheckouts(local, localUpserts, localDeletes).values()) {
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

/**
 * Issue #542: `checkouts.returned_at` is **write-once** — a loan goes out, comes back, and stays
 * back. `checkIn` refuses an already-returned loan and `renew` only touches an open one, so the
 * column only ever moves from NULL to a stamp. Whole-row last-write-wins does not know that: when
 * two devices hold the same loan row and one has returned it, a *later* edit to the still-open copy
 * wins the row outright and the loan comes back open.
 *
 * That is not merely an odd row — it strands stock. The return's `+1` is already an entry in the
 * `stock_deltas` ledger, and the union keeps it whichever row wins, so a re-opened loan leaves the
 * asset recorded as out with a borrower *and* sitting on the shelf. Returning it again then adds a
 * second unit to a single-unit asset. Since #542 gave a booking conversion a derived `checkouts`
 * id, two devices converting one booking write the *same* row, which is exactly the pair this can
 * happen to: one device converts and returns while the other, still offline, converts later.
 *
 * So the merge honours the monotonic column instead of the row's timestamp: where one side's copy
 * is closed and the other's is open, the **return** is taken, mutating `localUpserts` in place.
 * Both devices run the same rule over the same two rows and reach the identical result without
 * reference to which side is local.
 *
 * Only the return is taken across, onto the row the merge has already settled on — never a raw
 * snapshot row in its place. Earlier passes have written to that upsert: `resolveUniqueKeyCollisions`
 * repoints a `contact_id` whose contact lost a name collision and is about to be deleted, so
 * resurrecting the pre-merge row would restore the retired id and the atomic apply would abort on
 * its foreign key — taking every other change in the same merge with it, on every subsequent sync.
 * Every other column is LWW's to decide and is left as it settled.
 *
 * "The return" is three columns, not two. `returned_at` and its `return_note` are the return
 * itself; `checked_out_at` comes with them because the schema ties the two together
 * (`CHECK (returned_at IS NULL OR returned_at >= checked_out_at)`), and the two copies of a loan
 * two devices each opened do **not** share it — the later conversion stamps a later hour, so a
 * return lifted onto it would describe a loan handed back before it went out, and the apply would
 * reject the whole merge. The pair is meaningful only together: this loan, closed at that moment.
 * Both values are frame-stable, so both devices write the same ones.
 *
 * `updated_at` is bumped by 1, the convention the sibling repairs use: frame-invariant under the
 * linear push-shift so both devices converge on the identical pushed row with no last-write-wins
 * churn, and strictly greater than the old value so it also skips the `updated_at` self-stamp
 * trigger.
 *
 * Issue #662 gives the same treatment to `returned_quantity`, the counter a loan returned in
 * instalments accumulates. It is monotonic for the same reason `returned_at` is — units come back
 * and stay back — so the merge takes the **larger** of the two copies rather than the newer. This
 * runs whether or not the copies agree about closure, because two still-open copies can disagree
 * about the counter alone: a device that recorded a partial return has already put those units
 * back on the shelf, and a peer's newer untouched copy winning the row outright would say they are
 * still out while the ledger says otherwise. That is the stranded-stock failure of #542, one step
 * earlier in the loan's life.
 */
function resolveLoanReturnConflicts(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: readonly Tombstone[],
  allowedCols: readonly string[] | undefined,
): LoanReturnRepair[] {
  const localRows = rowsById(local.tables.checkouts ?? []);
  const remoteRows = rowsById(remote.tables.checkouts ?? []);
  if (localRows.size === 0 || remoteRows.size === 0) return [];

  const deleted = new Set(localDeletes.filter((d) => d.tableName === 'checkouts').map((d) => d.id));
  const upsertIndex = new Map<string, number>();
  localUpserts.forEach((u, i) => {
    if (u.table === 'checkouts') upsertIndex.set(String(u.row.id), i);
  });

  const repairs: LoanReturnRepair[] = [];

  /** Replace (or add) this loan's settled upsert with `row`, and record the repair. */
  const write = (id: string, row: SqlRow) => {
    const at = upsertIndex.get(id);
    if (at !== undefined) localUpserts[at] = { table: 'checkouts', row };
    else localUpserts.push({ table: 'checkouts', row });
    repairs.push({ itemId: String(row.item_id), checkoutId: id });
  };

  for (const [id, l] of localRows) {
    const r = remoteRows.get(id);
    if (r === undefined || deleted.has(id)) continue;

    // What the merge has settled on so far: the winning upsert, or the untouched local row.
    const existing = upsertIndex.get(id);
    const merged = existing !== undefined ? localUpserts[existing]!.row : l;

    // The high-water mark of the two copies' instalment counters (issue #662), decided
    // independently of the closure below: two still-open copies can disagree about the counter
    // alone, and LWW would then rewind units already back on the shelf.
    //
    // Bounded by the merged row's own `quantity`, because half of the pair is a downloaded row: a
    // snapshot claiming more returned than was ever lent would build an upsert that fails the
    // column's `returned_quantity <= quantity` CHECK, and the apply is atomic — one crafted row
    // would abort every other change in the merge, on this and every subsequent sync. Clamping is
    // the {@link sanitiseRow} treatment for a value used in arithmetic rather than interpolation.
    const watermark = Math.min(
      Math.max(returnedQuantity(l), returnedQuantity(r)),
      Math.max(num(merged.quantity), 0),
    );

    const lClosed = isReturned(l);
    if (lClosed === isReturned(r) || isReturned(merged)) {
      // The closure needs no repair — the copies agree, or the closed copy already won the row on
      // its own. Only the counter can still be behind. `updated_at` is bumped from the merged row,
      // which is the same value on both devices once LWW has settled, so both converge with no
      // last-write-wins churn.
      if (watermark > returnedQuantity(merged)) {
        write(id, { ...merged, returned_quantity: watermark, updated_at: num(merged.updated_at) + 1 });
      }
      continue;
    }

    // The return's own columns, lifted onto the settled row rather than replacing it. The stamp is
    // taken from the closed copy's `updated_at` — the one value both devices hold identically for
    // it — so the +1 bump converges however the rest of the row was resolved.
    const closed = lClosed ? l : allowedCols ? sanitiseRow(r, allowedCols) : r;
    write(id, {
      ...merged,
      checked_out_at: num(closed.checked_out_at),
      returned_at: num(closed.returned_at),
      return_note: closed.return_note ?? null,
      // The closed copy's counter is by definition the higher one — it reached `quantity` — but
      // take the max rather than assume it, so a peer that recorded an instalment the closing
      // device never saw cannot be rewound by the very repair that preserves its return.
      returned_quantity: watermark,
      updated_at: num(closed.updated_at) + 1,
    });
  }
  return repairs;
}

/**
 * A `checkouts` row's instalment counter (issue #662), defaulting a row that predates the column —
 * a snapshot pushed by a device still on an older schema — to none returned.
 */
function returnedQuantity(row: SqlRow): number {
  const value = row.returned_quantity;
  return typeof value === 'number' ? value : 0;
}

/** Whether a `checkouts` row has been returned — the derived RETURNED half of its OPEN/RETURNED status. */
function isReturned(row: SqlRow): boolean {
  return row.returned_at !== null && row.returned_at !== undefined;
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
 * Issue #539: the kit containment graph must stay **acyclic** — a kit cannot contain itself,
 * directly or transitively. `ItemRepository.addKitComponent` enforces that by walking the proposed
 * component's descendant set before it writes, but that is a read-then-write check across sibling
 * rows, so it holds only within one device. Device A adds kit Y as a component of X (legal there),
 * device B adds X as a component of Y (legal there), and the two edges are separate `kit_components`
 * rows under separate ids with a *different* `(kit_item_id, component_item_id)` pair — so the UNIQUE
 * index never fires and the id-keyed LWW union keeps both. The merged graph then holds X → Y → X.
 *
 * `rejectParentCycles` cannot help here: it reads a `parent_id` column and structurally cannot see
 * a hierarchy expressed as edge rows. And the consequence is worse than a wrong number — every
 * read of the kit walks the graph, so a persisted loop takes the database worker down rather than
 * showing something odd. (`readKitGraph` now truncates a loop instead of recursing into it, but
 * that is a backstop for a graph that arrives corrupt by some other route; the loop still has to
 * *go*, or the kit silently under-reports what it contains for ever.)
 *
 * So this pass detects a loop in the merged edge set and removes whichever links close it, by a
 * rule both devices compute identically: **oldest wins** — the edges are re-admitted in
 * `created_at` order (ties broken by the smaller id) and any edge whose kit is already reachable
 * below its component is dropped (see {@link findKitCycleBreaks}). `created_at` is byte-identical
 * on every device because `shiftSnapshotTimestamps` shifts only `updated_at`, so both sides break
 * the same edges without reference to which side is local, and an acyclic graph is left untouched.
 *
 * A broken link is **deleted**, not softened: an edge either exists or it does not, so there is no
 * cancelled state to park it in as a serialised loan or a booking has. The removal is recorded as
 * an ordinary tombstone stamped at the edge's own `updated_at + 1` — the same row-derived stamp
 * `resolveUniqueKeyCollisions` retires a natural-key loser with. It is frame-invariant under the
 * linear push-shift and strictly newer than the row it retires, so it wins LWW on a peer that has
 * not run the repair itself, and both devices write the identical tombstone rather than
 * overwriting each other's. The one thing a row-derived stamp is not is *recent*: repairing a loop
 * whose newest edge is older than the §7.2 tombstone TTL publishes the removal once and then
 * prunes it in the same pass. That costs nothing here — every device that merges the loop reaches
 * the same verdict from its own edge set, so the edge stays gone without the tombstone to remind
 * it. Any upsert restoring a broken edge is dropped alongside it, or the apply would delete and
 * re-insert the row in one transaction.
 */
function resolveKitComponentCycles(
  local: SyncSnapshot,
  localUpserts: TableRow[],
  localDeletes: Tombstone[],
  finalItemIds: ReadonlySet<string>,
  collisions: readonly CollisionResolution[],
): KitLinkBreak[] {
  // The edge rows that survive the merge: local rows overlaid with winning upserts, minus deletes
  // and minus the ids §7.5 retired. A retired edge is a duplicate of the winner under the same
  // `(kit_item_id, component_item_id)` pair that `applyPlan` deletes on the collision's own
  // verdict, so counting it would report — and tombstone — one removal per duplicate of a single
  // link the user only ever made once.
  const finalEdges = new Map<string, SqlRow>();
  for (const row of local.tables.kit_components ?? []) finalEdges.set(String(row.id), row);
  for (const u of localUpserts) if (u.table === 'kit_components') finalEdges.set(String(u.row.id), u.row);
  for (const d of localDeletes) if (d.tableName === 'kit_components') finalEdges.delete(d.id);
  for (const c of collisions) if (c.table === 'kit_components') finalEdges.delete(c.loserId);

  const edges: KitEdge[] = [];
  for (const row of finalEdges.values()) {
    const kitId = String(row.kit_item_id);
    const componentId = String(row.component_item_id);
    // An edge either end of which the merge removes is cascade-deleted with its item; counting it
    // could break an innocent link in its place.
    if (!finalItemIds.has(kitId) || !finalItemIds.has(componentId)) continue;
    edges.push({ id: String(row.id), kitId, componentId, createdAt: num(row.created_at) });
  }

  const breaks: KitLinkBreak[] = [];
  for (const edge of findKitCycleBreaks(edges)) {
    const row = finalEdges.get(edge.id)!;
    const at = localUpserts.findIndex((u) => u.table === 'kit_components' && String(u.row.id) === edge.id);
    if (at >= 0) localUpserts.splice(at, 1);
    localDeletes.push({
      tableName: 'kit_components',
      id: edge.id,
      deletedAt: num(row.updated_at) + 1,
    });
    breaks.push({ edgeId: edge.id, kitItemId: edge.kitId, componentItemId: edge.componentId });
  }
  return breaks;
}

/**
 * The parent tables {@link computeRemovedParents} builds a removed-id set for — the merge's half
 * of the FK_REFS contract.
 *
 * `enforceForeignKeys` reads a *missing* key as "parent intact", so an FK_REFS entry whose
 * parent has no set here is inert: the guard never fires and the merge re-inserts an orphan that
 * aborts the whole atomic apply (issue #536, which is how `location_photos` and
 * `project_budget_categories` were dead entries). Two things keep the halves in step. The return
 * type is keyed by this list, so `computeRemovedParents` fails to compile if it stops producing
 * one of them; and `fk-refs.test.ts` asserts every FK_REFS parent appears here, so adding a
 * reference to a new parent fails the build rather than silently doing nothing.
 */
export const REMOVED_PARENT_TABLES = [
  'items',
  'locations',
  'categories',
  'contacts',
  'projects',
  'field_defs',
  'suppliers',
  'supplier_parts',
  'purchase_orders',
  'roles',
  'users',
  'location_photos',
  'project_budget_categories',
] as const satisfies readonly SyncTable[];

/** A parent table {@link computeRemovedParents} is required to produce a removed-id set for. */
type RemovedParentTable = (typeof REMOVED_PARENT_TABLES)[number];

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
): Record<RemovedParentTable, Set<string>> {
  const removedCategories = removedIds(
    'categories',
    local,
    remote,
    survivingIds('categories', local, localUpserts, localDeletes),
  );
  const removedLocations = removedIds('locations', local, remote, activeLocationIds);
  const removedProjects = removedIds(
    'projects',
    local,
    remote,
    survivingIds('projects', local, localUpserts, localDeletes),
  );
  const removedItems = removedIds('items', local, remote, finalItemIds);
  const removedSuppliers = removedIds(
    'suppliers',
    local,
    remote,
    survivingIds('suppliers', local, localUpserts, localDeletes),
  );
  return {
    items: removedItems,
    // A placement at a removed location must not be resurrected — its location's RESTRICT
    // FK would reject it (Phase 25). The active set already drives the §7.5.2 item re-parent.
    locations: removedLocations,
    categories: removedCategories,
    contacts: removedIds(
      'contacts',
      local,
      remote,
      survivingIds('contacts', local, localUpserts, localDeletes),
    ),
    projects: removedProjects,
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
    suppliers: removedSuppliers,
    // A part is a cascade child of *both* its item and its supplier (issue #536), so its removed
    // set folds in each — otherwise a part swept away by a local item/supplier delete reads as
    // surviving and its own children (a price point, a PO line) are let through the guard.
    supplier_parts: removedIds(
      'supplier_parts',
      local,
      remote,
      survivingCascadeIds(
        'supplier_parts',
        [
          { col: 'item_id', removed: removedItems },
          { col: 'supplier_id', removed: removedSuppliers },
        ],
        local,
        localUpserts,
        localDeletes,
      ),
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
    // Issue #536: the two parents that had no set at all. Both are themselves cascade *children*
    // (as `supplier_parts` above is), so their removed set has to fold in the cascade the
    // tombstone does not record — §7.2 tombstones the parent only. A photo of a removed location
    // is gone, because the location tombstone's DELETE cascades to it, so every region drawn on
    // it must be dropped too or the merge re-inserts a region against a photo the same
    // transaction is deleting. A budget category of a removed project is the same shape one level
    // over, and clears the nullable `project_expenses.category_id` rather than dropping the spend.
    location_photos: removedIds(
      'location_photos',
      local,
      remote,
      survivingCascadeIds(
        'location_photos',
        [{ col: 'location_id', removed: removedLocations }],
        local,
        localUpserts,
        localDeletes,
      ),
    ),
    project_budget_categories: removedIds(
      'project_budget_categories',
      local,
      remote,
      survivingCascadeIds(
        'project_budget_categories',
        [{ col: 'project_id', removed: removedProjects }],
        local,
        localUpserts,
        localDeletes,
      ),
    ),
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

/** One `ON DELETE CASCADE` reference a table is on the receiving end of, and its removed parents. */
interface CascadeParent {
  /** The child column holding the parent id. */
  readonly col: string;
  /** The parent ids that will not survive this merge. */
  readonly removed: ReadonlySet<string>;
}

/**
 * The surviving ids of a child table whose own parent's removal cascades to it (issue #536).
 *
 * {@link survivingIds} answers "was this row deleted or upserted", which is the whole story for a
 * top-level dictionary. It is not for a table like `location_photos`, whose rows are swept away by
 * their location's `ON DELETE CASCADE` without a tombstone of their own (§7.2 records the parent
 * only). Such a row is *not* deleted and *not* upserted, so it reads as surviving — and its own
 * children are then let through the guard to trip the foreign key. Removing every row whose parent
 * did not survive gives the set the cascade will actually leave behind.
 *
 * A table can sit under more than one cascade — `supplier_parts` dies with either its item or its
 * supplier — so every reference is folded in, and one removed parent is enough to take the row.
 *
 * The parent id is read from the merged row (a pending upsert overrides the stored one), so a row
 * being re-parented *out of* a removed parent by this same merge is correctly kept. Ids present
 * only on the remote need no lookup: they are absent from `surviving` already, so {@link removedIds}
 * has them covered.
 */
function survivingCascadeIds(
  table: SyncTable,
  parents: readonly CascadeParent[],
  local: SyncSnapshot,
  localUpserts: readonly TableRow[],
  localDeletes: readonly Tombstone[],
): Set<string> {
  const surviving = survivingIds(table, local, localUpserts, localDeletes);
  const live = parents.filter((p) => p.removed.size > 0);
  if (live.length === 0) return surviving;

  // The merged row of every id still in `surviving`: stored rows overlaid with pending upserts.
  const rowOf = new Map<string, SqlRow>();
  for (const row of local.tables[table] ?? []) rowOf.set(String(row.id), row);
  for (const u of localUpserts) if (u.table === table) rowOf.set(String(u.row.id), u.row);

  for (const id of surviving) {
    const row = rowOf.get(id);
    if (row === undefined) continue;
    if (live.some(({ col, removed }) => removed.has(String(row[col])))) surviving.delete(id);
  }
  return surviving;
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
 * there is no actor re-key to apply, and no prune watermark — the ledger is bounded by summarising
 * a placement's old movements into a checkpoint row rather than by refusing to re-import them
 * (issue #544, `./stock-delta-compaction`), so a re-imported delta is superseded by the checkpoint
 * instead of needing to be turned away here. A delta is
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
 *
 * A placement the issue #711 pass has just cancelled a movement at is exempt from (1): the
 * cancellation is a movement this merge is itself appending, so the placement has to be replayed
 * whether or not both devices had touched it before. It is counted among the remote deltas, so (3)
 * still lets a settled placement pass by untouched, and (2) still holds each side to its own
 * ledger — `resolveSplitLoanStock` requires the same of both sides before it writes anything.
 */
function reconcileStock(
  local: SyncSnapshot,
  remote: SyncSnapshot,
  finalItemIds: ReadonlySet<string>,
  splitLoanStock: SplitLoanStockRepair,
): StockResolution[] {
  const localByPlacement = byPlacement(local.stockDeltas ?? []);
  const remoteByPlacement = byPlacement(remote.stockDeltas ?? []);
  const localQuantities = placementQuantities(local.tables.stock_batches ?? []);
  const remoteQuantities = placementQuantities(remote.tables.stock_batches ?? []);
  const cancellations = byPlacement(splitLoanStock.cancellations);
  const resolutions: StockResolution[] = [];
  // Every placement this device has moved, plus those the #711 repair has just written a
  // cancellation into — the latter may have no local ledger of their own, and their quantity has
  // to follow the row this merge appended either way.
  const placementIds = new Set([...localByPlacement.keys(), ...splitLoanStock.placements]);
  for (const placementId of placementIds) {
    const repaired = splitLoanStock.placements.has(placementId);
    const localEntry = localByPlacement.get(placementId);
    const remoteEntry = remoteByPlacement.get(placementId);
    const key = localEntry?.key ?? remoteEntry?.key ?? cancellations.get(placementId)?.key;
    if (!key) continue;
    // (1) Only a placement both devices moved can have diverged; a one-sided one keeps its LWW
    // value. A repaired placement is exempt: the cancellation is this merge's own new movement,
    // and it is exactly the divergence the guard is looking for.
    if (!repaired && (!localEntry || !remoteEntry)) continue;
    if (!finalItemIds.has(key.itemId)) continue;
    // (2) Both ledgers must be complete — `replay(deltas) == quantity` — or the replay would lose
    // an uncaptured baseline. A baseline-less side falls back to LWW rather than to a wrong figure.
    // A side holding no `stock_batches` row for the placement has nothing to contradict, so it is
    // not asked; only a repaired placement reaches this with a side missing, and #711's own guard
    // has already required completeness of both sides before writing a cancellation.
    if (!sideIsComplete(localEntry, localQuantities.get(placementId))) continue;
    if (!sideIsComplete(remoteEntry, remoteQuantities.get(placementId))) continue;
    const localDeltas = localEntry?.deltas ?? [];
    const remoteDeltas = [...(remoteEntry?.deltas ?? []), ...(cancellations.get(placementId)?.deltas ?? [])];
    // (3) Skip when the remote carries no movement this device lacks (no divergence → no churn).
    // The cancellations are counted as remote movements above, so a repaired placement passes
    // this on its first merge and settles quietly on every one after it.
    const localIds = new Set(localDeltas.map((d) => d.id));
    if (remoteDeltas.every((d) => localIds.has(d.id))) continue;
    resolutions.push({
      itemId: key.itemId,
      locationId: key.locationId,
      batchKey: key.batchKey,
      quantity: reconcileStockQuantity(localDeltas, remoteDeltas),
    });
  }
  return resolutions;
}

/**
 * {@link reconcileStock}'s guard (2) for one side: its own ledger for the placement must replay to
 * the quantity it stored. A side holding neither a row nor a ledger for the placement passes — it
 * has recorded nothing the replay could contradict — but a side with ledger rows and no row for
 * them to explain does not, which is what the pre-#711 `replay(deltas) !== quantities.get(id)`
 * comparison said when the right-hand side was `undefined`. `resolveSplitLoanStock` asks the same
 * question the same way, so it never appends a cancellation this then refuses to settle.
 */
function sideIsComplete(
  entry: { deltas: StockQuantityDelta[] } | undefined,
  stored: number | undefined,
): boolean {
  if (stored === undefined) return entry === undefined || entry.deltas.length === 0;
  return replayStockQuantity(entry?.deltas ?? []) === stored;
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
    const placementId = placementIdOf(d);
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
