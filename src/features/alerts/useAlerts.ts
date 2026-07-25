/**
 * useAlerts — data hook for the alert centre (Phase 68, spec §3).
 *
 * Fetches the four alert source feeds via existing repository hooks and runs
 * `buildAlerts` + `applyDismissals` to produce a ready-to-render `Alert[]`.
 * Reuses the hooks wired in Phase 9 (`useLowStockItems`, `useExpiringItems`,
 * `useDueMaintenance`) so no new repository SQL is introduced except for the
 * warranty lane (`listWarrantyExpiring`, added to feeds.ts as the only new
 * SQL query genuinely required — no existing method covered warranty expiry).
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItemRepository } from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { useLowStockItems, useExpiringItems, useDueMaintenance } from '@/features/lifecycle';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { WARRANTY_EXPIRING_SOON_DAYS } from '@/features/inventory/asset-lifecycle';
import {
  buildAlerts,
  applyDismissals,
  pruneDismissals,
  maintenanceDueAtMs,
  type Alert,
  type AlertSources,
} from './alerts';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';
import { nowMs } from '@/lib/clock';

/**
 * Combines the four alert source feeds into a sorted, dismissal-filtered `Alert[]`.
 *
 * @returns
 *   - `alerts`     — undismissed alerts, sorted by severity then dueAt.
 *   - `allAlerts`  — all alerts before dismissal filtering (for the badge count).
 *   - `isLoading`  — true while any source query is still loading.
 *   - `isError`    — true when any source query errored.
 */
export function useAlerts(): {
  readonly alerts: Alert[];
  readonly allAlerts: Alert[];
  readonly isLoading: boolean;
  readonly isError: boolean;
} {
  const now = nowMs();

  // --- Source queries ---
  //
  // Reuse the exact dashboard widget hooks (with the same user-tuned thresholds/window) so
  // the alert feeds and the widgets share one cache entry each rather than double-fetching
  // the same data under slightly different keys. It also keeps the badge/alert counts in
  // step with what the Low-stock / Soon-to-expire widgets show. Warranty has no widget, so
  // it stays a bespoke query here.
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);

  // Modular UI (Phase 7): the expiry, maintenance and warranty lanes each gate on their
  // capability. When one is off we skip its source fetch (`enabled: false`) AND feed an empty
  // array into the pure `buildAlerts` seam below, so a disabled lane simply produces nothing —
  // even if a stale cache entry from when it was on still holds rows. Low stock is core
  // inventory and never gated. The feature set is read once (unconditionally — rules of hooks).
  const enabled = useEnabledFeatures();
  const perishablesOn = enabled.has('perishables');
  const maintenanceOn = enabled.has('maintenance');
  const warrantyOn = enabled.has('warranty');

  const lowStockQuery = useLowStockItems({ qtyThreshold, gaugePercent });
  const expiringQuery = useExpiringItems(expirySoonWindowDays, { enabled: perishablesOn });
  const maintenanceDueQuery = useDueMaintenance({ enabled: maintenanceOn });

  const warrantyQuery = useQuery({
    queryKey: inventoryKeys.warrantyExpiring(),
    queryFn: () => getItemRepository().listWarrantyExpiring(WARRANTY_EXPIRING_SOON_DAYS, now, { limit: 100 }),
    enabled: warrantyOn,
  });

  const isLoading =
    lowStockQuery.isLoading ||
    expiringQuery.isLoading ||
    maintenanceDueQuery.isLoading ||
    warrantyQuery.isLoading;

  const isError =
    lowStockQuery.isError || expiringQuery.isError || maintenanceDueQuery.isError || warrantyQuery.isError;

  // --- Build alert sources from query data ---

  const sources: AlertSources = {
    lowStock: (lowStockQuery.data?.rows ?? []).map((item) => ({
      id: item.id,
      name: item.name,
    })),

    expiring: perishablesOn
      ? (expiringQuery.data?.rows ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          expiryDate: item.expiryDate ?? null,
        }))
      : [],

    maintenanceDue: maintenanceOn
      ? (maintenanceDueQuery.data?.rows ?? []).map((sched) => ({
          id: sched.id,
          name: sched.name,
          itemId: sched.itemId,
          itemName: sched.itemName,
          dueAtMs: maintenanceDueAtMs(
            sched.basis,
            sched.lastPerformedAt,
            sched.createdAt,
            sched.intervalDays,
          ),
        }))
      : [],

    warrantyItems: warrantyOn
      ? (warrantyQuery.data?.rows ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          acquiredAt: item.acquiredAt,
          warrantyExpiresAt: item.warrantyExpiresAt,
          purchasePrice: item.purchasePrice,
          depreciationMonths: item.depreciationMonths,
        }))
      : [],
  };

  // --- Dismissals ---

  const dismissals = useDismissedAlertsStore((s) => s.dismissals);

  const allAlerts = buildAlerts(sources, now);
  const alerts = applyDismissals(allAlerts, dismissals, now);

  // Keep the dismissal records bounded (issue #134). Reconciling them against the live feed on
  // every settled pass — the same shape `planReminders` uses for `useNotifiedRemindersStore` —
  // retires elapsed snoozes and records whose alert stopped firing long ago, so a dismissal no
  // longer outlives the item that raised it. It runs from the hook rather than the screen so the
  // always-mounted nav badge does the housekeeping too, not just a visit to the alert centre.
  // `pruneDismissals` returns null when there is nothing to drop, so the store write below can
  // never re-trigger this effect in a loop.
  const settled = !isLoading && !isError;
  const liveIdKey = allAlerts.map((a) => a.id).join('\n');
  useEffect(() => {
    if (!settled) return;
    const store = useDismissedAlertsStore.getState();
    const liveIds = new Set(liveIdKey === '' ? [] : liveIdKey.split('\n'));
    const pruned = pruneDismissals(store.dismissals, liveIds, nowMs());
    if (pruned) store.replace(pruned);
  }, [settled, liveIdKey]);

  return { alerts, allAlerts, isLoading, isError };
}
