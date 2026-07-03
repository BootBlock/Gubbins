/**
 * Database Maintenance engine (Settings → Database maintenance).
 *
 * Three safe, on-demand housekeeping tasks for the local-first SQLite/OPFS store.
 * Everything the browser touches is behind an injected {@link MaintenancePorts} bag,
 * so the whole engine is driven in unit tests by the in-memory SQLite driver plus
 * trivial OPFS fakes — no worker, no OPFS, no WASM.
 *
 *  - **Compact & optimise** ({@link compactDatabase}) merges the FTS5 index segments,
 *    refreshes the query-planner statistics, then `VACUUM`s. Deletes (Danger-Zone
 *    erases, Storage-Triage prunes, ordinary item removals) leave free pages behind —
 *    the OPFS database file never shrinks on its own — so this is what actually returns
 *    the reclaimed space to the file system. Reports the byte size before/after.
 *  - **Check health** ({@link checkDatabaseHealth}) runs `PRAGMA integrity_check` and
 *    `PRAGMA foreign_key_check`. Read-only: it reports problems, it never mutates. In
 *    normal operation foreign keys are enforced (`PRAGMA foreign_keys = ON`) and every
 *    parent delete cascades, so in-database orphans cannot accumulate — this is the tool
 *    that would *surface* any that ever slipped past (e.g. a sync-reconcile bug), rather
 *    than silently deleting rows.
 *  - **Remove orphaned image files** ({@link sweepOrphanImages}) is the one true orphan
 *    class foreign keys cannot manage: raw OPFS `images/<uuid>.webp` files that no
 *    `item_images` row points at, left behind if a database write failed *after* the
 *    file landed (the media pipeline flags exactly this). It only ever deletes a file
 *    with **no** owning row; it never touches a row whose file is merely absent (that is
 *    a valid image synced from another device but not yet downloaded).
 *
 * VACUUM cannot run inside a transaction, so compaction is issued as plain `execute`
 * statements (never through `driver.transaction`).
 */
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { getDatabaseDriver } from '@/db/client';
import { deleteImageFile, listImageFilenames } from '@/features/images/opfs-images';

/** The side-effecting capabilities the engine needs, injected for testability. */
export interface MaintenancePorts {
  readonly db: IDatabaseDriver;
  /**
   * List the bare filenames in the OPFS `images/` directory, or `null` when OPFS is
   * unavailable (so the orphan sweep reports "unsupported" instead of deleting against
   * a falsely-empty list).
   */
  readonly listImageFilenames: () => Promise<string[] | null>;
  /** Delete one raw image file by its stored `images/<name>` path. */
  readonly deleteImageFile: (path: string) => Promise<void>;
}

/** OPFS subdirectory the full-resolution image files live in (mirrors opfs-images). */
const IMAGES_DIR = 'images';

// --- Compact & optimise ---------------------------------------------------------

export interface CompactResult {
  /** On-disk database size (bytes) before compaction. */
  readonly beforeBytes: number;
  /** On-disk database size (bytes) after compaction. */
  readonly afterBytes: number;
  /** Space returned to the file system (`beforeBytes − afterBytes`, clamped ≥ 0). */
  readonly reclaimedBytes: number;
}

/** Current database size in bytes: `page_count × page_size` (both cheap PRAGMAs). */
export async function databaseBytes(db: IDatabaseDriver): Promise<number> {
  const pageCount = await db.queryOne<{ page_count: number }>('PRAGMA page_count;');
  const pageSize = await db.queryOne<{ page_size: number }>('PRAGMA page_size;');
  return Number(pageCount?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
}

/**
 * Merge FTS segments, refresh planner statistics, then VACUUM. Returns the byte size
 * before and after so the UI can report the space reclaimed.
 */
export async function compactDatabase(ports: Pick<MaintenancePorts, 'db'>): Promise<CompactResult> {
  const { db } = ports;
  const beforeBytes = await databaseBytes(db);

  // Merge the FTS5 index b-tree segments accumulated by many small writes into fewer,
  // larger ones — shrinking the index and speeding future searches. Harmless if the
  // index is already tidy.
  await db.execute(`INSERT INTO items_fts(items_fts) VALUES ('optimize');`);
  // Refresh the query-planner statistics (runs ANALYZE on tables that have changed
  // enough to matter). Cheap and recommended after bulk changes.
  await db.execute('PRAGMA optimize;');
  // Rebuild the file, releasing free pages left by deletes back to the file system.
  // Must be the last step and must not run inside a transaction.
  await db.execute('VACUUM;');

  const afterBytes = await databaseBytes(db);
  return { beforeBytes, afterBytes, reclaimedBytes: Math.max(0, beforeBytes - afterBytes) };
}

// --- Check health ---------------------------------------------------------------

export interface HealthResult {
  /** True when both integrity and foreign-key checks come back clean. */
  readonly ok: boolean;
  /** Human-readable descriptions of any problems found (empty when `ok`). */
  readonly problems: readonly string[];
}

/**
 * Run `PRAGMA integrity_check` + `PRAGMA foreign_key_check`. Read-only. A healthy
 * database yields a single `integrity_check` row of `ok` and no foreign-key rows.
 */
export async function checkDatabaseHealth(ports: Pick<MaintenancePorts, 'db'>): Promise<HealthResult> {
  const { db } = ports;
  const problems: string[] = [];

  const integrity = await db.query<{ integrity_check: string }>('PRAGMA integrity_check;');
  for (const row of integrity) {
    const message = row.integrity_check;
    if (message && message !== 'ok') problems.push(message);
  }

  const fkViolations = await db.query<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>('PRAGMA foreign_key_check;');
  for (const v of fkViolations) {
    problems.push(
      `Foreign-key violation in "${v.table}"${v.rowid == null ? '' : ` (row ${v.rowid})`} → missing "${v.parent}".`,
    );
  }

  return { ok: problems.length === 0, problems };
}

// --- Remove orphaned image files ------------------------------------------------

export interface OrphanSweepResult {
  /** False when OPFS could not be read (e.g. no browser) — nothing was scanned. */
  readonly supported: boolean;
  /** Number of raw image files found in OPFS. */
  readonly scanned: number;
  /** Number of files that were referenced by an `item_images` row (kept). */
  readonly referenced: number;
  /** Number of unreferenced (orphaned) files deleted. */
  readonly removed: number;
}

/** Extract the bare filename from a stored `images/<uuid>.webp` path. */
function filenameOf(path: string): string | undefined {
  const name = path.split('/').pop();
  return name && name.length > 0 ? name : undefined;
}

/**
 * Delete raw OPFS image files that no `item_images` row references. Conservative: it
 * reads the DB references first (a throw there aborts before any delete), and only
 * removes files with no owning row — never a row whose file is merely missing.
 */
export async function sweepOrphanImages(ports: MaintenancePorts): Promise<OrphanSweepResult> {
  const filenames = await ports.listImageFilenames();
  if (filenames === null) {
    return { supported: false, scanned: 0, referenced: 0, removed: 0 };
  }

  const rows = await ports.db.query<{ full_res_opfs_path: string }>(
    'SELECT full_res_opfs_path FROM item_images;',
  );
  const referenced = new Set<string>();
  for (const row of rows) {
    const name = filenameOf(row.full_res_opfs_path);
    if (name) referenced.add(name);
  }

  let removed = 0;
  let referencedCount = 0;
  for (const name of filenames) {
    if (referenced.has(name)) {
      referencedCount += 1;
      continue;
    }
    await ports.deleteImageFile(`${IMAGES_DIR}/${name}`);
    removed += 1;
  }

  return { supported: true, scanned: filenames.length, referenced: referencedCount, removed };
}

/**
 * Wire the real browser capabilities: the shared worker DB driver and the OPFS image
 * helpers. The single place production maintenance meets the worker/OPFS layers.
 */
export function browserMaintenancePorts(): MaintenancePorts {
  return {
    db: getDatabaseDriver(),
    listImageFilenames: () => listImageFilenames(),
    deleteImageFile: (path) => deleteImageFile(path),
  };
}
