/**
 * ReminderNotifications — the app-wide mount point for local reminder notifications (G3).
 *
 * Renders nothing; it exists to run {@link useReminderNotifications} once, high in the tree
 * (inside the boot gate, so the alert feeds it reads have a ready database), so reminders fire
 * regardless of which screen is open — not only while the alert centre or dashboard is mounted.
 *
 * It also handles a notification **click** that arrives while a window is open: the service
 * worker focuses the window and posts a `GUBBINS_REMINDER_CLICK` message with the alert's
 * target, which this component turns into the same deep-link the in-app alert cards use (seed
 * the inventory search, navigate, flash the item).
 */
import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { router } from '@/app/router';
import { requestHighlight } from '@/lib/highlight';
import { useInventoryEntry } from '@/features/inventory/useInventoryEntry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useReminderFiring, useReminderPeriodicSync } from './useReminderNotifications';
import { browserReminderApi, type ReminderApi } from './reminder-api';
import { REMINDER_CLICK_MESSAGE, REMINDER_SYNC_MESSAGE } from './reminder-messages';
import type { AlertTarget } from './alerts';

/** Runs the alert-feed-consuming firing; mounted only while reminders are enabled. */
function ReminderFirer({ api }: { readonly api: ReminderApi }) {
  useReminderFiring(api);
  return null;
}

export function ReminderNotifications() {
  const api = useMemo(() => browserReminderApi(), []);
  const enabled = usePreferencesStore((s) => s.remindersEnabled);
  const queryClient = useQueryClient();

  // Keep the background-wake registration in step with the opt-in (best-effort, always mounted).
  useReminderPeriodicSync(api, enabled);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; target?: AlertTarget } | null;

      // A notification was clicked while a window was open: deep-link to its target — the same
      // landing the alert-centre "View in inventory" link produces (seed search, navigate, flash).
      if (data?.type === REMINDER_CLICK_MESSAGE && data.target) {
        const { route, itemId, itemName } = data.target;
        if (itemName) useInventoryEntry.getState().requestSearch(itemName);
        void router.navigate({ to: route });
        if (itemId) requestHighlight(itemId);
        return;
      }

      // A Periodic Background Sync wake asked us to re-check: refetch the alert feeds so the
      // reminder hook re-runs against fresh data and any newly-due reminder can fire.
      if (data?.type === REMINDER_SYNC_MESSAGE) {
        void queryClient.invalidateQueries();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [queryClient]);

  // Only pull the four alert-source queries when reminders are actually on (and can be shown) —
  // an off-by-default feature never runs them.
  return api.supported && enabled ? <ReminderFirer api={api} /> : null;
}
