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

/** Download the live database as a raw .sqlite binary (spec §3 — the key rescue). */
export async function downloadRawSqlite(): Promise<void> {
  const bytes = await getDatabaseDriver().exportBinary();
  // Copy into a standalone ArrayBuffer so the Blob is independent of WASM memory.
  const copy = bytes.slice();
  downloadBlob(`gubbins-${fileTimestamp()}.sqlite`, new Blob([copy], { type: 'application/x-sqlite3' }));
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

  location.reload();
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
