/**
 * Injectable platform seam for showing local reminder notifications (G3).
 *
 * Wraps the Notification API + the service-worker registration (`showNotification`) and the
 * optional Periodic Background Sync API behind a small interface, so
 * {@link ./useReminderNotifications} is unit-testable with a fake — no real browser, no real
 * permission prompt, no real notifications — exactly the `useWakeLock` / `useInstallPrompt`
 * `apiOverride` pattern.
 *
 * Notifications are shown through the **service worker registration**, not `new Notification()`:
 * that is the only form that works from an installed PWA and the only form whose
 * `notificationclick` the worker can handle to deep-link back into the app (see `sw.ts`).
 *
 * Every method degrades where the underlying API is missing or refuses — a rejected permission,
 * an unavailable worker, or a browser without Periodic Background Sync all resolve to a no-op
 * rather than throwing (§3, §6.1 graceful degradation). Degrading is not the same as hiding it:
 * {@link ReminderApi.registerPeriodicSync} resolves `false` when the browser refuses, so
 * Settings can tell the user their reminders have no background check behind them.
 */
import { hasNotifications, hasPeriodicSync } from '@/lib/env/feature-detection';
import type { PlannedReminder, ReminderPermission } from './reminders';
import { REMINDER_PERIODIC_SYNC_TAG } from './reminder-messages';

/**
 * Minimum interval (ms) between background reminder wake-ups. The browser treats this as a
 * lower bound and throttles to its own cadence (typically no more than daily); reminders are
 * not time-critical, so a generous half-day keeps the ask conservative.
 */
export const REMINDER_PERIODIC_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Injectable seam over notifications + periodic background sync. */
export interface ReminderApi {
  /** The Notification API + a service worker are both present. */
  readonly supported: boolean;
  /** The Periodic Background Sync API is present (best-effort background wake). */
  readonly periodicSyncSupported: boolean;
  /** Current notification permission for this origin. */
  permission(): ReminderPermission;
  /** Prompt for notification permission (a user gesture); resolves to the outcome. */
  requestPermission(): Promise<ReminderPermission>;
  /** Show a single reminder via the service-worker registration. Never throws. */
  show(reminder: PlannedReminder): Promise<void>;
  /** Whether a periodic-sync registration for our tag already exists. */
  isPeriodicSyncRegistered(): Promise<boolean>;
  /**
   * Register the background reminder wake-up (best-effort). Never throws; resolves `true` when
   * the registration was accepted and `false` when the browser refused it — the caller reports
   * that refusal rather than leaving the user believing background checks are running.
   */
  registerPeriodicSync(): Promise<boolean>;
  /** Remove the background reminder wake-up (best-effort). Never throws. */
  unregisterPeriodicSync(): Promise<void>;
}

// --- Minimal structural types for APIs the DOM lib does not (yet) model. ---

interface PeriodicSyncManagerLike {
  register(tag: string, options?: { minInterval?: number }): Promise<void>;
  unregister(tag: string): Promise<void>;
  getTags(): Promise<string[]>;
}

interface RegistrationWithPeriodicSync extends ServiceWorkerRegistration {
  periodicSync?: PeriodicSyncManagerLike;
}

function normalisePermission(value: NotificationPermission): ReminderPermission {
  return value === 'granted' || value === 'denied' ? value : 'default';
}

/** The real browser seam, feature-detected. */
export function browserReminderApi(): ReminderApi {
  const supported = hasNotifications();
  const periodicSyncSupported = hasPeriodicSync();

  const readyRegistration = async (): Promise<RegistrationWithPeriodicSync | null> => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    try {
      return (await navigator.serviceWorker.ready) as RegistrationWithPeriodicSync;
    } catch {
      return null;
    }
  };

  return {
    supported,
    periodicSyncSupported,

    permission: () => (supported ? normalisePermission(Notification.permission) : 'denied'),

    requestPermission: async () => {
      if (!supported) return 'denied';
      try {
        return normalisePermission(await Notification.requestPermission());
      } catch {
        return 'denied';
      }
    },

    show: async (reminder) => {
      const registration = await readyRegistration();
      if (!registration) return;
      try {
        await registration.showNotification(reminder.title, {
          body: reminder.body,
          // The tag replaces (rather than stacks) a prior notification for the same condition.
          tag: reminder.id,
          // Carried to the worker's `notificationclick` handler for deep-linking.
          data: { target: reminder.target },
        });
      } catch {
        // Unavailable / refused — degrade silently.
      }
    },

    isPeriodicSyncRegistered: async () => {
      if (!periodicSyncSupported) return false;
      const registration = await readyRegistration();
      if (!registration?.periodicSync) return false;
      try {
        return (await registration.periodicSync.getTags()).includes(REMINDER_PERIODIC_SYNC_TAG);
      } catch {
        return false;
      }
    },

    registerPeriodicSync: async () => {
      if (!periodicSyncSupported) return false;
      const registration = await readyRegistration();
      if (!registration?.periodicSync) return false;
      try {
        await registration.periodicSync.register(REMINDER_PERIODIC_SYNC_TAG, {
          minInterval: REMINDER_PERIODIC_SYNC_MIN_INTERVAL_MS,
        });
        return true;
      } catch {
        // Background-sync permission refused (Chrome declines a site it considers too little
        // used), or quota reached. Still no throw — but report the refusal so the caller can.
        return false;
      }
    },

    unregisterPeriodicSync: async () => {
      if (!periodicSyncSupported) return;
      const registration = await readyRegistration();
      if (!registration?.periodicSync) return;
      try {
        await registration.periodicSync.unregister(REMINDER_PERIODIC_SYNC_TAG);
      } catch {
        // Nothing to remove — degrade silently.
      }
    },
  };
}
