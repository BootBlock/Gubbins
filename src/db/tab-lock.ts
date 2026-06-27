/**
 * Multi-tab concurrency guard (spec §2.2.7).
 *
 * OPFS enforces an exclusive write lock on the database file: a second tab would
 * fail to mount SQLite and crash. Before booting the database we acquire an
 * app-wide exclusive Web Lock that is held for the lifetime of the tab (released
 * automatically when the tab closes). If another tab already holds it, we report
 * `acquired: false` so the UI can show a graceful "open in another tab" overlay,
 * and provide `whenReleased` — which settles once the owning tab goes away — so
 * the blocked tab can offer to reload and take over.
 */
import { hasWebLocks } from '@/lib/env/feature-detection';

const DB_TAB_LOCK = 'gubbins:db-tab';

export interface TabLockHandle {
  /** Release the lock (also released automatically when the tab is closed). */
  release(): void;
}

export type TabLockOutcome =
  | { readonly acquired: true; readonly handle: TabLockHandle }
  | { readonly acquired: false; readonly whenReleased: Promise<void> };

/**
 * Attempt to become the sole database-owning tab. Resolves as soon as the
 * acquisition outcome is known; when acquired, the underlying lock is held until
 * `release()` or tab close.
 */
export async function acquireDatabaseTabLock(): Promise<TabLockOutcome> {
  // Without the Web Locks API we cannot arbitrate. We are already gated on a very
  // modern browser (OPFS + cross-origin isolation), so degrade to "sole tab".
  if (!hasWebLocks()) {
    return { acquired: true, handle: { release: () => {} } };
  }

  return new Promise<TabLockOutcome>((resolveOutcome) => {
    let releaseHeld: (() => void) | null = null;

    void navigator.locks
      .request(DB_TAB_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (lock === null) {
          // Blocked — another tab owns the database. Queue a second, blocking
          // request so we learn when that tab releases (i.e. closes); the UI uses
          // this to prompt a reload and take ownership.
          const whenReleased = navigator.locks
            .request(DB_TAB_LOCK, { mode: 'exclusive' }, async () => {
              // Acquired momentarily once the owner is gone; release immediately —
              // the caller will reload and re-run the full boot as the sole tab.
            })
            .then(() => undefined);

          resolveOutcome({ acquired: false, whenReleased });
          return; // resolve the ifAvailable request without holding anything
        }

        // Acquired. Keep the lock by returning a promise that stays pending until
        // we explicitly release (or the tab closes).
        const held = new Promise<void>((resolveHeld) => {
          releaseHeld = resolveHeld;
        });
        resolveOutcome({ acquired: true, handle: { release: () => releaseHeld?.() } });
        return held;
      })
      .catch(() => {
        // Never let a lock-manager error block startup; degrade to "sole tab".
        resolveOutcome({ acquired: true, handle: { release: () => releaseHeld?.() } });
      });
  });
}
