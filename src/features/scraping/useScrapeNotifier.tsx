/**
 * Passive scrape notifications (spec §4 — default "Passive Toast Notification",
 * user-configurable). Honours the `scrapeNotifications` preference: a `TOAST` user
 * gets a brief success toast; a `SILENT` user gets none (the scrape still applies and
 * is recorded in the Activity Ledger).
 */
import { useCallback } from 'react';
import { useToast } from '@/components/foundry';
import { SuccessIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

export function useScrapeNotifier() {
  const { show } = useToast();
  const mode = usePreferencesStore((s) => s.scrapeNotifications);

  return useCallback(
    (summary: string) => {
      if (mode === 'SILENT') return;
      show({ tone: 'success', icon: <SuccessIcon />, heading: 'Supplier data applied', message: summary });
    },
    [mode, show],
  );
}
