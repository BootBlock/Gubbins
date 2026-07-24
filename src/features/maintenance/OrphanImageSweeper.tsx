/**
 * OrphanImageSweeper — the app-wide mount point for the automatic orphaned-image sweep (#206).
 *
 * Renders nothing; it exists to fire {@link runAutoOrphanSweepInBrowser} once shortly after the
 * app is ready and then on a long interval, so leftover full-resolution OPFS files (from item
 * deletes and sync merges — see the module note in `auto-orphan-sweep.ts`) are reclaimed in the
 * background rather than only when the user finds the Database-Maintenance sweep.
 *
 * Mounted inside the boot gate so the database the sweep queries is ready. The run is throttled
 * by a persisted timestamp, so a first pass and every subsequent tick are no-ops until an
 * interval has elapsed — which also makes StrictMode's double-invoke and frequent reloads
 * harmless. The initial pass is deferred to browser idle time so it never competes with the
 * first paint.
 */
import { useEffect } from 'react';
import { ORPHAN_SWEEP_INTERVAL_MS, runAutoOrphanSweepInBrowser } from './auto-orphan-sweep';

/** Run the idle callback if the browser has one, else fall back to a short timeout. */
function whenIdle(run: () => void): () => void {
  const w = window as typeof window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(run, { timeout: 10_000 });
    return () => w.cancelIdleCallback?.(handle);
  }
  const timer = setTimeout(run, 3_000);
  return () => clearTimeout(timer);
}

export function OrphanImageSweeper(): null {
  useEffect(() => {
    let cancelled = false;
    const sweep = () => {
      if (cancelled) return;
      // Best-effort: a failed sweep must never surface or break anything — it retries next tick.
      void runAutoOrphanSweepInBrowser().catch(() => {});
    };

    const cancelIdle = whenIdle(sweep);
    // Re-check on a long cadence so a session left open for days still reclaims (the throttle
    // inside the run decides whether each tick actually sweeps).
    const interval = setInterval(sweep, ORPHAN_SWEEP_INTERVAL_MS);

    return () => {
      cancelled = true;
      cancelIdle();
      clearInterval(interval);
    };
  }, []);

  return null;
}
