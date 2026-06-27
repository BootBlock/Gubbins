/**
 * Building & applying the sync snapshot (spec §7.3, §7.5, Phase 7).
 *
 * {@link buildLocalSnapshot} reads the full row set of every syncable table (paging
 * the worker bridge at ≤100 per §2.1), the tombstones (§7.2) and the gauge net-value
 * deltas the §7.3 Delta-CRDT needs. {@link applyPlan} turns a {@link ReconciliationPlan}
 * into the single atomic `BEGIN…COMMIT` of UPSERTs/DELETEs/gauge-updates/conflict-logs
 * the spec mandates. The pure {@link reconcile} engine sits between the two.
 */
import { SYNC_TABLES, UNASSIGNED_LOCATION_ID } from '@/db/repositories';
import type { IDatabaseDriver, SqlRow, SqlStatement, SqlValue } from '@/db/rpc/driver';
import { buildSchemaDictionary } from './schema-dictionary';
import type {
  GaugeHistoryDelta,
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

/** Build the full local snapshot for diffing/pushing/back-up (§7.3, §2). */
export async function buildLocalSnapshot(
  driver: IDatabaseDriver,
  generatedAt = Date.now(),
): Promise<SyncSnapshot> {
  const tables: Record<string, SqlRow[]> = {};
  for (const table of SYNC_TABLES) {
    tables[table] = await readAllRows(driver, table);
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

  return { formatVersion: SYNC_FORMAT_VERSION, generatedAt, tables, tombstones, gaugeHistory };
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
function upsertStatement(table: SyncTable, row: SqlRow, columns: readonly string[]): SqlStatement {
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

  // DELETEs, children before parents; each also tombstoned locally so the merged
  // state (and the pushed snapshot) carries the deletion.
  const deletes = [...plan.localDeletes].sort((a, b) => tableIndex(b.tableName) - tableIndex(a.tableName));
  for (const del of deletes) {
    statements.push({ sql: `DELETE FROM ${del.tableName} WHERE id = ?;`, params: [del.id] });
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
 * tombstones. Shared by the §7.2 TTL clone-with-salvage and the §2 restore-from-backup.
 */
export function buildCloneStatements(
  remote: SyncSnapshot,
  dictionary: SchemaDictionary,
): SqlStatement[] {
  const statements: SqlStatement[] = [];
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
    for (const row of remote.tables[table] ?? []) {
      const cols = (dictionary[table] ?? Object.keys(row)).filter((c) => c in row);
      statements.push({
        sql: `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`,
        params: cols.map((c) => row[c] as SqlValue),
      });
    }
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
 * it cannot cascade-delete child data the JSON snapshot does not carry (image blobs,
 * the Activity Ledger, M:N joins — outside the synced set; see deferred-features). The
 * backup's tombstone view replaces the local one so an imported row is not re-deleted by
 * a stale local tombstone on the next sync.
 */
export async function restoreSnapshot(
  driver: IDatabaseDriver,
  snapshot: SyncSnapshot,
): Promise<void> {
  const dictionary = await buildSchemaDictionary(driver, SYNC_TABLES);
  const statements: SqlStatement[] = [];

  for (const table of SYNC_TABLES) {
    for (const row of snapshot.tables[table] ?? []) {
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

  // Adopt the backup's deletion view: clear local tombstones, apply the backup's.
  statements.push({ sql: 'DELETE FROM tombstones;' });
  for (const t of snapshot.tombstones) {
    statements.push({ sql: `DELETE FROM ${t.tableName} WHERE id = ?;`, params: [t.id] });
    statements.push({
      sql: 'INSERT OR REPLACE INTO tombstones (table_name, id, deleted_at) VALUES (?, ?, ?);',
      params: [t.tableName, t.id, t.deletedAt],
    });
  }

  await driver.transaction(statements);
}

export { buildSchemaDictionary, SYNC_TABLES, UNASSIGNED_LOCATION_ID };
