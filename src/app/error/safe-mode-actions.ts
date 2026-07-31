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
import { getRescueDatabaseDriver, disposeDatabase } from '@/db/client';
// From the leaf storage module, never `db/worker/sqlite-bootstrap` — that would pull the
// whole SQLite WASM glue into this chunk for the sake of a path (issue #165).
import {
  deletePlainDatabaseFiles,
  deleteSahPoolStore,
  detectDbStorageLayout,
  hasSahPoolStore,
  readPlainDatabaseFile,
  writePlainDatabaseFile,
} from '@/db/db-storage';
import { acknowledgeDbLoss, clearDbPresence } from '@/db/db-presence';
import { inspectRestoreCandidate } from '@/db/restore-candidate';
import { isSqliteFile } from '@/db/sqlite-header';
import { removeImagesDirectory } from '@/features/images/opfs-images';

/** Download the live database as a raw .sqlite binary (spec §3 — the key rescue). */
export async function downloadRawSqlite(): Promise<void> {
  const bytes = await (await getRescueDatabaseDriver()).exportBinary();
  // Copy into a standalone ArrayBuffer so the Blob is independent of WASM memory.
  const copy = bytes.slice();
  downloadBlob(`gubbins-${fileTimestamp()}.sqlite`, new Blob([copy], { type: 'application/x-sqlite3' }));
}

// Re-exported so the long-standing `@/app/error/safe-mode-actions` import site keeps working;
// the guard itself now lives beside the structural header checks it belongs with (#198).
export { isSqliteFile } from '@/db/sqlite-header';

/**
 * Replace the stored database with raw SQLite bytes (the shared write step behind both
 * raw-`.sqlite` and full-archive restore), then release the worker so the caller can reload
 * into the restored database.
 *
 * Where the bytes go depends on which VFS this origin's database lives on (issue #255). Under
 * the primary `opfs` VFS the file at `DB_FILENAME` *is* the raw database, so it is written
 * here — on the crash screen, which is where a restore usually starts, the worker is quite
 * likely the thing that failed. Under the `opfs-sahpool` fallback there is no such file to
 * write, and on a fresh install nothing on disk says which VFS the next boot will pick; both
 * cases go through the worker, which owns that decision. Disposal is deliberately part of this
 * function rather than the caller's job, because the two orders are opposites: the direct write
 * needs the worker *gone* first, the delegated one needs it alive.
 *
 * A pending "your data was cleared by the browser" notice is settled here too (issue #505). It is
 * raised on every boot until the user answers it, and restoring *is* the answer — without this,
 * the reload into freshly-restored data would open on a screen announcing that the data is gone.
 * Only once the bytes have committed: a restore that failed leaves the loss genuinely unresolved,
 * and one that landed beside a stale journal ({@link StaleJournalError}) still landed.
 */
export async function overwriteDatabaseFile(bytes: Uint8Array): Promise<void> {
  if ((await detectDbStorageLayout()) === 'opfs') {
    await disposeDatabase();
    const { staleSidecar, cause } = await writePlainDatabaseFile(bytes);
    acknowledgeDbLoss();
    if (staleSidecar) throw new StaleJournalError(staleSidecar, cause);
    return;
  }

  const { staleSidecar } = await (await getRescueDatabaseDriver()).writeDatabaseFile(bytes);
  acknowledgeDbLoss();
  await disposeDatabase();
  if (staleSidecar) throw new StaleJournalError(staleSidecar, undefined);
}

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
 * Reads the OPFS file **directly** where it can rather than asking the worker to serialise it:
 * this runs on the crash screen, where the worker is quite likely the thing that failed, and
 * under the primary VFS the file at `DB_FILENAME` already *is* the raw database. Only the
 * `opfs-sahpool` fallback, whose files no directory handle can resolve, goes through the worker
 * (issue #255) — and it reads the *file*, not the database, so a corrupt one still copies out.
 *
 * Returns whether anything was captured — a device with no database yet has nothing to lose,
 * which is not a reason to block a restore. Throws when a database is present but unreadable:
 * that *is* a reason, since overwriting it would destroy data no copy exists of.
 */
export async function captureRestorePoint(): Promise<boolean> {
  // Only *absence* is benign here. Anything else — a locked file, an I/O error — means data is
  // there and we could not copy it, so `readPlainDatabaseFile` lets the failure reach the
  // caller and stop the restore. Swallowing it would overwrite a database with no copy behind
  // it, which is the exact loss this function exists to prevent.
  const file = await readPlainDatabaseFile();
  if (file && file.size > 0) {
    // The `File` is already a `Blob` over the OPFS bytes, so it downloads without ever
    // materialising the whole database in memory.
    return await downloadRestorePoint(file);
  }
  if (!(await hasSahPoolStore())) return false;

  const bytes = await (await getRescueDatabaseDriver()).readDatabaseFile();
  if (!bytes || bytes.length === 0) return false;
  // Copy into a standalone ArrayBuffer: bytes crossing from the worker can be
  // SharedArrayBuffer-backed, which `Blob` rejects.
  return await downloadRestorePoint(new Blob([bytes.slice()], { type: 'application/x-sqlite3' }));
}

/** Save the captured bytes, then let the download commit before the caller overwrites. */
async function downloadRestorePoint(blob: Blob): Promise<true> {
  downloadBlob(`gubbins-restore-point-${fileTimestamp()}.sqlite`, blob);
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
 * Throws {@link DamagedDatabaseError} or {@link IncompatibleDatabaseError} (unless forced), or
 * {@link RestorePointError}; in every case nothing has been written and the live database is
 * untouched.
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
    if (assessment.status === 'incompatible') {
      throw new IncompatibleDatabaseError();
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
 * incoming database is sound and downloads a restore point of the current one, then replaces
 * the stored database and reloads so the worker re-opens the new one. Throws
 * `InvalidRawSqliteError` for a non-SQLite file, `DamagedDatabaseError` for one that fails the
 * pre-flight checks, or `IncompatibleDatabaseError` for one built by another schema baseline — in
 * every failure case, before anything is overwritten.
 */
export async function restoreRawSqlite(file: File, options: RestoreOptions = {}): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isSqliteFile(bytes)) {
    throw new InvalidRawSqliteError('That file is not a SQLite database (bad header).');
  }

  await prepareDestructiveRestore(bytes, options);

  await overwriteDatabaseFile(bytes);

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
 * Thrown when the incoming database is intact but was **built by a different schema baseline**
 * than this build expects (issue #501) — so this build would refuse it at the next boot with
 * `SCHEMA_STALE`.
 *
 * The sibling of {@link DamagedDatabaseError}, and refused for the same reason at the same point:
 * the app already knows the restore cannot succeed, so performing it would replace a working
 * database with one that will not open. Gubbins is pre-release and does not migrate data across a
 * baseline change; the way across is a `.zip` backup restored with **Merge**, which re-applies the
 * records onto the new schema rather than replacing the database file.
 *
 * Overridable through `force` like the damage report, because the boot refusal it predicts is
 * survivable (the restore point is downloaded first, and Safe Mode can put it back) and because a
 * user who has also rolled the *build* back may mean exactly what they asked for.
 */
export class IncompatibleDatabaseError extends Error {
  constructor() {
    super(
      'That database was made by a different version of Gubbins, so this version cannot open it — ' +
        'restoring it would leave Gubbins unable to start.',
    );
    this.name = 'IncompatibleDatabaseError';
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
  const db = await getRescueDatabaseDriver();
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
 * the database file(s), and clears caches/service workers.
 */
export async function hardResetLocalData(): Promise<void> {
  // First, before anything is deleted: forget that this device ever held a database (issue #505).
  // A deliberate purge is not a loss, and this reset deletes the database files well before
  // `clearLocalAppState` sweeps `localStorage` — so a run interrupted in between (a closed tab, a
  // failed OPFS call) would otherwise leave the marker behind and greet the next boot with "your
  // data was cleared by the browser" for a wipe the user asked for.
  clearDbPresence();

  // The `opfs-sahpool` fallback keeps the database inside its own store, and the worker holds
  // a sync access handle on every file in it — a directory removal can fail outright while
  // those are live, which would leave a "purge everything" quietly not purging the data. So
  // ask the VFS to blank its own files *first*, while it still owns them (issue #255).
  if (await hasSahPoolStore()) {
    try {
      await (await getRescueDatabaseDriver()).wipeDatabaseFiles();
    } catch {
      // A wedged or dead worker is exactly why a user reaches for this; the directory removal
      // below is the second pass at it.
    }
  }

  await disposeDatabase();

  await deletePlainDatabaseFiles();
  await deleteSahPoolStore();

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
