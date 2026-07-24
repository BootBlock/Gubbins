/**
 * The database-bound half of a sync pass (issue #173).
 *
 * {@link runSnapshotMerge} is everything between "we have the remote snapshot" and "here is
 * the merged snapshot to push": reading the full local state, running the pure
 * {@link reconcile} engine over it, applying the resulting plan atomically, and re-reading
 * the merged result. It is deliberately factored out of the orchestrator in `./sync-engine`
 * so it can run **inside the database worker** rather than on the main thread.
 *
 * Why that matters: the local snapshot holds every row of every syncable table, with
 * `item_images` thumbnails base64-inflated by ~33%. At a large inventory that is a
 * multi-hundred-megabyte object, and `reconcile` is one long synchronous pass over it — on
 * the main thread the browser cannot paint or handle input for its whole duration, so the UI
 * simply freezes mid-sync. Run in the worker, none of it is ever on the main thread: the
 * paged reads no longer cross the bridge one page at a time, the snapshot is never
 * materialised beside the UI, and only the merged snapshot (which the network push genuinely
 * needs) comes back.
 *
 * The one input this cannot derive for itself is the clock offset, so the frame conversions
 * (§7.3.1) happen here too: the remote arrives in *server* time and is shifted into the
 * device's local frame before diffing, and the merged snapshot is shifted back to server time
 * before it is returned push-ready. Doing both here keeps two more full passes over the
 * snapshot off the main thread.
 *
 * Everything else a sync pass does — the quota Hard Stop, the clock measurement, the provider
 * transport, `sync_meta` — stays in the orchestrator, which is where the browser-only and
 * network-only concerns belong.
 */
// The defining module, not the `@/db/repositories` barrel — see the note in ./snapshot.
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
} from '@/db/repositories/tombstone';
import type { IDatabaseDriver, SqlRow, SqlStatement, SqlValue } from '@/db/rpc/driver';
import { decodeRowForTable } from './blob-codec';
import { defaultLocationWinner } from './location-default-flag';
import { forceLwwTies } from './lww-tie-override';
import { reconcile } from './reconcile';
import { supplierPartFlagClears } from './supplier-part-flags';
import { buildSchemaDictionary } from './schema-dictionary';
import {
  applyPlan,
  buildCloneStatements,
  buildLocalSnapshot,
  historyInsertStatement,
  requireColumns,
  shiftSnapshotTimestamps,
  stockDeltaInsertStatement,
  tombstoneDeleteStatement,
  withCaptureDisabled,
} from './snapshot';
import type { SchemaDictionary, SyncConflict, SyncSnapshot, SyncTable, Tombstone } from './types';

/** Tables read into the schema dictionary: the LWW set plus the two unioned ledgers. */
const DICTIONARY_TABLES = [...SYNC_TABLES, ITEM_HISTORY_TABLE, STOCK_DELTAS_TABLE];

/**
 * Which of the three §7.3 paths this pass takes. The orchestrator decides — the choice needs
 * `sync_meta` and whether the remote exists at all, both of which it already holds.
 *
 * - `publish` — no remote yet: nothing to merge, just read local state to push (§7.3 step 1).
 * - `clone` — §7.2 Tombstone-TTL edge: Pre-Wipe Salvage, then clone the remote wholesale.
 * - `delta` — the ordinary reconciliation.
 */
export type SnapshotMergeMode = 'publish' | 'clone' | 'delta';

export interface SnapshotMergeRequest {
  readonly mode: SnapshotMergeMode;
  /**
   * The remote snapshot **as fetched**, still in server time — the shift into this device's
   * frame happens here (see the module note). Null only for `publish`.
   */
  readonly remote: SyncSnapshot | null;
  /** §7.3.1 clock offset (server − local). */
  readonly offset: number;
  /** The sync's effective now, stamped onto the snapshot and any detected conflicts. */
  readonly effectiveNow: number;
  /** `sync_meta.last_sync_timestamp`, in server time (the §7.2 salvage cut-off). */
  readonly lastSyncTimestamp: number;
  /** §7.6.3-A prune watermark. */
  readonly historyPrunedBefore: number;
  /** Issue #72 collision watermark, in the **local** frame. Undefined disables detection. */
  readonly conflictSince?: number;
  /**
   * Lab-only reproduction seam (`sync-lww-tie`), resolved on the main thread because the flag
   * store is main-thread-only. False leaves this path byte-identical.
   */
  readonly forceTies: boolean;
}

export interface SnapshotMergeResult {
  /**
   * The merged local state, re-read after the apply and already shifted into **server** time —
   * i.e. ready to hand straight to `pushSnapshot`.
   */
  readonly merged: SyncSnapshot;
  readonly pulled: number;
  readonly deleted: number;
  readonly reparented: number;
  readonly rejectedCycles: number;
  readonly serialisedLoansClosed: number;
  readonly historyInserted: number;
  readonly tagEdgesAdded: number;
  readonly tagEdgesRemoved: number;
  readonly conflicts: readonly SyncConflict[];
}

/**
 * Run the database-bound half of one sync pass and return the merged snapshot, push-ready.
 *
 * Safe to call on either side of the worker bridge: it touches nothing browser-specific, so
 * the `:memory:` driver runs it in-process (which is what the test suite and any driver
 * without the off-thread capability do).
 */
export async function runSnapshotMerge(
  driver: IDatabaseDriver,
  request: SnapshotMergeRequest,
): Promise<SnapshotMergeResult> {
  const { mode, offset, effectiveNow } = request;

  if (mode === 'publish') {
    return emptyResult(await readMerged(driver, effectiveNow, offset));
  }

  const dictionary = await buildSchemaDictionary(driver, DICTIONARY_TABLES);

  if (mode === 'clone') {
    await cloneWithSalvage(driver, localFrameRemote(request), dictionary, request);
    return emptyResult(await readMerged(driver, effectiveNow, offset));
  }

  // The local snapshot and the plan are deliberately confined to `reconcileAndApply`: both are
  // the size of the database, and the merged snapshot read on the next line is another of the
  // same. Letting them fall out of scope first roughly halves the peak, which is the whole
  // point at the inventory sizes this exists for (issue #173).
  const counts = await reconcileAndApply(driver, dictionary, request);
  return { merged: await readMerged(driver, effectiveNow, offset), ...counts };
}

/** Everything the merge counters are derived from — the plan, minus the plan itself. */
type MergeCounts = Omit<SnapshotMergeResult, 'merged'>;

/**
 * The §7.3 delta pass: read local, reconcile against the remote, apply the plan atomically.
 *
 * Returns only the counters, so the snapshots and the plan it worked from are unreachable by
 * the time the caller reads the merged state back.
 */
async function reconcileAndApply(
  driver: IDatabaseDriver,
  dictionary: SchemaDictionary,
  request: SnapshotMergeRequest,
): Promise<MergeCounts> {
  const remote = localFrameRemote(request);
  const local = await buildLocalSnapshot(driver, request.effectiveNow);
  // `offset: 0` is deliberate: `remote` was converted to this device's local frame above, and
  // `local` is read straight from the DB (also local frame), so the two are directly
  // comparable and reconcile must apply no further shift.
  const plan = reconcile(local, request.forceTies ? forceLwwTies(local, remote) : remote, {
    offset: 0,
    dictionary,
    historyPrunedBefore: request.historyPrunedBefore,
    conflictSince: request.conflictSince,
    now: request.effectiveNow,
  });
  await applyPlan(driver, plan, dictionary);

  return {
    pulled: plan.localUpserts.length,
    deleted: plan.localDeletes.length,
    reparented: plan.reparented.length,
    rejectedCycles: plan.rejectedCycles.length,
    serialisedLoansClosed: plan.serialisedLoansClosed.length,
    historyInserted: plan.historyInserts.length,
    tagEdgesAdded: plan.itemTagUpserts.length + plan.locationTagUpserts.length,
    tagEdgesRemoved: plan.itemTagDeletes.length + plan.locationTagDeletes.length,
    conflicts: plan.conflicts,
  };
}

/**
 * The remote in *this* device's clock frame (§7.3.1).
 *
 * The wire carries server-time timestamps (every device normalises on push), so it is shifted
 * back once, up front — reconcile, the TTL clone and everything written to the DB then all
 * operate in one consistent frame.
 */
function localFrameRemote(request: SnapshotMergeRequest): SyncSnapshot {
  if (request.remote === null) {
    throw new Error('A snapshot merge outside the first publish requires a remote snapshot.');
  }
  return shiftSnapshotTimestamps(request.remote, -request.offset);
}

/**
 * A driver that can run {@link runSnapshotMerge} inside the database worker (issue #173).
 *
 * Structural rather than part of `IDatabaseDriver` because it is genuinely optional: the
 * `:memory:` driver the test suite injects has no worker to delegate to, and the whole point
 * of the seam is that the same code answers correctly either way.
 */
export interface OffThreadSnapshotMerge {
  snapshotMerge(request: SnapshotMergeRequest): Promise<SnapshotMergeResult>;
}

/**
 * Run the merge off the main thread when `driver` can, in-process when it cannot.
 *
 * This is what callers should use; {@link runSnapshotMerge} is the implementation both sides
 * of the bridge share.
 *
 * The storage Hard Stop is *not* applied here: as the module note says, it belongs to the
 * orchestrator, and `./sync-engine` already runs a §7.4 pre-flight check — a fresh
 * `estimateStorage()` that aborts the pass at the *critical* threshold, before any of this.
 */
export function mergeSnapshot(
  driver: IDatabaseDriver,
  request: SnapshotMergeRequest,
): Promise<SnapshotMergeResult> {
  const offThread = driver as Partial<OffThreadSnapshotMerge>;
  return typeof offThread.snapshotMerge === 'function'
    ? offThread.snapshotMerge(request)
    : runSnapshotMerge(driver, request);
}

/** Re-read the merged local state and normalise it to server time for the push. */
async function readMerged(
  driver: IDatabaseDriver,
  effectiveNow: number,
  offset: number,
): Promise<SyncSnapshot> {
  return shiftSnapshotTimestamps(await buildLocalSnapshot(driver, effectiveNow), offset);
}

function emptyResult(merged: SyncSnapshot): SnapshotMergeResult {
  return {
    merged,
    pulled: 0,
    deleted: 0,
    reparented: 0,
    rejectedCycles: 0,
    serialisedLoansClosed: 0,
    historyInserted: 0,
    tagEdgesAdded: 0,
    tagEdgesRemoved: 0,
    conflicts: [],
  };
}

/**
 * §7.2 Pre-Wipe Salvage: capture local rows/tombstones changed since the last sync,
 * wipe the syncable tables, clone the remote wholesale, then re-apply the salvage as
 * local-wins so offline work survives the clone.
 */
async function cloneWithSalvage(
  driver: IDatabaseDriver,
  remote: SyncSnapshot,
  dictionary: SchemaDictionary,
  request: SnapshotMergeRequest,
): Promise<void> {
  const { lastSyncTimestamp: lastSync, offset, historyPrunedBefore } = request;
  // 1. Salvage: rows whose offset-adjusted updated_at is newer than the last sync.
  const salvage = await buildLocalSnapshot(driver);
  const salvageRows: { table: SyncTable; row: SqlRow }[] = [];
  for (const table of SYNC_TABLES) {
    for (const row of salvage.tables[table] ?? []) {
      if (Number(row.updated_at) + offset > lastSync) salvageRows.push({ table, row });
    }
  }
  const salvageTombstones = salvage.tombstones.filter((t) => t.deletedAt + offset > lastSync);

  // 2 & 3. Wipe + clone the remote (shared with §2 restore), then re-apply the
  // salvage as local-wins — all in one transaction.
  const statements: SqlStatement[] = buildCloneStatements(remote, dictionary, historyPrunedBefore);

  // Issues #157 / #192: a salvaged supplier part re-pinned offline (local-wins) must clear the
  // one-of-N flag the clone just wrote for the same item, or the salvage upsert leaves two rows
  // sharing it and trips the partial unique index. The local DB is index-clean, so the salvage set
  // holds at most one flagged row per item — a straight clear-then-set, ahead of the upserts.
  for (const { column, itemId } of supplierPartFlagClears(
    salvageRows.filter((s) => s.table === 'supplier_parts').map((s) => s.row),
  )) {
    statements.push({
      sql: `UPDATE supplier_parts SET ${column} = 0 WHERE item_id = ? AND ${column} = 1;`,
      params: [itemId],
    });
  }

  // Issue #191: the same for the salvaged default location — clear the one default the clone wrote
  // for the remote before the salvage re-sets the locally-nominated one, or the two collide on the
  // partial unique index. The local DB is index-clean, so the salvage set holds at most one default.
  const salvageDefault = defaultLocationWinner(
    salvageRows.filter((s) => s.table === 'locations').map((s) => s.row),
  );
  if (salvageDefault !== null) {
    statements.push({
      sql: `UPDATE locations SET is_default = 0 WHERE is_default = 1 AND id <> ?;`,
      params: [salvageDefault],
    });
  }

  for (const { table, row } of salvageRows) {
    statements.push(upsert(table, row, requireColumns(dictionary, table)));
  }
  for (const t of salvageTombstones) {
    statements.push(tombstoneDeleteStatement(t.tableName, t.id));
    statements.push(tombstone(t));
  }

  // Phase 11 non-LWW salvage. The append-only ledger and M:N membership have no
  // `updated_at`, so they merge as sets rather than by the lastSync cut-off:
  //  - re-union ALL local history rows (INSERT OR IGNORE; the wholesale clone already
  //    pulled the remote's, so this restores any offline-only entries);
  //  - re-assert ALL local membership edges *except* those tombstoned on either side
  //    (so a removal — local or remote — still wins), then apply every local edge
  //    tombstone (deleting any edge the clone re-introduced + recording the tombstone).
  const removedItemEdges = new Set<string>();
  const removedLocationEdges = new Set<string>();
  const removedRegionEdges = new Set<string>();
  for (const source of [remote.tombstones, salvage.tombstones]) {
    for (const t of source) {
      if (t.tableName === ITEM_TAGS_TABLE) removedItemEdges.add(t.id);
      else if (t.tableName === LOCATION_TAGS_TABLE) removedLocationEdges.add(t.id);
      else if (t.tableName === ITEM_REGIONS_TABLE) removedRegionEdges.add(t.id);
    }
  }

  for (const row of salvage.itemHistory) {
    statements.push(historyInsertStatement(row, dictionary[ITEM_HISTORY_TABLE]));
  }
  // Issue #188: re-union the offline-only stock-delta rows the wholesale clone did not carry,
  // the direct sibling of the item_history re-union above. With capture disabled around the whole
  // batch (below), the salvage `stock_batches` upserts record no fresh deltas, so these preserved
  // rows — with their original ids — are the sole record of the offline movements.
  for (const row of salvage.stockDeltas) {
    statements.push(stockDeltaInsertStatement(row, dictionary[STOCK_DELTAS_TABLE]));
  }
  for (const { itemId, tagId } of salvage.itemTags) {
    if (removedItemEdges.has(itemTagEdgeId(itemId, tagId))) continue;
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_TAGS_TABLE} (item_id, tag_id) VALUES (?, ?);`,
      params: [itemId, tagId],
    });
  }
  for (const { locationId, tagId } of salvage.locationTags) {
    if (removedLocationEdges.has(locationTagEdgeId(locationId, tagId))) continue;
    statements.push({
      sql: `INSERT OR IGNORE INTO ${LOCATION_TAGS_TABLE} (location_id, tag_id) VALUES (?, ?);`,
      params: [locationId, tagId],
    });
  }
  for (const { itemId, regionId } of salvage.itemRegions) {
    if (removedRegionEdges.has(itemRegionEdgeId(itemId, regionId))) continue;
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_REGIONS_TABLE} (item_id, region_id) VALUES (?, ?);`,
      params: [itemId, regionId],
    });
  }
  for (const t of salvage.tombstones) {
    if (
      t.tableName !== ITEM_TAGS_TABLE &&
      t.tableName !== LOCATION_TAGS_TABLE &&
      t.tableName !== ITEM_REGIONS_TABLE
    ) {
      continue;
    }
    statements.push(tombstoneDeleteStatement(t.tableName, t.id));
    statements.push(tombstone(t));
  }

  // Issue #188: the clone AND the salvage both re-insert `stock_batches` rows whose deltas travel
  // in the (re-unioned) ledger, so the whole batch runs capture-disabled — otherwise the salvage
  // upserts would re-capture and double-count. `buildCloneStatements` is a plain builder now, so
  // the guard wraps everything here at the transaction boundary.
  await driver.transaction(withCaptureDisabled(statements));
}

// --- statement builders ----------------------------------------------------------

function upsert(table: SyncTable, snapshotRow: SqlRow, columns: readonly string[]): SqlStatement {
  // Decode any base64 BLOB (item_images thumbnail) from the snapshot back to bytes.
  const row = decodeRowForTable(table, snapshotRow);
  const cols = columns.filter((c) => c in row);
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates};`;
  return { sql, params: cols.map((c) => row[c] as SqlValue) };
}

function tombstone(t: Tombstone): SqlStatement {
  return {
    sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
    params: [t.tableName, t.id, t.deletedAt],
  };
}
