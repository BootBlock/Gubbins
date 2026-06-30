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
import { useQuery } from '@tanstack/react-query';
import {
  getItemRepository,
  getMaintenanceRepository,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { WARRANTY_EXPIRING_SOON_DAYS } from '@/features/inventory/asset-lifecycle';
import {
  EXPIRY_SOON_WINDOW_DAYS,
} from '@/db/repositories/constants';
import {
  buildAlerts,
  applyDismissals,
  maintenanceDueAtMs,
  type Alert,
  type AlertSources,
} from './alerts';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';

/** TanStack Query key for the warranty-expiring feed. */
const warrantyExpiringKey = () =>
  [...inventoryKeys.all, 'warranty-expiring'] as const;

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
  const now = Date.now();

  // --- Source queries (reuse existing hooks/query keys where possible) ---

  const lowStockQuery = useQuery({
    queryKey: [...inventoryKeys.lowStock(), null],
    queryFn: () => getItemRepository().listLowStock({}, { limit: 100 }),
  });

  const expiringQuery = useQuery({
    queryKey: [...inventoryKeys.expiring(), EXPIRY_SOON_WINDOW_DAYS],
    queryFn: () =>
      getItemRepository().listExpiringWithin(EXPIRY_SOON_WINDOW_DAYS, now, { limit: 100 }),
  });

  const maintenanceDueQuery = useQuery({
    queryKey: inventoryKeys.maintenanceDue(),
    queryFn: () => getMaintenanceRepository().listDue(now, { limit: 100 }),
  });

  const warrantyQuery = useQuery({
    queryKey: warrantyExpiringKey(),
    queryFn: () =>
      getItemRepository().listWarrantyExpiring(WARRANTY_EXPIRING_SOON_DAYS, now, { limit: 100 }),
  });

  const isLoading =
    lowStockQuery.isLoading ||
    expiringQuery.isLoading ||
    maintenanceDueQuery.isLoading ||
    warrantyQuery.isLoading;

  const isError =
    lowStockQuery.isError ||
    expiringQuery.isError ||
    maintenanceDueQuery.isError ||
    warrantyQuery.isError;

  // --- Build alert sources from query data ---

  const sources: AlertSources = {
    lowStock: (lowStockQuery.data?.rows ?? []).map((item) => ({
      id: item.id,
      name: item.name,
    })),

    expiring: (expiringQuery.data?.rows ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      expiryDate: item.expiryDate ?? null,
    })),

    maintenanceDue: (maintenanceDueQuery.data?.rows ?? []).map((sched) => ({
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
    })),

    warrantyItems: (warrantyQuery.data?.rows ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      acquiredAt: item.acquiredAt,
      warrantyExpiresAt: item.warrantyExpiresAt,
      purchasePrice: item.purchasePrice,
      depreciationMonths: item.depreciationMonths,
    })),
  };

  // --- Dismissals ---

  const dismissedIds = useDismissedAlertsStore((s) => s.dismissedIds);

  const allAlerts = buildAlerts(sources, now);
  const alerts = applyDismissals(allAlerts, dismissedIds);

  return { alerts, allAlerts, isLoading, isError };
}
