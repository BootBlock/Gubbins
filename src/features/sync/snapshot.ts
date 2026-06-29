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
  ITEM_TAGS_TABLE,
  SYNC_EXCLUDED_COLUMNS,
  SYNC_TABLES,
  UNASSIGNED_LOCATION_ID,
  clearItemTagTombstoneStatement,
  itemTagEdgeId,
  parseItemTagEdgeId,
} from '@/db/repositories';
import type { IDatabaseDriver, SqlRow, SqlStatement, SqlValue } from '@/db/rpc/driver';
import { decodeRowForTable, encodeRowForTable } from './blob-codec';
import { buildSchemaDictionary } from './schema-dictionary';
import type {
  GaugeHistoryDelta,
  ItemTagEdge,
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
};

/** Read every row of a table, paging the worker bridge (§2.1). */
async function readAllRows(driver: IDatabaseDriver, table: SyncTable): Promise<SqlRow[]> {
  const where = TABLE_FILTER[table] ?? '';
  const all: SqlRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await driver.query<SqlRow>(
      `SELECT * FROM ${table} ${where} ORDER BY id LIMIT ? OFFSET ?;`,
      [PAGE, offset],
    );
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
  const tombstones: Tombstone[] = tombstoneRows.map((t) => ({
    tableName: t.table_name,
    id: t.id,
    deletedAt: Number(t.deleted_at),
  }));

  const gaugeHistory = await readGaugeHistory(driver);
  const itemTags = await readItemTags(driver);
  const itemHistory = await readItemHistory(driver);

  return {
    formatVersion: SYNC_FORMAT_VERSION,
    generatedAt,
    tables,
    tombstones,
    gaugeHistory,
    itemTags,
    itemHistory,
  };
}

/** Read the M:N `item_tags` membership edges (Phase 11; no row id/timestamp). */
async function readItemTags(driver: IDatabaseDriver): Promise<ItemTagEdge[]> {
  const rows = await driver.query<{ item_id: string; tag_id: string }>(
    `SELECT item_id, tag_id FROM ${ITEM_TAGS_TABLE} ORDER BY item_id, tag_id;`,
  );
  return rows.map((r) => ({ itemId: r.item_id, tagId: r.tag_id }));
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
 */
export function tombstoneDeleteStatement(tableName: string, id: string): SqlStatement {
  if (tableName === ITEM_TAGS_TABLE) {
    const { itemId, tagId } = parseItemTagEdgeId(id);
    return {
      sql: `DELETE FROM ${ITEM_TAGS_TABLE} WHERE item_id = ? AND tag_id = ?;`,
      params: [itemId, tagId],
    };
  }
  return { sql: `DELETE FROM ${tableName} WHERE id = ?;`, params: [id] };
}

/** Build the INSERT OR IGNORE for an append-only `item_history` row (union-by-id). */
export function historyInsertStatement(
  row: SqlRow,
  columns: readonly string[] | undefined,
): SqlStatement {
  const cols = (columns ?? Object.keys(row)).filter((c) => c in row);
  const placeholders = cols.map(() => '?').join(', ');
  return {
    sql: `INSERT OR IGNORE INTO ${ITEM_HISTORY_TABLE} (${cols.join(', ')}) VALUES (${placeholders});`,
    params: cols.map((c) => row[c] as SqlValue),
  };
}

/** A RE_PARENTED Activity-Ledger entry for a §7.5.2 sync re-parent. */
function reparentHistoryStatement(itemId: string): SqlStatement {
  return {
    sql: `INSERT INTO item_history (id, item_id, action, note)
          VALUES (?, ?, 'RE_PARENTED', ?);`,
    params: [
      crypto.randomUUID(),
      itemId,
      'Location sync conflict: re-parented to Unassigned as the target location was removed.',
    ],
  };
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

  // UPSERTs, parents before children.
  const upserts = [...plan.localUpserts].sort((a, b) => tableIndex(a.table) - tableIndex(b.table));
  for (const { table, row } of upserts) {
    statements.push(upsertStatement(table, row, dictionary[table] ?? Object.keys(row)));
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
  for (const table of [...SYNC_TABLES].reverse()) {
    statements.push({
      sql:
        table === 'locations'
          ? 'DELETE FROM locations WHERE is_system = 0;'
          : `DELETE FROM ${table};`,
    });
  }
  statements.push({ sql: 'DELETE FROM tombstones;' });

  for (const table of SYNC_TABLES) {
    for (const snapshotRow of remote.tables[table] ?? []) {
      const row = decodeRowForTable(table, snapshotRow);
      const cols = (dictionary[table] ?? Object.keys(row)).filter((c) => c in row);
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
export async function restoreSnapshot(
  driver: IDatabaseDriver,
  snapshot: SyncSnapshot,
): Promise<void> {
  const dictionary = await buildSchemaDictionary(driver, [...SYNC_TABLES, ITEM_HISTORY_TABLE]);
  const statements: SqlStatement[] = [];

  for (const table of SYNC_TABLES) {
    for (const snapshotRow of snapshot.tables[table] ?? []) {
      const row = decodeRowForTable(table, snapshotRow);
      const cols = (dictionary[table] ?? Object.keys(row)).filter((c) => c in row);
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
