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
import {
  useLowStockItems,
  useExpiringItems,
  useExpiringCount,
  useDueMaintenance,
  useDueMaintenanceCount,
} from '@/features/lifecycle/hooks';
import { useLowStockCount } from '@/features/reports/queries';
import { getMaintenanceRepository } from '@/db/repositories';
// From its own module rather than the barrel, matching the hooks import above: the pure helper
// has no hook to mock, and a test that stubs the hook surface should not have to restate it.
import { effectiveExpiryDate } from '@/features/lifecycle/expiry';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePermissionCheck } from '@/features/users/usePermission';
import { WARRANTY_EXPIRING_SOON_DAYS } from '@/features/inventory/asset-lifecycle';
import { readAllPages, type AllPages } from '@/lib/read-all-pages';
import type { FieldDueDate, Item, MaintenanceScheduleWithItem } from '@/db/repositories/types';
import {
  buildAlerts,
  applyDismissals,
  pruneDismissals,
  maintenanceDueAtMs,
  type Alert,
  type AlertKind,
  type AlertSources,
  type ExpirySource,
  type FieldDueSource,
  type LowStockSource,
  type MaintenanceDueSource,
  type WarrantySource,
} from './alerts';
import { useDismissedAlertsStore } from './useDismissedAlertsStore';
import { nowMs } from '@/lib/clock';
import { useFormatters } from '@/lib/useFormatters';

/**
 * Each lane's row → alert-source projection, at module scope rather than inline in the hook.
 *
 * Two callers need them: the hook (which maps one bounded page per lane) and
 * {@link useAlerts}'s `readAllAlerts` (which maps every page for the export). Written once so
 * the file an export produces cannot describe a row differently from the card on screen.
 */
const toLowStockSources = (rows: readonly Item[]): LowStockSource[] =>
  rows.map((item) => ({ id: item.id, name: item.name }));

const toExpirySources = (rows: readonly Item[]): ExpirySource[] =>
  rows.map((item) => ({
    id: item.id,
    name: item.name,
    effectiveExpiryDate: effectiveExpiryDate(item.expiryDate, item.earliestBatchExpiryDate),
  }));

const toMaintenanceSources = (rows: readonly MaintenanceScheduleWithItem[]): MaintenanceDueSource[] =>
  rows.map((sched) => ({
    id: sched.id,
    name: sched.name,
    itemId: sched.itemId,
    itemName: sched.itemName,
    dueAtMs: maintenanceDueAtMs(sched.basis, sched.lastPerformedAt, sched.createdAt, sched.intervalDays),
  }));

const toWarrantySources = (rows: readonly Item[]): WarrantySource[] =>
  rows.map((item) => ({
    id: item.id,
    name: item.name,
    acquiredAt: item.acquiredAt,
    warrantyExpiresAt: item.warrantyExpiresAt,
    purchasePrice: item.purchasePrice,
    depreciationMonths: item.depreciationMonths,
  }));

const toFieldDueSources = (rows: readonly FieldDueDate[]): FieldDueSource[] =>
  rows.map((row) => ({
    itemId: row.itemId,
    itemName: row.itemName,
    defId: row.defId,
    fieldName: row.fieldName,
    leadDays: row.leadDays,
    dueAt: row.dueAt,
  }));

/** Which lanes this session may see at all — feature module on, and read permission held. */
interface AlertLaneGates {
  readonly lowStock: boolean;
  readonly expiry: boolean;
  readonly maintenance: boolean;
  readonly warranty: boolean;
  readonly fieldDue: boolean;
}

/**
 * Combines the five alert source feeds into a sorted, dismissal-filtered `Alert[]`.
 *
 * @param options.withTotals Also read each lane's `COUNT(*)`. Off by default: the always-mounted
 *   nav badge does not need them, and four extra queries on every screen would be pure cost.
 *   The alert centre asks for them, because it is the surface that *states* a figure per lane.
 *
 * @returns
 *   - `alerts`     — undismissed alerts, sorted by severity then dueAt.
 *   - `allAlerts`  — all alerts before dismissal filtering (for the badge count).
 *   - `isLoading`  — true while any source query is still loading.
 *   - `isError`    — true when any source query errored.
 *   - `truncatedKinds` — the lanes showing a prefix of their feed rather than the whole of it:
 *     the four paged lanes when a further page exists, and `field-due` when its read-everything
 *     walk hit the `readAllPages` ceiling. Surfaced rather than swallowed: a feed that quietly
 *     stops at a page boundary reads as "that's everything" when it isn't (issues #606/#607).
 *   - `laneTotals` — each lane's real total, or `undefined` when totals were not asked for (or
 *     have not loaded). It is what a lane's own `COUNT(*)` says, so it counts the rows the feed
 *     selects — a hair above the cards shown, since a lane builder re-grades each row and can
 *     drop one whose status has moved since the page was cached.
 *   - `readAllAlerts` — re-read **every** page of every lane and rebuild the feed, for the
 *     export. Not a hook; call it from an export's `build` callback.
 */
export function useAlerts(options: { withTotals?: boolean } = {}): {
  readonly alerts: Alert[];
  readonly allAlerts: Alert[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly truncatedKinds: ReadonlySet<AlertKind>;
  readonly laneTotals: Partial<Record<AlertKind, number>>;
  readonly readAllAlerts: () => Promise<AllPages<Alert>>;
} {
  const now = nowMs();
  // Every date in the alert copy goes through the shared formatter seam, so it reads in the user's
  // locale rather than as a raw ISO day. It also settles the maintenance lane's disagreement with
  // the agenda, the schedule editor and the calendar feed, which all read its wall-clock due
  // instant in the local zone (issue #497; `alert-agenda-date-parity.test.ts` holds that).
  const fmt = useFormatters();

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
  // even if a stale cache entry from when it was on still holds rows. The feature set is read
  // once (unconditionally — rules of hooks).
  //
  // Each lane is *also* gated on the read permission of whatever it draws from (issue #522).
  // Alerts is one of two screens that aggregate several subjects rather than showing one, so it
  // carries no read gate of its own — the gate has to be per lane, or a role that cannot open
  // Maintenance would still read its due schedules here. Folding the permission into the same
  // boolean keeps the fetch, the source array and the completeness grading in step.
  const enabled = useEnabledFeatures();
  const allows = usePermissionCheck();
  const itemsReadable = allows('items:read');
  const gates: AlertLaneGates = {
    lowStock: itemsReadable,
    expiry: enabled.has('perishables') && itemsReadable,
    maintenance: enabled.has('maintenance') && allows('maintenance:read'),
    warranty: enabled.has('warranty') && itemsReadable,
    fieldDue: enabled.has('custom-fields') && itemsReadable,
  };
  const { lowStock: lowStockOn, expiry: perishablesOn, warranty: warrantyOn } = gates;
  const { maintenance: maintenanceOn, fieldDue: customFieldsOn } = gates;

  const lowStockQuery = useLowStockItems({ qtyThreshold, gaugePercent }, { enabled: lowStockOn });
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

  /**
   * Each lane's real total, read only when a caller asks for one (see `withTotals`). The paged
   * lanes above hand back at most one page, so a screen stating "N low stock" over them was
   * stating the page size the moment an inventory grew past it (issue #606). The counts run the
   * same predicates the feeds select with, so a total and its rows answer the same question.
   *
   * `field-due` has no count: that lane already walks every page, so its rows *are* its total
   * unless the `readAllPages` ceiling stopped the walk, which it reports itself.
   */
  const wantTotals = options.withTotals ?? false;
  const lowStockTotal = useLowStockCount({ enabled: wantTotals && lowStockOn });
  const expiringTotal = useExpiringCount(expirySoonWindowDays, { enabled: wantTotals && perishablesOn });
  const maintenanceTotal = useDueMaintenanceCount({ enabled: wantTotals && maintenanceOn });
  const warrantyTotal = useQuery({
    queryKey: inventoryKeys.warrantyExpiringCount(),
    queryFn: () => getItemRepository().countWarrantyExpiring(WARRANTY_EXPIRING_SOON_DAYS, now),
    enabled: wantTotals && warrantyOn,
  });

  const laneTotals: Partial<Record<AlertKind, number>> = {
    'low-stock': lowStockTotal.data,
    expiry: expiringTotal.data,
    'maintenance-due': maintenanceTotal.data,
    'warranty-due': warrantyTotal.data,
  };

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
    lowStock: lowStockOn ? toLowStockSources(lowStockQuery.data?.rows ?? []) : [],
    expiring: perishablesOn ? toExpirySources(expiringQuery.data?.rows ?? []) : [],
    maintenanceDue: maintenanceOn ? toMaintenanceSources(maintenanceDueQuery.data?.rows ?? []) : [],
    warrantyItems: warrantyOn ? toWarrantySources(warrantyQuery.data?.rows ?? []) : [],
    fieldDue: customFieldsOn ? toFieldDueSources(fieldDueQuery.data?.rows ?? []) : [],
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
  if (complete(lowStockQuery, lowStockOn)) completeKinds.add('low-stock');
  if (complete(expiringQuery, perishablesOn)) completeKinds.add('expiry');
  if (complete(maintenanceDueQuery, maintenanceOn)) completeKinds.add('maintenance-due');
  if (complete(warrantyQuery, warrantyOn)) completeKinds.add('warranty-due');
  // The field-due lane walks every page rather than reading one, so its completeness is the
  // absence of the `readAllPages` ceiling, not a `hasMore` flag.
  if (customFieldsOn && fieldDueQuery.data?.truncated === false) completeKinds.add('field-due');

  // --- Dismissals ---

  const dismissals = useDismissedAlertsStore((s) => s.dismissals);

  const allAlerts = buildAlerts(sources, now, fmt);
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

  /**
   * The mirror image of {@link completeKinds}: lanes that have answered and said there is more
   * behind what they returned. Only meaningful once a lane is on and has loaded — a disabled or
   * still-loading lane is not "truncated", it simply has nothing to say yet — so `hasMore` is
   * again read strictly rather than negating `complete`, which would grade every unloaded lane
   * as cut short.
   */
  const truncatedKinds = new Set<AlertKind>();
  if (lowStockOn && lowStockQuery.data?.hasMore === true) truncatedKinds.add('low-stock');
  if (perishablesOn && expiringQuery.data?.hasMore === true) truncatedKinds.add('expiry');
  if (maintenanceOn && maintenanceDueQuery.data?.hasMore === true) truncatedKinds.add('maintenance-due');
  if (warrantyOn && warrantyQuery.data?.hasMore === true) truncatedKinds.add('warranty-due');
  if (customFieldsOn && fieldDueQuery.data?.truncated === true) truncatedKinds.add('field-due');

  /**
   * Re-read every page of every lane and rebuild the feed — the export's read (issue #606).
   *
   * The alert centre's export used to serialise the array the hook is holding, under a comment
   * claiming the hook held the whole list. It does not: four of the five lanes are one bounded
   * page, so the file stopped at the cap while every sibling list export on the screen already
   * re-read its list through `exportEveryPage`. This is that walk, over five feeds instead of
   * one, and it reports its own ceiling so a file that *does* stop short says so.
   *
   * Dismissals are applied exactly as they are on screen: an alert the user has explicitly set
   * aside reappearing in the file would defeat the point of setting it aside. They are read from
   * the store at call time rather than closed over, so an alert dismissed since the last render
   * stays out.
   *
   * A lane whose module is off — or whose subject this session may not read — is not fetched at
   * all, matching the screen: the export can never contain a lane the screen would refuse to.
   */
  const readAllAlerts = async (): Promise<AllPages<Alert>> => {
    const at = nowMs();
    const none = { rows: [], truncated: false } as const;
    const items = getItemRepository();
    const [low, expiring, maintenance, warranty, fieldDue] = await Promise.all([
      gates.lowStock
        ? readAllPages((page) => items.listLowStock({ qtyThreshold, gaugePercent }, page))
        : none,
      gates.expiry ? readAllPages((page) => items.listExpiringWithin(expirySoonWindowDays, at, page)) : none,
      gates.maintenance ? readAllPages((page) => getMaintenanceRepository().listDue(at, page)) : none,
      gates.warranty
        ? readAllPages((page) => items.listWarrantyExpiring(WARRANTY_EXPIRING_SOON_DAYS, at, page))
        : none,
      gates.fieldDue ? readAllPages((page) => items.listFieldDueDates(at, page)) : none,
    ]);
    const built = buildAlerts(
      {
        lowStock: toLowStockSources(low.rows),
        expiring: toExpirySources(expiring.rows),
        maintenanceDue: toMaintenanceSources(maintenance.rows),
        warrantyItems: toWarrantySources(warranty.rows),
        fieldDue: toFieldDueSources(fieldDue.rows),
      },
      at,
      fmt,
    );
    return {
      rows: applyDismissals(built, useDismissedAlertsStore.getState().dismissals, at),
      truncated: [low, expiring, maintenance, warranty, fieldDue].some((lane) => lane.truncated),
    };
  };

  return { alerts, allAlerts, isLoading, isError, truncatedKinds, laneTotals, readAllAlerts };
}
