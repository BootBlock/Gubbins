/**
 * Safe Mode rescue actions (spec §3).
 *
 * When the app has crashed, these give the user escape hatches so they are never
 * locked into a white-screen loop: pull a raw .sqlite binary (openable in DB
 * Browser for SQLite), a JSON dump, or hard-reset local storage as a last resort.
 * Every action is defensive — the database may be in a poor state.
 */
import { downloadBlob, fileTimestamp } from '@/lib/download';
import { resetAppShell } from '@/lib/app-shell-reset';
import { getDatabaseDriver, disposeDatabase } from '@/db/client';
import { DB_FILENAME } from '@/db/worker/sqlite-bootstrap';
import { inspectRestoreCandidate } from '@/db/restore-candidate';
import { isSqliteFile } from '@/db/sqlite-header';
import { removeImagesDirectory } from '@/features/images/opfs-images';

/** Download the live database as a raw .sqlite binary (spec §3 — the key rescue). */
export async function downloadRawSqlite(): Promise<void> {
  const bytes = await getDatabaseDriver().exportBinary();
  // Copy into a standalone ArrayBuffer so the Blob is independent of WASM memory.
  const copy = bytes.slice();
  downloadBlob(`gubbins-${fileTimestamp()}.sqlite`, new Blob([copy], { type: 'application/x-sqlite3' }));
}

// Re-exported so the long-standing `@/app/error/safe-mode-actions` import site keeps working;
// the guard itself now lives beside the structural header checks it belongs with (#198).
export { isSqliteFile } from '@/db/sqlite-header';

/**
 * Overwrite the OPFS database file with raw SQLite bytes (the shared write step behind
 * both raw-`.sqlite` and full-archive restore). The production database uses the standard
 * OPFS VFS — the file at `DB_FILENAME` *is* the raw SQLite database — so the new bytes are
 * written verbatim and any stale WAL/SHM/journal sidecars are cleared, or the next open would
 * read the new file through the old session's journal. The caller must have disposed the
 * worker beforehand and must reload afterwards so the worker re-opens it.
 *
 * **Order matters (issue #203).** The write comes *first* and the sidecars go only once it has
 * committed. Deleting them up front discards, before anything has replaced it, the one thing
 * that could repair the current database — a hot rollback journal left by an unclean shutdown —
 * so a write that then fails (quota, a tab closed mid-write, any OPFS error) turns a database
 * that was merely un-updated into one that is unrecoverable. A failed write aborts the
 * writable rather than closing it, so the original file keeps its contents and its sidecars
 * still match it.
 */
export async function overwriteOpfsDatabase(bytes: Uint8Array): Promise<void> {
  const baseName = DB_FILENAME.replace(/^\//, '');
  const root = await navigator.storage.getDirectory();

  const handle = await root.getFileHandle(baseName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as BufferSource);
    await writable.close();
  } catch (error) {
    // Discard the staged write instead of committing a partial file. Best-effort: the stream
    // may already be errored, and that must not mask the failure the caller needs to see.
    await writable.abort?.().catch(() => {});
    throw error;
  }

  // Only now the new bytes are on disk: a sidecar from the old session would otherwise be
  // replayed over them. A removal that fails for a reason other than absence is *not*
  // swallowed — the database has been replaced but a stale journal survives beside it, which
  // the caller must surface rather than reload into.
  for (const name of DB_SIDECAR_SUFFIXES.map((suffix) => `${baseName}${suffix}`)) {
    try {
      await root.removeEntry(name);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') continue;
      throw new StaleJournalError(name, error);
    }
  }
}

/**
 * The journal/WAL sidecar files SQLite keeps beside the database. Shared so the restore
 * overwrite and {@link hardResetLocalData} can never disagree about what counts as a sidecar.
 */
const DB_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const;

/**
 * Thrown when the new database bytes committed but one of the old session's sidecars could
 * not be removed (issue #203).
 *
 * Distinct from every other restore failure because it is the one that happens *after* the
 * overwrite: the restore did land, so a caller must finish the rest of its work rather than
 * unwind — but it must not reload, since opening the new file beside a hot journal would let
 * SQLite roll the restored database back over itself.
 */
export class StaleJournalError extends Error {
  /** The sidecar that could not be removed, e.g. `gubbins.sqlite3-wal`. */
  readonly sidecar: string;

  constructor(sidecar: string, cause: unknown) {
    super(
      'Your data was restored, but a leftover database file from the previous session could not ' +
        'be removed. Close any other Gubbins tabs and reload — if that does not help, restore ' +
        'again from the copy that was just downloaded.',
      { cause },
    );
    this.name = 'StaleJournalError';
    this.sidecar = sidecar;
  }
}

/**
 * Options shared by both destructive restores (raw `.sqlite` and full archive).
 */
export interface RestoreOptions {
  /**
   * Proceed even though the pre-flight checks called the incoming database damaged. Set only
   * from a second, explicit confirmation: a user whose live database is already lost may have
   * nothing but a damaged copy, and SQLite can often still read most of one — so this stays
   * *possible*, never silent.
   */
  readonly force?: boolean;
}

/**
 * Download the current OPFS database as a restore point, immediately before something
 * overwrites it (issue #198).
 *
 * The undo for a destructive restore, mirroring what `BackupDialog` does before a Replace.
 * Reads the OPFS file **directly** rather than asking the worker to serialise it: this runs
 * on the crash screen, where the worker is quite likely the thing that failed, and the file
 * at `DB_FILENAME` already *is* the raw database.
 *
 * Returns whether anything was captured — a device with no database yet has nothing to lose,
 * which is not a reason to block a restore. Throws when a database is present but unreadable:
 * that *is* a reason, since overwriting it would destroy data no copy exists of.
 */
export async function captureRestorePoint(): Promise<boolean> {
  const baseName = DB_FILENAME.replace(/^\//, '');
  let root: FileSystemDirectoryHandle;
  try {
    root = await navigator.storage.getDirectory();
  } catch {
    // No OPFS at all — there is no database here for a restore to overwrite.
    return false;
  }

  let file: File;
  try {
    const handle = await root.getFileHandle(baseName);
    file = await handle.getFile();
  } catch (error) {
    // Only *absence* is benign. Anything else — a locked file, an I/O error — means data is
    // there and we could not copy it, so the failure must reach the caller and stop the
    // restore. Swallowing it here would overwrite a database with no copy behind it, which is
    // the exact loss this function exists to prevent.
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
  if (file.size === 0) return false;

  // The `File` is already a `Blob` over the OPFS bytes, so it downloads without ever
  // materialising the whole database in memory.
  downloadBlob(`gubbins-restore-point-${fileTimestamp()}.sqlite`, file);
  // Let the browser commit the download before the caller overwrites the database and
  // reloads — a reload in the same tick can cancel an in-flight save.
  await new Promise((resolve) => setTimeout(resolve, RESTORE_POINT_SETTLE_MS));
  return true;
}

/** How long to let a restore-point download settle before overwriting and reloading. */
const RESTORE_POINT_SETTLE_MS = 400;

/**
 * The steps every destructive restore shares (issue #198): prove the incoming database is
 * sound, then secure the current one. Ordered deliberately — a file that is going to be
 * rejected should not cost the user a download first.
 *
 * Throws {@link DamagedDatabaseError} (unless forced) or {@link RestorePointError}; in
 * either case nothing has been written and the live database is untouched.
 */
export async function prepareDestructiveRestore(
  sqlite: Uint8Array,
  options: RestoreOptions = {},
): Promise<void> {
  // Skipped entirely when forced: the user has already been shown the verdict and chosen to
  // proceed, so re-reading every page of a large file to discard the answer only delays them.
  if (!options.force) {
    const assessment = await inspectRestoreCandidate(sqlite);
    if (assessment.status === 'damaged') {
      throw new DamagedDatabaseError(assessment.problems);
    }
  }

  try {
    await captureRestorePoint();
  } catch (error) {
    throw new RestorePointError(error);
  }
}

/**
 * Restore the database from a raw `.sqlite` binary (spec §3 — the inverse of
 * {@link downloadRawSqlite}). **Destructive** — the caller must confirm first. Checks the
 * incoming database is sound and downloads a restore point of the current one, then disposes
 * the worker, overwrites the OPFS file and reloads so the worker re-opens the new database.
 * Throws `InvalidRawSqliteError` for a non-SQLite file, or `DamagedDatabaseError` for one
 * that fails the pre-flight checks — in every failure case, before anything is overwritten.
 */
export async function restoreRawSqlite(file: File, options: RestoreOptions = {}): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isSqliteFile(bytes)) {
    throw new InvalidRawSqliteError('That file is not a SQLite database (bad header).');
  }

  await prepareDestructiveRestore(bytes, options);

  await disposeDatabase();
  await overwriteOpfsDatabase(bytes);

  location.reload();
}

/** Thrown when {@link restoreRawSqlite} is handed a non-SQLite file. */
export class InvalidRawSqliteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRawSqliteError';
  }
}

/**
 * Thrown when the incoming database is a genuine SQLite file but a damaged one — truncated,
 * or failing `PRAGMA integrity_check`. Carries the specific problems so the user can see
 * *why* before deciding whether to override (issue #198).
 */
export class DamagedDatabaseError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super('That database file is damaged, so restoring it would replace your data with a broken copy.');
    this.name = 'DamagedDatabaseError';
    this.problems = problems;
  }
}

/**
 * Thrown when the current database exists but could not be saved as a restore point. The
 * restore is abandoned rather than proceeding: an overwrite with no copy behind it is the
 * irreversible failure this whole guard exists to prevent.
 */
export class RestorePointError extends Error {
  constructor(cause: unknown) {
    super(
      'Could not save a copy of your current database, so the restore was cancelled rather than overwrite it.',
      { cause },
    );
    this.name = 'RestorePointError';
  }
}

/** Best-effort JSON dump of every table (full versioned backup arrives in Phase 7). */
export async function downloadJsonDump(): Promise<void> {
  const db = getDatabaseDriver();
  const tables = await db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
  );

  const data: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    // Identifier comes from sqlite_master (not user input); quoted defensively.
    data[name] = await db.query(`SELECT * FROM "${name.replace(/"/g, '""')}";`);
  }

  const payload = {
    format: 'gubbins-safe-mode-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    tables: data,
  };

  const json = JSON.stringify(payload, jsonReplacer, 2);
  downloadBlob(`gubbins-safe-export-${fileTimestamp()}.json`, new Blob([json], { type: 'application/json' }));
}

/**
 * Purge all local data and reload from a clean slate. Disposes the worker, deletes
 * the OPFS database file(s), and clears caches/service workers.
 */
export async function hardResetLocalData(): Promise<void> {
  await disposeDatabase();

  const baseName = DB_FILENAME.replace(/^\//, '');
  try {
    const root = await navigator.storage.getDirectory();
    for (const name of [baseName, ...DB_SIDECAR_SUFFIXES.map((suffix) => `${baseName}${suffix}`)]) {
      try {
        await root.removeEntry(name);
      } catch {
        // File not present — ignore.
      }
    }
  } catch {
    // OPFS unavailable — nothing to purge there.
  }

  // The code half of the purge — service worker + Cache Storage — is exactly what
  // `resetServiceWorkerOnly` does on its own; sharing it keeps the two from drifting.
  await resetAppShell();

  await clearLocalAppState();

  location.reload();
}

/**
 * Discard the cached app shell and reload, **keeping every byte of the user's data**
 * (issue #276).
 *
 * The recovery to reach for when the *build* is bad rather than the data: a broken
 * deploy, a half-applied update, a stale chunk the cache-first worker keeps serving. It
 * unregisters the service worker and empties Cache Storage, so the reload goes to the
 * network and picks up whatever the host is currently serving — while the OPFS database,
 * the images directory and all `gubbins:` settings are left untouched.
 *
 * This is strictly weaker than {@link hardResetLocalData} and is offered *first* so a
 * cosmetic bug never costs a user their inventory.
 */
export async function resetServiceWorkerOnly(): Promise<void> {
  await resetAppShell();
  location.reload();
}

/**
 * Clear the app's local browser-side state that lives outside the OPFS database file: the
 * full-resolution OPFS image directory, every `gubbins:`-namespaced `localStorage` key, and the
 * file-system-access IndexedDB store. Factored out so the same teardown is reusable, and each
 * step is wrapped independently so one failure (e.g. OPFS unavailable) can never block the
 * others — a hard reset must make best-effort progress on every front.
 *
 * The `localStorage` step stays a **prefix sweep** rather than iterating the key registry
 * (`lib/storage-keys.ts`): a full reset should take even a stray key that predates the registry
 * or was written by an older version. The registry is the superset's *documented* contents —
 * `storage-keys.test.ts` asserts every registered key carries the `gubbins:` prefix this sweep
 * matches — while the selective Danger-Zone erase and the backup allow-list are derived from it.
 */
export async function clearLocalAppState(): Promise<void> {
  try {
    await removeImagesDirectory();
  } catch {
    // OPFS unavailable or already clear — ignore.
  }

  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith('gubbins:')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // localStorage unavailable (e.g. privacy mode) — ignore.
  }

  try {
    indexedDB.deleteDatabase('gubbins-fs');
  } catch {
    // IndexedDB unavailable — ignore.
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return { $blobBase64: uint8ToBase64(value) };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
