/**
 * Persisting the File System Access sync-directory handle across sessions (Phase 14).
 *
 * A `FileSystemDirectoryHandle` is structured-cloneable, so — unlike an API key — it
 * can be stored in IndexedDB and re-loaded after a reload to *resume* syncing through
 * the same folder without re-prompting (when the permission is still granted). The
 * security model still applies: a stored handle may need a fresh user gesture to
 * re-grant `readwrite` permission, which {@link reconnectAction} decides.
 *
 * Everything here is feature-detected: without IndexedDB (e.g. the happy-dom test env)
 * every operation degrades to a no-op / null, so callers never need to guard.
 */

const DB_NAME = 'gubbins-fs';
const STORE = 'handles';
const KEY = 'sync-directory';

/** A persisted directory handle exposes the FS Access permission methods (not in lib.dom). */
export interface PersistableDirectoryHandle {
  readonly name: string;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type HandlePermission = 'granted' | 'prompt' | 'denied' | 'unsupported';

/**
 * Map a stored handle's permission state to the action the UI should take. Pure, so the
 * reconnect policy is unit-tested without IndexedDB or a real handle.
 *  - `granted` → reconnect silently;
 *  - `prompt`  → a fresh user gesture is needed to re-grant (show a "Reconnect" button);
 *  - else      → the grant is gone; forget the stale handle.
 */
export function reconnectAction(state: HandlePermission): 'connect' | 'needs-gesture' | 'forget' {
  if (state === 'granted') return 'connect';
  if (state === 'prompt') return 'needs-gesture';
  return 'forget';
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/** Persist the chosen sync directory so a later session can resume through it. */
export async function persistSyncDirectory(handle: PersistableDirectoryHandle): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.put(handle, KEY));
  db.close();
}

/** Load the previously-persisted sync directory handle, or null when none/unsupported. */
export async function loadSyncDirectory(): Promise<PersistableDirectoryHandle | null> {
  const db = await openDb();
  if (!db) return null;
  const handle = await tx<PersistableDirectoryHandle>(db, 'readonly', (s) => s.get(KEY));
  db.close();
  return handle ?? null;
}

/** Drop any persisted handle (on explicit disconnect, or when the grant is gone). */
export async function forgetSyncDirectory(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.delete(KEY));
  db.close();
}

/** Query a handle's current `readwrite` permission state, normalised to {@link HandlePermission}. */
export async function handlePermission(handle: PersistableDirectoryHandle): Promise<HandlePermission> {
  if (typeof handle.queryPermission !== 'function') return 'unsupported';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'unsupported';
  }
}
