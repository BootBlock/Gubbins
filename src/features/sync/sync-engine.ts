/**
 * The sync orchestrator (spec §7.2, §7.3, §7.4, Phase 7).
 *
 * Ties the pure {@link reconcile} engine to the database driver, a {@link CloudProvider}
 * and the storage safeguards. The reconciliation logic itself stays pure & tested;
 * everything browser-only (storage estimate, the provider transport) is injected or
 * feature-detected so the whole flow is exercisable on the `:memory:` driver.
 *
 * Normal lifecycle (§7.3): pre-flight quota Hard Stop (§7.4) → server-time offset
 * guard (§7.3.1) → fetch remote → reconcile → apply atomically → re-read & push the
 * merged snapshot → prune expired tombstones (§7.2 TTL) → stamp `sync_meta`.
 *
 * TTL edge (§7.2): a device whose `last_sync_timestamp` predates the 180-day
 * Tombstone TTL cannot trust delta reconciliation (the remote may have pruned the
 * tombstones it needs), so it performs a **Pre-Wipe Salvage** — capture local
 * mutations since the last sync, clone the remote wholesale, then re-apply the
 * salvaged work as local-wins — rather than a blind wipe.
 */
import type { IDatabaseDriver, SqlRow, SqlStatement, SqlValue } from '@/db/rpc/driver';
import { SYNC_TABLES } from '@/db/repositories';
import { estimateStorage } from '@/features/storage/storage-api';
import { STORAGE_THRESHOLDS } from '@/features/storage/tiers';
import { computeClockOffset } from './clock';
import type { CloudProvider } from './provider';
import { reconcile } from './reconcile';
import { buildSchemaDictionary } from './schema-dictionary';
import { applyPlan, buildCloneStatements, buildLocalSnapshot } from './snapshot';
import type { SchemaDictionary, SyncSnapshot, SyncTable, Tombstone } from './types';

/** §7.2 Tombstone TTL: 180 days in milliseconds. */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export interface SyncResult {
  readonly status: 'SYNCED' | 'PUBLISHED' | 'CLONED' | 'HARD_STOP';
  /** Rows upserted locally from the remote. */
  readonly pulled: number;
  /** Rows deleted locally by winning remote tombstones. */
  readonly deleted: number;
  /** §7.5.2 items automatically re-parented to Unassigned. */
  readonly reparented: number;
  /** §7.5.3 location moves discarded to avoid a cycle. */
  readonly rejectedCycles: number;
  /** Expired tombstones pruned (§7.2 TTL). */
  readonly prunedTombstones: number;
  /** The clock offset applied (ms, server − local). */
  readonly clockOffset: number;
  /** Present when status is HARD_STOP. */
  readonly message?: string;
}

export interface SyncMeta {
  readonly lastSyncTimestamp: number;
  readonly clockOffset: number;
}

/** §7.2: must we full-clone rather than delta-reconcile? */
export function needsFullResync(
  lastSyncTimestamp: number,
  serverNow: number,
  ttlMs = TOMBSTONE_TTL_MS,
): boolean {
  if (lastSyncTimestamp <= 0) return false; // never synced — the normal path handles it
  return serverNow - lastSyncTimestamp > ttlMs;
}

async function readSyncMeta(driver: IDatabaseDriver): Promise<SyncMeta> {
  const row = await driver.queryOne<{ last_sync_timestamp: number; clock_offset: number }>(
    'SELECT last_sync_timestamp, clock_offset FROM sync_meta WHERE id = 1;',
  );
  return {
    lastSyncTimestamp: Number(row?.last_sync_timestamp ?? 0),
    clockOffset: Number(row?.clock_offset ?? 0),
  };
}

async function writeSyncMeta(
  driver: IDatabaseDriver,
  lastSyncTimestamp: number,
  clockOffset: number,
): Promise<void> {
  await driver.execute(
    'UPDATE sync_meta SET last_sync_timestamp = ?, clock_offset = ? WHERE id = 1;',
    [lastSyncTimestamp, clockOffset],
  );
}

export interface RunSyncOptions {
  /** Override the local clock (tests). */
  readonly now?: () => number;
  /**
   * Skip the §7.4 pre-flight quota check (tests / environments without the Storage
   * API). Production leaves this false so a near-full origin triggers the Hard Stop.
   */
  readonly skipQuotaCheck?: boolean;
  /** Override the Tombstone TTL (tests). */
  readonly ttlMs?: number;
}

/**
 * Run one synchronisation pass against `provider`. Returns a {@link SyncResult};
 * never throws for the expected Hard-Stop case (returns `status: 'HARD_STOP'`).
 */
export async function runSync(
  driver: IDatabaseDriver,
  provider: CloudProvider,
  options: RunSyncOptions = {},
): Promise<SyncResult> {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? TOMBSTONE_TTL_MS;

  // --- §7.4 pre-flight quota Hard Stop ------------------------------------------
  if (!options.skipQuotaCheck) {
    const estimate = await estimateStorage();
    if (estimate.supported && estimate.ratio >= STORAGE_THRESHOLDS.critical) {
      return hardStop(
        `Storage is ${(estimate.ratio * 100).toFixed(0)}% full — sync aborted to avoid eviction. Free space and retry.`,
      );
    }
  }

  // --- §7.3.1 NTP offset guard --------------------------------------------------
  const localNow = now();
  const serverNow = await provider.getServerTime();
  const offset = computeClockOffset(serverNow, localNow);
  const effectiveNow = serverNow ?? localNow;

  const dictionary = await buildSchemaDictionary(driver, SYNC_TABLES);
  const remote = await provider.fetchSnapshot();

  // First publish: no remote yet — just push our state.
  if (remote === null) {
    const snapshot = await buildLocalSnapshot(driver, effectiveNow);
    await provider.pushSnapshot(snapshot);
    const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
    await writeSyncMeta(driver, effectiveNow, offset);
    return result('PUBLISHED', { prunedTombstones: pruned, clockOffset: offset });
  }

  const meta = await readSyncMeta(driver);

  // --- §7.2 TTL edge: full clone with Pre-Wipe Salvage --------------------------
  if (needsFullResync(meta.lastSyncTimestamp, effectiveNow, ttlMs)) {
    await cloneWithSalvage(driver, remote, dictionary, meta.lastSyncTimestamp, offset);
    const merged = await buildLocalSnapshot(driver, effectiveNow);
    await provider.pushSnapshot(merged);
    const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
    await writeSyncMeta(driver, effectiveNow, offset);
    return result('CLONED', { prunedTombstones: pruned, clockOffset: offset });
  }

  // --- §7.3 normal delta reconciliation -----------------------------------------
  const local = await buildLocalSnapshot(driver, effectiveNow);
  const plan = reconcile(local, remote, { offset, dictionary });
  await applyPlan(driver, plan, dictionary);

  const merged = await buildLocalSnapshot(driver, effectiveNow);
  await provider.pushSnapshot(merged);
  const pruned = await pruneTombstones(driver, effectiveNow, ttlMs);
  await writeSyncMeta(driver, effectiveNow, offset);

  return result('SYNCED', {
    pulled: plan.localUpserts.length,
    deleted: plan.localDeletes.length,
    reparented: plan.reparented.length,
    rejectedCycles: plan.rejectedCycles.length,
    prunedTombstones: pruned,
    clockOffset: offset,
  });
}

/** §7.2 TTL prune of tombstones older than (now − ttl). */
async function pruneTombstones(
  driver: IDatabaseDriver,
  now: number,
  ttlMs: number,
): Promise<number> {
  const cutoff = now - ttlMs;
  const res = await driver.execute('DELETE FROM tombstones WHERE deleted_at < ?;', [cutoff]);
  return res.rowsModified;
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
  lastSync: number,
  offset: number,
): Promise<void> {
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
  const statements: SqlStatement[] = buildCloneStatements(remote, dictionary);

  for (const { table, row } of salvageRows) {
    statements.push(upsert(table, row, dictionary[table] ?? Object.keys(row)));
  }
  for (const t of salvageTombstones) {
    statements.push({ sql: `DELETE FROM ${t.tableName} WHERE id = ?;`, params: [t.id] });
    statements.push(tombstone(t));
  }

  await driver.transaction(statements);
}

// --- statement builders ----------------------------------------------------------

function upsert(table: SyncTable, row: SqlRow, columns: readonly string[]): SqlStatement {
  const cols = columns.filter((c) => c in row);
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
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

function hardStop(message: string): SyncResult {
  return result('HARD_STOP', { message });
}

function result(status: SyncResult['status'], partial: Partial<SyncResult>): SyncResult {
  return {
    status,
    pulled: partial.pulled ?? 0,
    deleted: partial.deleted ?? 0,
    reparented: partial.reparented ?? 0,
    rejectedCycles: partial.rejectedCycles ?? 0,
    prunedTombstones: partial.prunedTombstones ?? 0,
    clockOffset: partial.clockOffset ?? 0,
    message: partial.message,
  };
}

export { readSyncMeta };
