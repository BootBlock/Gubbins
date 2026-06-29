/**
 * Network connectivity detection (spec §2 local-first / offline-first PWA).
 *
 * Gubbins works fully offline — the local SQLite WASM database is the SSOT during
 * active use (§7) — so connectivity matters only for *reassurance* (changes are
 * saved locally) and for surfacing when cloud sync (§7) can actually reach a peer.
 * This tiny module is the pure, feature-detected seam for "are we online right
 * now?", mirroring `install.ts`'s `isStandaloneDisplay` / `motion.ts`'s
 * `prefersReducedMotion`. The matching live `online`/`offline` subscription lives
 * in `useOnlineStatus`.
 *
 * Feature-detected: where `navigator.onLine` is unavailable we assume **online**
 * (`true`) — the optimistic default, so a missing API never falsely claims the user
 * is offline and never blocks anything.
 */

/** Whether the browser currently believes it has network connectivity. */
export function isOnline(): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  return true;
}
