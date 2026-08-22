/**
 * useAlerts — data hook for the alert centre (Phase 68, spec §3).
 *
 * Fetches the five alert source feeds via existing repository hooks and runs
 * `buildAlerts` + `applyDismissals` to produce a ready-to-render `Alert[]`.
 * Reuses the hooks wired in Phase 9 (`useLowStockItems`, `useExpiringItems`,
 * `useDueMaintenance`) so no new repository SQL is introduced except for the
 * warranty lane (`listWarrantyExpiring`, added to feeds.ts as the only new
 * SQL query genuinely required — no existing method covered warranty expiry)
 * and the custom-field due-date lane (`listFieldDueDates`, W1a).
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getItemRepository } from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { useLowStockItems, useExpiringItems, useDueMaintenance } from '@/features/lifecycle';
// Imported from the module rather than the barrel: the pure helper has no hook to mock, and a
// test that stubs the whole `@/features/lifecycle` surface should not have to restate it.
import { effectiveExpiryDate } from '@/features/lifecycle/expiry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { WARRANTY_EXPIRING_SOON_DAYS } from '@/features/inventory/asset-lifecycle';
import { readAllPages } from '@/lib/read-all-pages';
import {
  buildAlerts,
  applyDismissals,
  pruneDismissals,
  maintenanceDueAtMs,
  type Alert,
  type AlertKind,
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
 *   - `fieldDueTruncated` — true when the custom-field due-date read hit its ceiling, so that
 *     lane is showing a prefix rather than the whole set. Surfaced rather than swallowed: a
 *     feed that quietly stops at a page boundary reads as "that's everything" when it isn't
 *     (issues #606/#607).
 */
export function useAlerts(): {
  readonly alerts: Alert[];
  readonly allAlerts: Alert[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly fieldDueTruncated: boolean;
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
  const customFieldsOn = enabled.has('custom-fields');

  const lowStockQuery = useLowStockItems({ qtyThreshold, gaugePercent });
  const expiringQuery = useExpiringItems(expirySoonWindowDays, { enabled: perishablesOn });
  const maintenanceDueQuery = useDueMaintenance({ enabled: maintenanceOn });

  const warrantyQuery = useQuery({
    queryKey: inventoryKeys.warrantyExpiring(),
    queryFn: () => getItemRepository().listWarrantyExpiring(WARRANTY_EXPIRING_SOON_DAYS, now, { limit: 100 }),
    enabled: warrantyOn,
  });

  /**
   * Opted-in custom-field due dates (W1a). Unlike the four lanes above this walks **every**
   * page rather than reading one and calling it the feed: the number of items carrying a due
   * date is bounded by what the user has defined, not by a page size, and a lane that stopped
   * at row 100 would show a short list with nothing saying so. `readAllPages` reports its own
   * ceiling instead, which the screen surfaces (issues #606/#607).
   *
   * The repository applies each definition's own lead time, so this asks for no horizon: the
   * feed is exactly "the dates that are due or overdue by their owner's rules".
   */
  const fieldDueQuery = useQuery({
    queryKey: inventoryKeys.fieldDueDatesWithin(null),
    queryFn: () => readAllPages((page) => getItemRepository().listFieldDueDates(now, page)),
    enabled: customFieldsOn,
  });

  const isLoading =
    lowStockQuery.isLoading ||
    expiringQuery.isLoading ||
    maintenanceDueQuery.isLoading ||
    warrantyQuery.isLoading ||
    fieldDueQuery.isLoading;

  const isError =
    lowStockQuery.isError ||
    expiringQuery.isError ||
    maintenanceDueQuery.isError ||
    warrantyQuery.isError ||
    fieldDueQuery.isError;

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
          effectiveExpiryDate: effectiveExpiryDate(item.expiryDate, item.earliestBatchExpiryDate),
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

    fieldDue: customFieldsOn
      ? (fieldDueQuery.data?.rows ?? []).map((row) => ({
          itemId: row.itemId,
          itemName: row.itemName,
          defId: row.defId,
          fieldName: row.fieldName,
          leadDays: row.leadDays,
          dueAt: row.dueAt,
        }))
      : [],
  };

  /**
   * Which lanes were read **whole** this pass — fetched (not gated off), settled, and with no
   * further page behind them. `pruneDismissals` uses it to tell a condition that has resolved
   * from a feed that simply is not showing it (issue #644): the four paged lanes below read a
   * single page, so a big enough inventory can push a still-live alert past the ceiling, and a
   * lane whose module is off returns nothing at all. Only a lane that answered in full licenses
   * reading "absent" as "gone".
   *
   * `hasMore` is checked strictly, so a feed that has not answered yet — `data` undefined —
   * counts as incomplete rather than as an empty world. It is required rather than optional in
   * the parameter type, so a feed whose envelope has no such field is a compile error here rather
   * than a lane that silently never grades complete.
   */
  const complete = (query: { data?: { hasMore: boolean } }, laneOn = true): boolean =>
    laneOn && query.data?.hasMore === false;

  const completeKinds = new Set<AlertKind>();
  if (complete(lowStockQuery)) completeKinds.add('low-stock');
  if (complete(expiringQuery, perishablesOn)) completeKinds.add('expiry');
  if (complete(maintenanceDueQuery, maintenanceOn)) completeKinds.add('maintenance-due');
  if (complete(warrantyQuery, warrantyOn)) completeKinds.add('warranty-due');
  // The field-due lane walks every page rather than reading one, so its completeness is the
  // absence of the `readAllPages` ceiling, not a `hasMore` flag.
  if (customFieldsOn && fieldDueQuery.data?.truncated === false) completeKinds.add('field-due');

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
  // The complete-lane set is threaded through as a string for the same reason as the ids: the
  // effect must re-run when its *contents* change, not on every render that rebuilds an equal Set.
  const completeKindKey = [...completeKinds].sort().join(',');
  useEffect(() => {
    if (!settled) return;
    const store = useDismissedAlertsStore.getState();
    const liveIds = new Set(liveIdKey === '' ? [] : liveIdKey.split('\n'));
    const kinds = new Set(completeKindKey === '' ? [] : (completeKindKey.split(',') as AlertKind[]));
    const pruned = pruneDismissals(store.dismissals, liveIds, nowMs(), kinds);
    if (pruned) store.replace(pruned);
  }, [settled, liveIdKey, completeKindKey]);

  // Only meaningful while the lane is on and has actually loaded; a disabled or still-loading
  // lane is not "truncated", it simply has nothing to say yet.
  const fieldDueTruncated = customFieldsOn && (fieldDueQuery.data?.truncated ?? false);

  return { alerts, allAlerts, isLoading, isError, fieldDueTruncated };
}
