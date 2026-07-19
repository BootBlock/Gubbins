/**
 * Reset the cached **app shell** — the service worker and its Cache Storage entries —
 * without touching a single byte of the user's data (issue #276).
 *
 * A bad deploy leaves the cache-first service worker (`src/sw.ts`) serving the broken
 * build indefinitely. Before this existed, the only in-app way to get a clean worker was
 * `hardResetLocalData`, which unregisters the worker *bundled with* deleting the OPFS
 * database, the images directory and every `gubbins:` localStorage key. That is a wildly
 * disproportionate price for a cosmetic or logic bug: the user loses their whole
 * inventory to fix a rendering glitch.
 *
 * This module is the narrow escape hatch — code only, data untouched. It deliberately
 * has **no imports**: it is called from the crash-recovery UI, where anything it pulled
 * in is one more module that could itself be the thing that is broken.
 */

/**
 * What a reset actually managed to do. Both steps are best-effort and independent — a
 * browser with Cache Storage disabled must still get its worker unregistered, and vice
 * versa — so the caller can tell the user what really happened instead of claiming
 * success on a no-op.
 */
export interface AppShellResetResult {
  /** Service-worker registrations successfully unregistered. */
  readonly workersUnregistered: number;
  /** Cache Storage buckets successfully deleted. */
  readonly cachesDeleted: number;
}

/**
 * Unregister every service worker for this origin and delete every Cache Storage bucket,
 * leaving the OPFS database, the images directory, IndexedDB and `localStorage` alone.
 *
 * The two steps run in order, not in parallel: a still-registered worker can repopulate a
 * cache we have just deleted, so it has to go first. Each is wrapped independently so one
 * unavailable API can never block the other. The caller reloads afterwards: with no worker
 * and no cache, the reload goes to the network and picks up whatever the host is currently
 * serving.
 *
 * (`hardResetLocalData` previously cleared caches *before* unregistering, which had this
 * race; routing it through here fixes that too.)
 */
export async function resetAppShell(): Promise<AppShellResetResult> {
  let workersUnregistered = 0;
  let cachesDeleted = 0;

  try {
    const registrations = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    const results = await Promise.all(registrations.map((registration) => registration.unregister()));
    workersUnregistered = results.filter(Boolean).length;
  } catch {
    // Service workers unavailable (or blocked) — nothing to unregister.
  }

  try {
    const keys = await caches.keys();
    const results = await Promise.all(keys.map((key) => caches.delete(key)));
    cachesDeleted = results.filter(Boolean).length;
  } catch {
    // Cache Storage unavailable — ignore.
  }

  return { workersUnregistered, cachesDeleted };
}
