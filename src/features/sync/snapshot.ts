/**
 * Building & applying the sync snapshot (spec §7.3, §7.5, Phase 7).
 *
 * {@link buildLocalSnapshot} reads the full row set of every syncable table (paging
 * the worker bridge at ≤100 per §2.1), the tombstones (§7.2) and the gauge net-value
 * deltas the §7.3 Delta-CRDT needs. {@link applyPlan} turns a {@link ReconciliationPlan}
 * into the single atomic `BEGIN…COMMIT` of UPSERTs/DELETEs/gauge-updates/conflict-logs
 * the spec mandates. The pure {@link reconcile} engine sits between the two.
 */
import {
  ITEM_HISTORY_TABLE,
  ITEM_REGIONS_TABLE,
  ITEM_TAGS_TABLE,
  LOCATION_TAGS_TABLE,
  SYNC_EXCLUDED_COLUMNS,
  SYNC_TABLES,
  UNASSIGNED_LOCATION_ID,
  clearItemRegionTombstoneStatement,
  clearItemTagTombstoneStatement,
  clearLocationTagTombstoneStatement,
  isTombstoneTable,
  itemRegionEdgeId,
  itemTagEdgeId,
  locationTagEdgeId,
  parseItemRegionEdgeId,
  parseItemTagEdgeId,
  parseLocationTagEdgeId,
} from '@/db/repositories';
import { SYSTEM_USER_ID } from '@/db/repositories/constants';
import { historyStatement } from '@/db/repositories/item/history';
import type { IDatabaseDriver, SqlRow, SqlStatement, SqlValue } from '@/db/rpc/driver';
import { decodeRowForTable, encodeRowForTable } from './blob-codec';
import { buildSchemaDictionary } from './schema-dictionary';
import type {
  GaugeHistoryDelta,
  ItemRegionEdge,
  ItemTagEdge,
  LocationTagEdge,
  ReconciliationPlan,
  SchemaDictionary,
  SyncSnapshot,
  SyncTable,
  Tombstone,
} from './types';
import { SYNC_FORMAT_VERSION } from './types';

const PAGE = 100;

/**
 * Per-table read filter. The system-locked locations (Unassigned, In Transit) are
 * seeded deterministically with the *same* constant ids on every device and are
 * protected by `trg_locations_protect_system_*`; they must never be synced (a remote
 * UPSERT would trip that guard), so they are excluded from the snapshot here.
 */
const TABLE_FILTER: Partial<Record<SyncTable, string>> = {
  locations: 'WHERE is_system = 0',
  // The built-in System and Admin users are seeded by the baseline with the *same* constant
  // ids on every device and protected by `trg_users_protect_builtin_*`, exactly like the
  // system-locked locations above — a remote UPSERT would trip that guard and abort the whole
  // merge transaction. They need no syncing precisely because every device already has them.
  users: "WHERE kind = 'normal'",
};

/**
 * Per-table **wipe** filter: which rows a clone/restore is allowed to delete before
 * re-inserting the remote's version.
 *
 * Deliberately separate from {@link TABLE_FILTER} (which decides what is *read* into a
 * snapshot), because the two answers genuinely differ. Any row protected by a `RAISE(ABORT)`
 * delete trigger must be spared here or the entire clone transaction aborts — the whole
 * restore fails, not just that row.
 *
 * - `locations` — the system-locked Unassigned / In Transit rows.
 * - `users` — the built-in System and Admin principals. Also unread, so the wipe filter
 *   matches their read filter.
 * - `roles` — built-in roles are *not* excluded from reading: they are editable, so their
 *   edits must propagate. They are only undeletable, so the wipe spares them and the
 *   subsequent `INSERT OR REPLACE` restores the remote's version in place.
 */
const WIPE_FILTER: Partial<Record<SyncTable, string>> = {
  locations: 'WHERE is_system = 0',
  users: "WHERE kind = 'normal'",
  roles: 'WHERE is_builtin = 0',
};

/** Read every row of a table, paging the worker bridge (§2.1). */
async function readAllRows(driver: IDatabaseDriver, table: SyncTable): Promise<SqlRow[]> {
  const where = TABLE_FILTER[table] ?? '';
  const all: SqlRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await driver.query<SqlRow>(`SELECT * FROM ${table} ${where} ORDER BY id LIMIT ? OFFSET ?;`, [
      PAGE,
      offset,
    ]);
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/**
 * Prepare a freshly-read row for the snapshot: drop any held-back columns (§7.6.3-B)
 * and base64-encode BLOBs (§4.2 thumbnails) so the snapshot is always JSON-safe.
 */
function rowForSnapshot(table: SyncTable, row: SqlRow): SqlRow {
  const drop = SYNC_EXCLUDED_COLUMNS[table];
  let clean = row;
  if (drop && drop.length > 0) {
    clean = { ...row };
    for (const col of drop) delete clean[col];
  }
  return encodeRowForTable(table, clean);
}

/** Build the full local snapshot for diffing/pushing/back-up (§7.3, §2). */
export async function buildLocalSnapshot(
  driver: IDatabaseDriver,
  generatedAt = Date.now(),
): Promise<SyncSnapshot> {
  const tables: Record<string, SqlRow[]> = {};
  for (const table of SYNC_TABLES) {
    const rows = await readAllRows(driver, table);
    tables[table] = rows.map((row) => rowForSnapshot(table, row));
  }

  const tombstoneRows = await driver.query<{ table_name: string; id: string; deleted_at: number }>(
    'SELECT table_name, id, deleted_at FROM tombstones ORDER BY deleted_at;',
  );
  // Drop any locally-stored tombstone naming a table that is not in the allow-list. Unlike an
  // *incoming* snapshot — where an unknown name means the payload is not ours and the whole
  // thing is refused — this is data already sitting in the local database, so refusing it would
  // strand the device: every sync would throw at `tombstoneDeleteStatement` with nothing the
  // user could do about it. A tombstone for a table that does not exist can never delete
  // anything, so dropping it on read is both safe and self-healing: it stops the row being
  // re-published to peers, and clears itself from the local set on the next TTL prune. This is
  // what recovers a device that restored a hostile snapshot on a build predating that guard.
  const tombstones: Tombstone[] = tombstoneRows
    .filter((t) => isTombstoneTable(t.table_name))
    .map((t) => ({
      tableName: t.table_name,
      id: t.id,
      deletedAt: Number(t.deleted_at),
    }));

  const gaugeHistory = await readGaugeHistory(driver);
  const itemTags = await readItemTags(driver);
  const locationTags = await readLocationTags(driver);
  const itemRegions = await readItemRegions(driver);
  const itemHistory = await readItemHistory(driver);

  return {
    formatVersion: SYNC_FORMAT_VERSION,
    generatedAt,
    tables,
    tombstones,
    gaugeHistory,
    itemTags,
    locationTags,
    itemRegions,
    itemHistory,
  };
}

/**
 * Shift every Last-Write-Wins timestamp in a snapshot by `delta` (§7.3.1).
 *
 * The local database always stores timestamps in the device's own clock frame, but the wire must
 * carry them in the *server's* frame so every device's LWW comparisons share one timeline —
 * otherwise a device whose clock is off by X pushes rows off by X, and peers pick the wrong winner
 * by up to X. The engine bridges the two frames with this one function:
 *   - on **push**, `delta = +offset` converts local → server time;
 *   - on **fetch**, `delta = −offset` converts the remote back to this device's local frame,
 *     so everything downstream (reconcile, applyPlan, the DB) works in one consistent frame.
 *
 * Only the fields LWW actually resolves on are shifted: each row's `updated_at` and each
 * tombstone's `deleted_at`. `created_at`, the gauge/`item_history` ledgers (resolved by id-union
 * and commutative delta sums, not by timestamp comparison) and the timestamp-less `item_tags`
 * edges are deliberately left untouched — their ordering is cosmetic and frame-shifting them would
 * be needless churn. A `delta` of 0 (a provider with no server clock, the common case) returns the
 * snapshot unchanged, so those providers and their tests are entirely unaffected.
 */
export function shiftSnapshotTimestamps(snapshot: SyncSnapshot, delta: number): SyncSnapshot {
  if (delta === 0) return snapshot;
  const tables: Record<string, SqlRow[]> = {};
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    tables[table] = rows.map((row) =>
      'updated_at' in row ? { ...row, updated_at: Number(row.updated_at) + delta } : row,
    );
  }
  return {
    ...snapshot,
    tables,
    tombstones: snapshot.tombstones.map((t) => ({ ...t, deletedAt: t.deletedAt + delta })),
  };
}

/** Read the M:N `item_tags` membership edges (Phase 11; no row id/timestamp). */
async function readItemTags(driver: IDatabaseDriver): Promise<ItemTagEdge[]> {
  const rows = await driver.query<{ item_id: string; tag_id: string }>(
    `SELECT item_id, tag_id FROM ${ITEM_TAGS_TABLE} ORDER BY item_id, tag_id;`,
  );
  return rows.map((r) => ({ itemId: r.item_id, tagId: r.tag_id }));
}

/** Read the M:N `location_tags` membership edges (issue #84; no row id/timestamp). */
async function readLocationTags(driver: IDatabaseDriver): Promise<LocationTagEdge[]> {
  const rows = await driver.query<{ location_id: string; tag_id: string }>(
    `SELECT location_id, tag_id FROM ${LOCATION_TAGS_TABLE} ORDER BY location_id, tag_id;`,
  );
  return rows.map((r) => ({ locationId: r.location_id, tagId: r.tag_id }));
}

/** Read the M:N `item_regions` membership edges (issue #81; no row id/timestamp). */
async function readItemRegions(driver: IDatabaseDriver): Promise<ItemRegionEdge[]> {
  const rows = await driver.query<{ item_id: string; region_id: string }>(
    `SELECT item_id, region_id FROM ${ITEM_REGIONS_TABLE} ORDER BY item_id, region_id;`,
  );
  return rows.map((r) => ({ itemId: r.item_id, regionId: r.region_id }));
}

/** Read the full append-only `item_history` ledger (Phase 11; union-by-id). */
async function readItemHistory(driver: IDatabaseDriver): Promise<SqlRow[]> {
  const all: SqlRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await driver.query<SqlRow>(
      `SELECT * FROM ${ITEM_HISTORY_TABLE} ORDER BY created_at, id LIMIT ? OFFSET ?;`,
      [PAGE, offset],
    );
    all.push(...rows);
    if (rows.length < PAGE) break;
  }
  return all;
}

/** The net-value deltas from the Activity Ledger that the Delta-CRDT replays (§7.3). */
async function readGaugeHistory(driver: IDatabaseDriver): Promise<GaugeHistoryDelta[]> {
  const rows = await driver.query<{
    id: string;
    item_id: string;
    net_value_delta: number;
    created_at: number;
  }>(
    `SELECT id, item_id, net_value_delta, created_at
     FROM item_history
     WHERE net_value_delta IS NOT NULL
     ORDER BY created_at;`,
  );
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    netValueDelta: Number(r.net_value_delta),
    createdAt: Number(r.created_at),
  }));
}

/**
 * Reject a `tableName` that is not on the {@link TOMBSTONE_TABLES} allow-list.
 *
 * Deliberately fails the whole batch rather than skipping the offending tombstone: a snapshot
 * carrying a name that is not a real table is not a snapshot with one bad row in it, it is a
 * snapshot that did not come from Gubbins. Silently dropping the row would apply the *rest* of
 * a hostile payload and report success.
 */
function assertTombstoneTable(tableName: string): void {
  if (!isTombstoneTable(tableName)) {
    throw new Error(`Refusing to apply a tombstone for an unrecognised table: ${JSON.stringify(tableName)}`);
  }
}

/**
 * The column set to write for `table`, from the live schema read off the database.
 *
 * There is deliberately **no** fallback to the incoming row's own keys. Column names are
 * interpolated into the INSERT (SQLite cannot parameterise an identifier), so falling back to
 * `Object.keys(row)` would let a crafted snapshot choose its own SQL fragments — the same
 * exposure as an unvalidated tombstone `tableName`. Every caller builds its dictionary from
 * {@link buildSchemaDictionary} over a fixed table list, so a missing entry is a programming
 * error, and the safe response to one is to stop.
 */
export function requireColumns(dictionary: SchemaDictionary, table: string): readonly string[] {
  const columns = dictionary[table];
  if (!columns) throw new Error(`No schema dictionary entry for table: ${JSON.stringify(table)}`);
  return columns;
}

/** Build the UPSERT for a row given its table's column set. */
function upsertStatement(table: SyncTable, snapshotRow: SqlRow, columns: readonly string[]): SqlStatement {
  // Decode any base64 BLOB (item_images thumbnail) back to bytes for the DB write.
  const row = decodeRowForTable(table, snapshotRow);
  // Only persist columns the local schema actually has (defence in depth alongside
  // the engine's sanitisation). `id` is always the conflict target.
  const cols = columns.filter((c) => c in row);
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols
    .filter((c) => c !== 'id')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ');
  const sql =
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ` +
    `ON CONFLICT(id) DO UPDATE SET ${updates};`;
  return { sql, params: cols.map((c) => row[c] as SqlValue) };
}

/**
 * The DELETE that applies one tombstone to its table. `item_tags` edge tombstones use a
 * composite `itemId|tagId` id (the join has no `id` column), so they delete by the pair;
 * every other table deletes by primary-key `id` (Phase 11).
 *
 * `tableName` is checked against the {@link TOMBSTONE_TABLES} allow-list first, because it
 * has to be interpolated (SQLite cannot parameterise an identifier) and it reaches here from
 * parsed JSON on the restore, sync and bridge-push paths. {@link assertTombstoneTable} is the
 * last line of defence: {@link parseBackupJson} already rejects a bad name at the boundary, so
 * a throw here means a snapshot arrived by some other route and must not be applied.
 */
export function tombstoneDeleteStatement(tableName: string, id: string): SqlStatement {
  assertTombstoneTable(tableName);
  if (tableName === ITEM_TAGS_TABLE) {
    const { itemId, tagId } = parseItemTagEdgeId(id);
    return {
      sql: `DELETE FROM ${ITEM_TAGS_TABLE} WHERE item_id = ? AND tag_id = ?;`,
      params: [itemId, tagId],
    };
  }
  if (tableName === LOCATION_TAGS_TABLE) {
    const { locationId, tagId } = parseLocationTagEdgeId(id);
    return {
      sql: `DELETE FROM ${LOCATION_TAGS_TABLE} WHERE location_id = ? AND tag_id = ?;`,
      params: [locationId, tagId],
    };
  }
  if (tableName === ITEM_REGIONS_TABLE) {
    const { itemId, regionId } = parseItemRegionEdgeId(id);
    return {
      sql: `DELETE FROM ${ITEM_REGIONS_TABLE} WHERE item_id = ? AND region_id = ?;`,
      params: [itemId, regionId],
    };
  }
  return { sql: `DELETE FROM ${tableName} WHERE id = ?;`, params: [id] };
}

/**
 * Build the INSERT OR IGNORE for an append-only `item_history` row (union-by-id).
 *
 * `columns` must come from the live schema — see {@link requireColumns} for why there is no
 * fallback to the row's own keys.
 */
export function historyInsertStatement(row: SqlRow, columns: readonly string[] | undefined): SqlStatement {
  if (!columns) {
    throw new Error(`No schema dictionary entry for table: ${JSON.stringify(ITEM_HISTORY_TABLE)}`);
  }
  const cols = columns.filter((c) => c in row);
  const placeholders = cols.map(() => '?').join(', ');
  return {
    sql: `INSERT OR IGNORE INTO ${ITEM_HISTORY_TABLE} (${cols.join(', ')}) VALUES (${placeholders});`,
    params: cols.map((c) => row[c] as SqlValue),
  };
}

/**
 * A RE_PARENTED Activity-Ledger entry for a §7.5.2 sync re-parent.
 *
 * Attributed to the System user explicitly (issue #79, plan §2.4): no person asked for this
 * re-parent — the merge did it to repair a location removed on another device.
 */
function reparentHistoryStatement(itemId: string): SqlStatement {
  return historyStatement(itemId, 'RE_PARENTED', SYSTEM_USER_ID, {
    note: 'Location sync conflict: re-parented to Unassigned as the target location was removed.',
  });
}

/**
 * Apply a reconciliation plan in one atomic transaction (§7.3 step 3). Upserts run
 * parent→child (FK-safe), then deletes child→parent (each delete also records the
 * winning tombstone locally), then the §7.3 gauge corrections, then the §7.5.2
 * re-parent conflict logs.
 */
export async function applyPlan(
  driver: IDatabaseDriver,
  plan: ReconciliationPlan,
  dictionary: SchemaDictionary,
): Promise<void> {
  const tableIndex = (t: string) => SYNC_TABLES.indexOf(t as SyncTable);
  const statements: SqlStatement[] = [];

  // Issue #187: retire ids that lost a non-primary-key UNIQUE index to a peer's row. This
  // runs FIRST, ahead of the upserts, because the winner's INSERT would otherwise hit the
  // losing row still holding the natural key — the `ON CONFLICT(id)` target does not cover a
  // name/composite index, so the constraint would abort the whole atomic merge. Rows that
  // referenced the loser are cascaded away here and re-inserted against the winner by the
  // repointed upserts below, which is what merges the two devices' associations into one.
  // Issue #79: a retired *user* needs its ledger rows moved to the winner before it goes, or
  // `actor_user_id`'s ON DELETE SET DEFAULT silently re-attributes this device's history to
  // System — losing the very attribution the column exists to record. That repoint needs the
  // winner to already exist, while the delete must precede the winner's INSERT (they share the
  // username index). The cycle is broken by freeing the username here and deferring the delete
  // itself until after the upserts, below.
  const deferredUserRetirements: { loserId: string; winnerId: string }[] = [];

  for (const { table, loserId, winnerId, deletedAt } of plan.collisions) {
    if (table === 'users') {
      // Park the loser on a guaranteed-unique username (its own id) so the winner's INSERT
      // can take the real one. The row is deleted a few statements later, in this same
      // transaction, so the parked value is never observable.
      statements.push({
        sql: 'UPDATE users SET username = ? WHERE id = ?;',
        params: [loserId, loserId],
      });
      deferredUserRetirements.push({ loserId, winnerId });
    } else {
      statements.push(tombstoneDeleteStatement(table, loserId));
    }
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [table, loserId, deletedAt],
    });
  }

  // UPSERTs, parents before children.
  const upserts = [...plan.localUpserts].sort((a, b) => tableIndex(a.table) - tableIndex(b.table));
  for (const { table, row } of upserts) {
    statements.push(upsertStatement(table, row, requireColumns(dictionary, table)));
  }

  // Issue #79: the winner now exists, so a retired user's ledger rows can follow it before
  // that user is removed. The ledger's immutability trigger is scoped to the substantive
  // columns, so re-attributing an entry is permitted — the facts of what happened are
  // untouched. `reconcile` performs the mirror-image remap on rows arriving from the peer.
  for (const { loserId, winnerId } of deferredUserRetirements) {
    statements.push({
      sql: `UPDATE ${ITEM_HISTORY_TABLE} SET actor_user_id = ? WHERE actor_user_id = ?;`,
      params: [winnerId, loserId],
    });
    statements.push(tombstoneDeleteStatement('users', loserId));
  }

  // Phase 11: append-only ledger union-by-id. INSERT OR IGNORE so an id we already hold
  // is untouched (the immutable trigger only guards UPDATE; a PK clash is simply skipped).
  // Runs after the LWW upserts so the parent items exist (FK-safe).
  for (const row of plan.historyInserts) {
    statements.push(historyInsertStatement(row, dictionary[ITEM_HISTORY_TABLE]));
  }

  // Phase 11: item_tags membership additions (after tags + items exist, FK-safe). Clear
  // any stale edge tombstone so the edge is genuinely present in the merged set.
  for (const { itemId, tagId } of plan.itemTagUpserts) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_TAGS_TABLE} (item_id, tag_id) VALUES (?, ?);`,
      params: [itemId, tagId],
    });
    statements.push(clearItemTagTombstoneStatement(itemId, tagId));
  }

  // Phase 11: item_tags membership removals — delete the edge + record its tombstone.
  for (const { itemId, tagId, deletedAt } of plan.itemTagDeletes) {
    statements.push({
      sql: `DELETE FROM ${ITEM_TAGS_TABLE} WHERE item_id = ? AND tag_id = ?;`,
      params: [itemId, tagId],
    });
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [ITEM_TAGS_TABLE, itemTagEdgeId(itemId, tagId), deletedAt],
    });
  }

  // Issue #84: location_tags membership additions (after tags + locations exist, FK-safe).
  for (const { locationId, tagId } of plan.locationTagUpserts) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${LOCATION_TAGS_TABLE} (location_id, tag_id) VALUES (?, ?);`,
      params: [locationId, tagId],
    });
    statements.push(clearLocationTagTombstoneStatement(locationId, tagId));
  }

  // Issue #84: location_tags membership removals — delete the edge + record its tombstone.
  for (const { locationId, tagId, deletedAt } of plan.locationTagDeletes) {
    statements.push({
      sql: `DELETE FROM ${LOCATION_TAGS_TABLE} WHERE location_id = ? AND tag_id = ?;`,
      params: [locationId, tagId],
    });
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [LOCATION_TAGS_TABLE, locationTagEdgeId(locationId, tagId), deletedAt],
    });
  }

  // Issue #81: item_regions membership additions. Ordered after the LWW upserts so both
  // endpoints (the item and the region's photo chain) already exist — the edge has NOT NULL
  // cascade FKs at both ends, so an early INSERT would trip them.
  for (const { itemId, regionId } of plan.itemRegionUpserts) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_REGIONS_TABLE} (item_id, region_id) VALUES (?, ?);`,
      params: [itemId, regionId],
    });
    statements.push(clearItemRegionTombstoneStatement(itemId, regionId));
  }

  // Issue #81: item_regions membership removals — delete the edge + record its tombstone.
  for (const { itemId, regionId, deletedAt } of plan.itemRegionDeletes) {
    statements.push({
      sql: `DELETE FROM ${ITEM_REGIONS_TABLE} WHERE item_id = ? AND region_id = ?;`,
      params: [itemId, regionId],
    });
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [ITEM_REGIONS_TABLE, itemRegionEdgeId(itemId, regionId), deletedAt],
    });
  }

  // DELETEs, children before parents; each also tombstoned locally so the merged
  // state (and the pushed snapshot) carries the deletion.
  const deletes = [...plan.localDeletes].sort((a, b) => tableIndex(b.tableName) - tableIndex(a.tableName));
  for (const del of deletes) {
    if (del.tableName === 'locations') {
      // Per-batch stock ledger (Phase 28 — `stock_batches` is the SSOT below `item_stock`):
      // re-home every batch at a removed location into the item's Unassigned placement,
      // preserving each lot's identity, before the location's RESTRICT foreign key can block
      // its tombstone DELETE. The recompute triggers re-derive item_stock then items.quantity
      // at Unassigned; the deleted location's batch and (now-empty) placement rows are then
      // dropped. Mirrors the §7.5.2 item re-parent and the local LocationRepository.delete.
      statements.push({
        sql: `INSERT INTO stock_batches
                (id, item_id, location_id, batch_key, batch_number, lot_number, expiry_date, quantity)
              SELECT item_id || '|' || ? || '|' || batch_key, item_id, ?, batch_key,
                     batch_number, lot_number, expiry_date, quantity
              FROM stock_batches WHERE location_id = ? AND quantity > 0
              ON CONFLICT(id) DO UPDATE SET quantity = stock_batches.quantity + excluded.quantity;`,
        params: [UNASSIGNED_LOCATION_ID, UNASSIGNED_LOCATION_ID, del.id],
      });
      statements.push({ sql: 'DELETE FROM stock_batches WHERE location_id = ?;', params: [del.id] });
      statements.push({ sql: 'DELETE FROM item_stock WHERE location_id = ?;', params: [del.id] });
      // Clear the lend-from pointer on any local checkout drawn from the removed location
      // (Phase 26): its nullable RESTRICT FK would otherwise block the tombstone DELETE,
      // and a return now falls back to the item's primary location (mirrors the local
      // LocationRepository.delete null-out and the FK_REFS guard for *incoming* checkouts).
      statements.push({
        sql: 'UPDATE checkouts SET source_location_id = NULL WHERE source_location_id = ?;',
        params: [del.id],
      });
      // Clear the per-location scope on any maintenance schedule pinned to the removed
      // location (Phase 30): its nullable RESTRICT FK would otherwise block the tombstone
      // DELETE, and the schedule reverts to item-level (mirrors the local
      // LocationRepository.delete null-out and the FK_REFS guard for *incoming* schedules).
      statements.push({
        sql: 'UPDATE maintenance_schedules SET location_id = NULL WHERE location_id = ?;',
        params: [del.id],
      });
    }
    statements.push(tombstoneDeleteStatement(del.tableName, del.id));
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [del.tableName, del.id, del.deletedAt],
    });
  }

  // §7.3 Delta-CRDT gauge corrections.
  for (const { itemId, netValue } of plan.gaugeResolutions) {
    statements.push({
      sql: 'UPDATE items SET current_net_value = ? WHERE id = ?;',
      params: [netValue, itemId],
    });
  }

  // §7.5.2 conflict logs.
  for (const { itemId } of plan.reparented) {
    statements.push(reparentHistoryStatement(itemId));
  }

  if (statements.length > 0) await driver.transaction(statements);
}

/**
 * Statements that wipe the syncable tables (sparing the system-locked locations,
 * whose protect triggers reject a DELETE) and clone `remote` wholesale, including its
 * tombstones. Used by the §7.2 TTL clone-with-salvage.
 *
 * `historyPrunedBefore` (§7.6.3-A, Phase 14): the rare full-clone path would otherwise
 * adopt the remote ledger wholesale and re-pull an era this device deliberately pruned
 * to reclaim OPFS space. Filtering the cloned `itemHistory` by the local watermark keeps
 * that space reclaimed — matching the delta-sync guard in {@link reconcile}. Defaults to
 * 0 (no filtering).
 */
export function buildCloneStatements(
  remote: SyncSnapshot,
  dictionary: SchemaDictionary,
  historyPrunedBefore = 0,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
  // Clear the non-LWW sections first (they would otherwise cascade away when items are
  // deleted, but doing it explicitly keeps the wipe order-independent — Phase 11).
  statements.push({ sql: `DELETE FROM ${ITEM_HISTORY_TABLE};` });
  statements.push({ sql: `DELETE FROM ${ITEM_TAGS_TABLE};` });
  statements.push({ sql: `DELETE FROM ${LOCATION_TAGS_TABLE};` });
  statements.push({ sql: `DELETE FROM ${ITEM_REGIONS_TABLE};` });
  for (const table of [...SYNC_TABLES].reverse()) {
    statements.push({ sql: `DELETE FROM ${table} ${WIPE_FILTER[table] ?? ''};`.replace(/\s+;$/, ';') });
  }
  statements.push({ sql: 'DELETE FROM tombstones;' });

  for (const table of SYNC_TABLES) {
    for (const snapshotRow of remote.tables[table] ?? []) {
      const row = decodeRowForTable(table, snapshotRow);
      const cols = requireColumns(dictionary, table).filter((c) => c in row);
      statements.push({
        sql: `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`,
        params: cols.map((c) => row[c] as SqlValue),
      });
    }
  }
  // Append-only ledger (union-by-id) + M:N membership edges, after their parents exist.
  // §7.6.3-A: skip rows older than the local prune watermark so a clone never re-pulls a
  // deliberately-pruned era.
  for (const row of remote.itemHistory ?? []) {
    if (Number(row.created_at) < historyPrunedBefore) continue;
    statements.push(historyInsertStatement(row, dictionary[ITEM_HISTORY_TABLE]));
  }
  for (const { itemId, tagId } of remote.itemTags ?? []) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_TAGS_TABLE} (item_id, tag_id) VALUES (?, ?);`,
      params: [itemId, tagId],
    });
  }
  for (const { locationId, tagId } of remote.locationTags ?? []) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${LOCATION_TAGS_TABLE} (location_id, tag_id) VALUES (?, ?);`,
      params: [locationId, tagId],
    });
  }
  for (const { itemId, regionId } of remote.itemRegions ?? []) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_REGIONS_TABLE} (item_id, region_id) VALUES (?, ?);`,
      params: [itemId, regionId],
    });
  }
  for (const t of remote.tombstones) {
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [t.tableName, t.id, t.deletedAt],
    });
  }
  return statements;
}

/**
 * §2 manual import/restore: merge a versioned snapshot (e.g. a backup file) into the
 * database in one atomic transaction. **Non-destructive** — it UPSERTs every row from
 * the backup (re-creating anything that was deleted, overwriting by id) and adopts the
 * backup's deletion view, but deliberately uses UPSERT rather than a bare table wipe so
 * it cannot cascade-delete data the snapshot does not carry. Phase 11 widened the
 * carried set: the Activity Ledger (`item_history`, unioned by id), the M:N membership
 * (`item_tags`, unioned then pruned by the backup's edge tombstones) and images
 * (`item_images` thumbnails, base64-decoded) now restore too. Full-res OPFS bytes are
 * still excluded (§4.2 strict isolation — the §4.5 vault / raw export carry those). The
 * backup's tombstone view replaces the local one so an imported row is not re-deleted by
 * a stale local tombstone on the next sync.
 */
export async function restoreSnapshot(driver: IDatabaseDriver, snapshot: SyncSnapshot): Promise<void> {
  const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
  const statements: SqlStatement[] = [];

  for (const table of SYNC_TABLES) {
    for (const snapshotRow of snapshot.tables[table] ?? []) {
      const row = decodeRowForTable(table, snapshotRow);
      const cols = requireColumns(dictionary, table).filter((c) => c in row);
      const updates = cols
        .filter((c) => c !== 'id')
        .map((c) => `${c} = excluded.${c}`)
        .join(', ');
      statements.push({
        sql:
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ` +
          `ON CONFLICT(id) DO UPDATE SET ${updates};`,
        params: cols.map((c) => row[c] as SqlValue),
      });
    }
  }

  // Append-only ledger (union-by-id) + M:N membership edges (union; the backup's edge
  // tombstones below remove any that were unlinked).
  for (const row of snapshot.itemHistory ?? []) {
    statements.push(historyInsertStatement(row, dictionary[ITEM_HISTORY_TABLE]));
  }
  for (const { itemId, tagId } of snapshot.itemTags ?? []) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_TAGS_TABLE} (item_id, tag_id) VALUES (?, ?);`,
      params: [itemId, tagId],
    });
  }
  for (const { locationId, tagId } of snapshot.locationTags ?? []) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${LOCATION_TAGS_TABLE} (location_id, tag_id) VALUES (?, ?);`,
      params: [locationId, tagId],
    });
  }
  for (const { itemId, regionId } of snapshot.itemRegions ?? []) {
    statements.push({
      sql: `INSERT OR IGNORE INTO ${ITEM_REGIONS_TABLE} (item_id, region_id) VALUES (?, ?);`,
      params: [itemId, regionId],
    });
  }

  // Adopt the backup's deletion view: clear local tombstones, apply the backup's
  // (item_tags edge tombstones delete by the composite pair, not an id).
  statements.push({ sql: 'DELETE FROM tombstones;' });
  for (const t of snapshot.tombstones) {
    statements.push(tombstoneDeleteStatement(t.tableName, t.id));
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [t.tableName, t.id, t.deletedAt],
    });
  }

  await driver.transaction(statements);
}

export { buildSchemaDictionary, SYNC_TABLES, UNASSIGNED_LOCATION_ID };
