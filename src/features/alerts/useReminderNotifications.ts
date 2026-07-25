/**
 * The glue that turns the alert feed into OS notifications (G3).
 *
 * Two hooks, both thin DOM-glue over the pure {@link planReminders} / {@link periodicSyncAction}
 * decisions (the `useWakeLock` pattern):
 *
 * - {@link useReminderFiring} reads the live (undismissed) alert feed and fires whatever
 *   `planReminders` says through the injectable {@link ReminderApi} seam. It only pulls the four
 *   alert-source queries (`useAlerts`) while it is mounted, so the caller mounts it **only when
 *   reminders are enabled** — an opt-in, off-by-default feature never runs those queries.
 * - {@link useReminderPeriodicSync} reconciles the best-effort Periodic Background Sync
 *   registration against the opt-in; it stays mounted regardless so turning reminders off
 *   actually tears the registration down.
 *
 * Firing is idempotent per condition: the reconciled "already notified" set is read from — and
 * written straight back to — the store synchronously, so a re-render (or a dev/StrictMode
 * double-invoke of the effect) recomputes an empty plan rather than re-firing.
 */
import { useEffect, useRef } from 'react';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useAlerts } from './useAlerts';
import { useNotifiedRemindersStore } from './useNotifiedRemindersStore';
import { type ReminderApi } from './reminder-api';
import { useReminderWakeStore, type ReminderWakeStatus } from './useReminderWakeStore';
import { planReminders, periodicSyncAction } from './reminders';

/** Whether a persisted id set already equals the reconciled array (avoids redundant writes). */
function sameIds(set: ReadonlySet<string>, ids: readonly string[]): boolean {
  return set.size === ids.length && ids.every((id) => set.has(id));
}

/**
 * Fire due reminder notifications from the alert feed. Mount only while reminders are enabled
 * so the source queries don't run otherwise. Pass a fake `api` in tests.
 */
export function useReminderFiring(api: ReminderApi): void {
  const enabled = usePreferencesStore((s) => s.remindersEnabled);
  const kinds = usePreferencesStore((s) => s.reminderKinds);
  const { alerts } = useAlerts();

  // `useAlerts` returns a fresh array every render; derive a stable signature of the ids +
  // lanes so the fire effect only re-runs when the feed actually changes, not on every render.
  const signature = alerts.map((a) => `${a.id} ${a.kind}`).join('');
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;

  useEffect(() => {
    if (!api.supported) return;
    // Read the latest notified set from the store (not a render closure) so a StrictMode
    // double-invoke — or any re-entrancy — sees ids marked by the previous pass.
    const notified = useNotifiedRemindersStore.getState().notifiedIds;
    const plan = planReminders(
      alertsRef.current,
      { enabled, kinds },
      { supported: api.supported, permission: api.permission() },
      notified,
    );

    // Persist the reconciled set first (synchronously marks fired ids notified) so anything that
    // recomputes before this render commits sees them and cannot re-fire.
    if (!sameIds(notified, plan.nextNotified)) {
      useNotifiedRemindersStore.getState().replace(plan.nextNotified);
    }

    for (const reminder of plan.toFire) void api.show(reminder);
    // `signature` stands in for the `alerts` array (whose identity changes every render);
    // `alertsRef` supplies the live objects, so it is intentionally not a dependency.
  }, [api, enabled, kinds, signature]);
}

/**
 * Reconcile the best-effort Periodic Background Sync registration against the reminder opt-in.
 * Mounted regardless of the opt-in so turning reminders off unregisters the background wake.
 *
 * The outcome is recorded in {@link useReminderWakeStore} so Settings can say that a wanted
 * background wake was refused, rather than showing an unqualified "on" over reminders that only
 * arrive while Gubbins is open.
 */
export function useReminderPeriodicSync(api: ReminderApi, enabled: boolean): void {
  useEffect(() => {
    if (!api.periodicSyncSupported) return;
    let cancelled = false;
    const report = (status: ReminderWakeStatus) => {
      if (!cancelled) useReminderWakeStore.getState().setStatus(status);
    };

    void (async () => {
      const registered = await api.isPeriodicSyncRegistered();
      if (cancelled) return;
      const action = periodicSyncAction({
        enabled,
        permission: api.permission(),
        supported: api.periodicSyncSupported,
        registered,
      });
      if (action === 'register') report((await api.registerPeriodicSync()) ? 'registered' : 'unavailable');
      else if (action === 'unregister') {
        await api.unregisterPeriodicSync();
        report('unknown');
      } else report(registered ? 'registered' : 'unknown');
    })().catch(() => {
      // The seam is contracted never to throw, but it is injectable and this hook is mounted
      // app-wide: an unobserved rejection would be an unhandled one, and would leave the
      // background wake in a state nothing reports. Treat a throw as a refusal.
      report('unavailable');
    });

    return () => {
      cancelled = true;
    };
  }, [api, enabled]);
}
