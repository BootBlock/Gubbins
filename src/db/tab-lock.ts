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
 *
 * The guard **fails closed**. When arbitration is impossible — no Web Locks API, or
 * the lock manager itself errors — we cannot tell whether another tab owns the
 * database, and assuming it does not is the one assumption that lets two tabs
 * contend for the primary datastore. So we deny, and let the user override for
 * *this* tab if they know it is the only one open ({@link setTabLockOverride}).
 */
import { hasWebLocks } from '@/lib/env/feature-detection';
// `sessionStorage`, not `localStorage`: the override must die with the tab, or one
// deliberate override would silently disarm the guard for every future tab.
import { TAB_LOCK_OVERRIDE_KEY } from '@/lib/storage-keys';

const DB_TAB_LOCK = 'gubbins:db-tab';

export interface TabLockHandle {
  /** Release the lock (also released automatically when the tab is closed). */
  release(): void;
}

/** Why the database could not be claimed. */
export type TabLockDenial =
  /** Another tab demonstrably owns the database. */
  | 'held'
  /** Arbitration is unavailable, so ownership is unknown — see the module header. */
  | 'unavailable';

export type TabLockOutcome =
  | { readonly acquired: true; readonly handle: TabLockHandle }
  | {
      readonly acquired: false;
      readonly reason: TabLockDenial;
      /**
       * Settles once the owning tab goes away. `null` when the reason is
       * `'unavailable'`: with no working lock manager there is nothing to wait on.
       */
      readonly whenReleased: Promise<void> | null;
    };

/**
 * True when this tab has been told to proceed despite arbitration being unavailable.
 * Deliberately module-private: whether an override lets a boot through is a decision for
 * {@link acquireDatabaseTabLock} alone, so no call site can branch on it independently.
 */
function hasTabLockOverride(): boolean {
  try {
    return sessionStorage.getItem(TAB_LOCK_OVERRIDE_KEY) === '1';
  } catch {
    // Storage can throw when site data is blocked; no override is the safe reading.
    return false;
  }
}

/** Record the user's "open anyway" choice, for this tab only. */
export function setTabLockOverride(): void {
  try {
    sessionStorage.setItem(TAB_LOCK_OVERRIDE_KEY, '1');
  } catch {
    // Nothing useful to do if storage refuses: the reload simply lands back on the same
    // screen. That is not a dead end in practice, because blocked site data fails the
    // critical-support gate in `useDatabaseBoot` long before this guard runs — keep that
    // ordering if the boot steps are ever rearranged.
  }
}

const UNARBITRATED: TabLockOutcome = { acquired: false, reason: 'unavailable', whenReleased: null };

/**
 * Attempt to become the sole database-owning tab. Resolves as soon as the
 * acquisition outcome is known; when acquired, the underlying lock is held until
 * `release()` or tab close.
 */
export async function acquireDatabaseTabLock(): Promise<TabLockOutcome> {
  // No Web Locks API — we cannot arbitrate at all, so deny unless this tab has been
  // explicitly overridden. There is no lock to hold in that case, hence the no-op handle.
  if (!hasWebLocks()) {
    return hasTabLockOverride() ? { acquired: true, handle: { release: () => {} } } : UNARBITRATED;
  }

  return new Promise<TabLockOutcome>((resolveOutcome) => {
    let releaseHeld: (() => void) | null = null;

    void navigator.locks
      .request(DB_TAB_LOCK, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (lock === null) {
          // Blocked — another tab owns the database. Queue a second, blocking
          // request so we learn when that tab releases (i.e. closes); the UI uses
          // this to prompt a reload and take ownership. If even that request fails
          // we simply never settle, leaving the user the manual reload button —
          // an unhandled rejection here would help nobody.
          const whenReleased = navigator.locks
            .request(DB_TAB_LOCK, { mode: 'exclusive' }, async () => {
              // Acquired momentarily once the owner is gone; release immediately —
              // the caller will reload and re-run the full boot as the sole tab.
            })
            .then(() => undefined)
            .catch(() => new Promise<void>(() => {}));

          resolveOutcome({ acquired: false, reason: 'held', whenReleased });
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
        // The lock manager errored, so ownership is unknown. Fail closed for the same
        // reason as a missing API — unless this tab has already been overridden.
        // (Harmless if the outcome is already settled: the promise ignores it.)
        resolveOutcome(
          hasTabLockOverride()
            ? { acquired: true, handle: { release: () => releaseHeld?.() } }
            : UNARBITRATED,
        );
      });
  });
}
