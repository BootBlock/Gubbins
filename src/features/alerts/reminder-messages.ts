/**
 * Shared constants for the reminder notification click channel (G3).
 *
 * Isolated in their own tiny module so **both** the service worker (`sw.ts`) and the client
 * ({@link ./ReminderNotifications}) can import them without the client pulling in worker-only
 * code or the worker pulling in React — one source of truth for the message type + click route.
 */

/** The `postMessage` type the SW sends an open window when a reminder notification is clicked. */
export const REMINDER_CLICK_MESSAGE = 'GUBBINS_REMINDER_CLICK';

/**
 * The `postMessage` type the SW broadcasts on a Periodic Background Sync wake, asking any live
 * (possibly backgrounded) window to re-check its alert feeds so fresh reminders can fire. The
 * worker itself cannot compute alerts — the inventory database is only reachable from the app —
 * so this is the honest ceiling without a backend: it re-checks where a client is alive, and is
 * a no-op where the app is fully closed (as with the deferred Web Push path).
 */
export const REMINDER_SYNC_MESSAGE = 'GUBBINS_REMINDER_SYNC';

/** Where a reminder notification points when it carries no specific route (defensive fallback). */
export const REMINDER_FALLBACK_ROUTE = '/alerts';

/**
 * The Periodic Background Sync tag under which the worker's reminder re-check is registered.
 * Lives here (not in `reminder-api.ts`) so the worker can filter `periodicsync` events by it
 * without importing the client-only, feature-detection-heavy notification seam.
 */
export const REMINDER_PERIODIC_SYNC_TAG = 'gubbins-reminders';
