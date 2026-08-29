/**
 * The user's decision to stop waiting for cross-origin isolation (issue #260).
 *
 * Isolation decides which VFS the database opens on, not whether Gubbins runs (issue #255), so
 * the boot gate waits for it rather than committing an origin to the fallback the moment a
 * first visit looks un-isolated. That wait has to end somewhere: a service worker that never
 * takes control leaves the gate with a reading that can no longer change on its own, and a
 * spinner that never resolves is not an answer. So the screen offers the choice, and this
 * records it.
 *
 * `sessionStorage`, not `localStorage` — the same reasoning as the tab-lock override
 * (`db/tab-lock.ts`): the waiver applies to the tab the user made it in. It does not need to
 * outlive that tab, because the first boot it lets through creates a database in the fallback
 * store, and `detectDbStorageLayout` then keeps every later boot on it without being told.
 */
import { ISOLATION_WAIVER_KEY } from '@/lib/storage-keys';

/** Whether this tab has been told to stop waiting for isolation and boot on the fallback VFS. */
export function isolationWaived(): boolean {
  try {
    return sessionStorage.getItem(ISOLATION_WAIVER_KEY) === '1';
  } catch {
    // Blocked site data reads as "no waiver", which is right: it is diagnosed as its own cause
    // in `support-diagnosis.ts` and stops the boot long before isolation is considered.
    return false;
  }
}

/** Record the choice. The caller reloads, and the next boot skips the wait. */
export function waiveIsolation(): void {
  try {
    sessionStorage.setItem(ISOLATION_WAIVER_KEY, '1');
  } catch {
    // Nothing useful to do if storage refuses: the reload lands back on the same screen, having
    // changed nothing. See `setTabLockOverride`, which fails the same way for the same reason.
  }
}
