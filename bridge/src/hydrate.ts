/**
 * Snapshot → headless database hydration (Phase HA-1).
 *
 * Turns a `gubbins-sync.json` snapshot (the versioned-JSON the PWA's FS-Access sync
 * writes to a shared folder) into a fully-queryable, in-memory Gubbins database, by
 * running the app's *own* code end-to-end:
 *
 *   1. {@link parseBackupJson} validates the envelope and refuses a snapshot from a
 *      newer PWA build (the `formatVersion` guard — see "version skew" below).
 *   2. The migration engine builds the exact production schema (FTS5 + all triggers).
 *   3. {@link restoreSnapshot} UPSERTs every synced table, the append-only history
 *      ledger and the tag edges — the same path "Import backup" uses in the app.
 *
 * The result is a ready {@link IDatabaseDriver} the query layer (HA-2) drives through
 * the real repositories, so bridge answers match the app exactly. Read-only after
 * this point: hydration is the only write.
 */
import { readFile } from 'node:fs/promises';
import { migrations } from '@/db/migrations';
import { runMigrations } from '@/db/migrations/engine';
import type { MigrationReport } from '@/db/migrations';
import { parseBackupJson } from '@/features/sync/backup';
import { restoreSnapshot } from '@/features/sync/snapshot';
import type { SyncSnapshot } from '@/features/sync/types';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { createNodeDriver, type NodeDriver } from './node-driver.ts';
import { detectSource, hydrateFromSqliteFile } from './sqlite-source.ts';

export interface HydrateResult {
  /** A ready, migrated, snapshot-loaded driver. Caller owns it and must `close()`. */
  readonly driver: NodeDriver;
  /** The parsed snapshot envelope (its `formatVersion`, `generatedAt`, …). */
  readonly snapshot: SyncSnapshot;
  /** What the migration engine did to reach the target schema. */
  readonly migration: MigrationReport;
}

/**
 * Hydrate from an already-read snapshot JSON string. Throws a clear error on a
 * malformed envelope or a future `formatVersion` (the {@link parseBackupJson} guard).
 */
export async function hydrateFromJson(text: string): Promise<HydrateResult> {
  // Validate (and refuse newer-format) BEFORE building anything, so a bad file is a
  // cheap, clear failure rather than a half-built database.
  const snapshot = parseBackupJson(text);

  const driver = createNodeDriver();
  const migration = await runMigrations(driver, migrations);
  await restoreSnapshot(driver, snapshot);

  return { driver, snapshot, migration };
}

/**
 * Hydrate from a data-source file on disk (read-only). Auto-detects the source:
 *
 *   - a **JSON snapshot** (`gubbins-sync.json`, the FS-Access sync output) → {@link hydrateFromJson};
 *   - a **raw `.sqlite` export** (the whole DB file, `src/features/export/*`) →
 *     {@link hydrateFromSqliteFile} (copy → open → migrate).
 *
 * Either way the returned {@link HydrateResult} is identical in shape, so the watcher, CLI,
 * query core, HTTP API and MCP server consume it unchanged.
 */
export async function hydrateFromFile(path: string): Promise<HydrateResult> {
  if ((await detectSource(path)) === 'sqlite') {
    return hydrateFromSqliteFile(path);
  }

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not read the snapshot file at "${path}": ${reason}`);
  }
  return hydrateFromJson(text);
}

export type { IDatabaseDriver };
