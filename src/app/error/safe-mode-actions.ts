/**
 * Safe Mode rescue actions (spec §3).
 *
 * When the app has crashed, these give the user escape hatches so they are never
 * locked into a white-screen loop: pull a raw .sqlite binary (openable in DB
 * Browser for SQLite), a JSON dump, or hard-reset local storage as a last resort.
 * Every action is defensive — the database may be in a poor state.
 */
import { downloadBlob, fileTimestamp } from '@/lib/download';
import { getDatabaseDriver, disposeDatabase } from '@/db/client';
import { DB_FILENAME } from '@/db/worker/sqlite-bootstrap';
import { removeImagesDirectory } from '@/features/images/opfs-images';

/** Download the live database as a raw .sqlite binary (spec §3 — the key rescue). */
export async function downloadRawSqlite(): Promise<void> {
  const bytes = await getDatabaseDriver().exportBinary();
  // Copy into a standalone ArrayBuffer so the Blob is independent of WASM memory.
  const copy = bytes.slice();
  downloadBlob(`gubbins-${fileTimestamp()}.sqlite`, new Blob([copy], { type: 'application/x-sqlite3' }));
}

/** The 16-byte magic string every SQLite 3 database file begins with. */
const SQLITE_MAGIC = 'SQLite format 3\0';

/**
 * Validate that `bytes` begins with the SQLite 3 file header (spec §3 raw restore). A
 * pure guard so a stray JSON/image file can never overwrite the live database with junk.
 */
export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  for (let i = 0; i < SQLITE_MAGIC.length; i += 1) {
    if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Overwrite the OPFS database file with raw SQLite bytes (the shared write step behind
 * both raw-`.sqlite` and full-archive restore). The production database uses the standard
 * OPFS VFS — the file at `DB_FILENAME` *is* the raw SQLite database — so we clear any stale
 * WAL/SHM/journal sidecars first, then write the new bytes verbatim. The caller must have
 * disposed the worker beforehand and must reload afterwards so the worker re-opens it.
 */
export async function overwriteOpfsDatabase(bytes: Uint8Array): Promise<void> {
  const baseName = DB_FILENAME.replace(/^\//, '');
  const root = await navigator.storage.getDirectory();
  // Remove stale journal sidecars first so the freshly-written file is read verbatim.
  for (const name of [`${baseName}-journal`, `${baseName}-wal`, `${baseName}-shm`]) {
    try {
      await root.removeEntry(name);
    } catch {
      // Not present — ignore.
    }
  }
  const handle = await root.getFileHandle(baseName, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as BufferSource);
  } finally {
    await writable.close();
  }
}

/**
 * Restore the database from a raw `.sqlite` binary (spec §3 — the inverse of
 * {@link downloadRawSqlite}). **Destructive** — the caller must confirm first. We dispose
 * the worker, overwrite the OPFS file with the uploaded bytes, then reload so the worker
 * re-opens the new database. Throws `InvalidRawSqliteError` for a non-SQLite file.
 */
export async function restoreRawSqlite(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isSqliteFile(bytes)) {
    throw new InvalidRawSqliteError('That file is not a SQLite database (bad header).');
  }

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
    for (const name of [baseName, `${baseName}-journal`, `${baseName}-wal`, `${baseName}-shm`]) {
      try {
        await root.removeEntry(name);
      } catch {
        // File not present — ignore.
      }
    }
  } catch {
    // OPFS unavailable — nothing to purge there.
  }

  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // Cache Storage unavailable — ignore.
  }

  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(registrations.map((registration) => registration.unregister()));
  } catch {
    // No service workers — ignore.
  }

  await clearLocalAppState();

  location.reload();
}

/**
 * Clear the app's local browser-side state that lives outside the OPFS database file: the
 * full-resolution OPFS image directory, every `gubbins:`-namespaced `localStorage` key, and the
 * file-system-access IndexedDB store. Factored out so the same teardown is reusable, and each
 * step is wrapped independently so one failure (e.g. OPFS unavailable) can never block the
 * others — a hard reset must make best-effort progress on every front.
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
