/**
 * TanStack Query hooks for the §3 Reports screen (inventory-depth Phase 61). Each report
 * is a read-only aggregation over data already stored, fetched through `ReportRepository`
 * (never raw SQL in the component). The low-stock count honours the user-tuned Tier-2
 * thresholds (Phase 46), so the Reports figure agrees with the dashboard widget.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getReportRepository } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { reportKeys } from './keys';
import type { CatalogueScope, CataloguePartsOptions } from './parts-catalogue';
import { scheduleSlices, type ScheduleGroupSummary, type ScheduleLine } from './insurance-schedule';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants';

// The `['reports', …]` prefix is the SSOT in ./keys — every key below is built from it so
// that invalidating the prefix (see `invalidateItems`) provably refreshes all of them.
export { reportKeys } from './keys';

// The selectable analytics windows live in their own dependency-free module (SSOT) so the
// preferences store can share them without importing back through this store-consuming module.
export {
  ANALYTICS_WINDOWS,
  DEFAULT_ANALYTICS_WINDOW,
  normaliseAnalyticsWindow,
  type AnalyticsWindow,
} from './analytics-windows';
import { DEFAULT_ANALYTICS_WINDOW } from './analytics-windows';

/**
 * Trailing-window length (days) for the consumption report, and the fallback default for
 * {@link useMovement}. The movement chart itself no longer uses it: since issue #86 both the
 * Reports screen and the CSV export pass the user's selected `reportsMovementWindow`.
 */
export const REPORT_WINDOW_DAYS = 30;
/**
 * Number of time buckets in the movement chart. Fixed, so the bar width follows the selected
 * window (issue #86) — roughly half a day per bar at 7d, a little over three weeks at 365d.
 */
export const REPORT_MOVEMENT_BUCKETS = 15;
// The default "no movement in N days" cutoff for the dead-stock report. The live value is
// the user-tunable preference (issue #92) — this is only the starting value — and lives in
// the dependency-free constants module so the preferences store can share it without
// importing back through this store-consuming module.
export { DEAD_STOCK_SINCE_DAYS } from '@/db/repositories/constants';

// Phase 74 — advanced analytics ------------------------------------------------
/** Annual window (days) for ABC analysis — the standard "annual consumption value" basis. */
export const ABC_WINDOW_DAYS = 365;
/** Number of reconstructed samples on the valuation-trend sparkline. */
export const VALUATION_TREND_POINTS = 12;

// Phase 77 — data-hygiene / quality report -------------------------------------
/** Records with no activity for at least this many days count as "stale" (≈ six months). */
export const DATA_HYGIENE_STALE_DAYS = 180;

// Phase 79 — procurement / spend analytics -------------------------------------
/** Number of time buckets in the spend-over-time strip (≈ one bar per couple of days at 90d). */
export const SPEND_BUCKETS = 15;

// Sales & disposals — proceeds vs cost margin ----------------------------------
/**
 * Number of time buckets in the sales-over-time strip (mirrors the spend strip).
 *
 * @internal Exported for unit tests only.
 */
export const SALES_BUCKETS = 15;

/**
 * The user's base currency, folded into the query key of every report whose figures depend on
 * it (issue #284).
 *
 * Those reports value stock from supplier prices, and a supplier price quoted in a currency
 * other than the base one is excluded rather than mis-summed — so the base currency is an
 * *input* to the numbers, not just to how they are formatted. Without it in the key, switching
 * currency in Settings would re-label a cached total that was computed under the old currency's
 * exclusions, which is exactly the kind of quietly-wrong figure this is all guarding against.
 */
function useValuationCurrency(): string {
  return usePreferencesStore((s) => s.baseCurrency);
}

export function useInventoryValue() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'inventory-value', currency],
    queryFn: () => getReportRepository().inventoryValue(),
  });
}

/**
 * Aggregate statistics for a single location's contents (issue #458) — combined value, counts and
 * a category breakdown over the stock it physically holds. `includeSubtree` widens the scope to the
 * location and all its descendants. Keyed by the base currency like every valuation read (#284), so
 * switching currency in Settings recomputes rather than re-labelling a stale figure.
 */
export function useLocationStats(locationId: string, includeSubtree: boolean) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'location-stats', locationId, includeSubtree, currency],
    queryFn: () => getReportRepository().locationStats(locationId, { includeSubtree }),
  });
}

export function useConsumptionRate(windowDays: number = REPORT_WINDOW_DAYS) {
  return useQuery({
    queryKey: [...reportKeys.all, 'consumption', windowDays],
    queryFn: () => getReportRepository().consumptionRate(windowDays),
  });
}

export function useMovement(
  windowDays: number = REPORT_WINDOW_DAYS,
  buckets: number = REPORT_MOVEMENT_BUCKETS,
) {
  return useQuery({
    queryKey: [...reportKeys.all, 'movement', windowDays, buckets],
    queryFn: () => getReportRepository().movement(windowDays, buckets),
  });
}

/**
 * Count of active items running low against the user-tuned Tier-2 thresholds (Phase 46). Pass
 * `{ enabled: false }` to keep the hook mounted without fetching — the Dashboard nav tile uses
 * this so the count query only runs when the "low-stock" metric is actually selected (A2).
 */
export function useLowStockCount(options: { enabled?: boolean } = {}) {
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  return useQuery({
    queryKey: [...reportKeys.all, 'low-stock-count', qtyThreshold, gaugePercent],
    queryFn: () => getReportRepository().lowStockCount({ qtyThreshold, gaugePercent }),
    enabled: options.enabled ?? true,
  });
}

/**
 * Count of active items **out of stock** (backlog A2) — a hard zero-on-hand floor, distinct
 * from the reorder-point threshold of {@link useLowStockCount}. Takes no thresholds, so it needs
 * no preference wiring. Pass `{ enabled: false }` to mount without fetching: the Dashboard nav
 * tile gates it so the query only runs when the "out-of-stock" metric is selected.
 */
export function useOutOfStockCount(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [...reportKeys.all, 'out-of-stock-count'],
    queryFn: () => getReportRepository().outOfStockCount(),
    enabled: options.enabled ?? true,
  });
}

/**
 * The dead-stock report (issue #92): items opted in — directly or via their location —
 * that have not moved within their effective idle threshold.
 *
 * The threshold defaults to the user-tuned Tier-2 preference so the Reports figure agrees
 * with what Settings says; individual locations may still override it further, which the
 * repository resolves per item. Pass `sinceDays` to override the global default outright.
 */
export function useDeadStock(sinceDays?: number) {
  const preferred = usePreferencesStore((s) => s.deadStockDays);
  const effective = sinceDays ?? preferred;
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'dead-stock', effective, currency],
    queryFn: () => getReportRepository().deadStock(effective),
  });
}

/**
 * The resolved dead-stock policy for one item (issue #92) — whether it is reported, the
 * idle threshold that applies, and which location decided each. The item editor uses it to
 * explain what "Inherit" actually resolves to.
 */
export function useDeadStockPolicy(itemId: string) {
  const defaultDays = usePreferencesStore((s) => s.deadStockDays);
  return useQuery({
    queryKey: [...reportKeys.all, 'dead-stock-policy', itemId, defaultDays],
    queryFn: () => getReportRepository().deadStockPolicy(itemId, defaultDays),
  });
}

export function useAbcAnalysis() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'abc', ABC_WINDOW_DAYS, currency],
    queryFn: () => getReportRepository().abcAnalysis(ABC_WINDOW_DAYS),
  });
}

export function useTurnover(windowDays: number = DEFAULT_ANALYTICS_WINDOW) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'turnover', windowDays, currency],
    queryFn: () => getReportRepository().turnover(windowDays),
    // The window toggle re-keys this query; hold the previous window's table on screen
    // while the new one loads so toggling never flashes the panel to a spinner and back.
    placeholderData: keepPreviousData,
  });
}

export function useStockAging() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'stock-aging', currency],
    queryFn: () => getReportRepository().stockAging(),
  });
}

export function useValuationTrend(windowDays: number = DEFAULT_ANALYTICS_WINDOW) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'valuation-trend', windowDays, VALUATION_TREND_POINTS, currency],
    queryFn: () => getReportRepository().valuationTrend(windowDays, VALUATION_TREND_POINTS),
    // Re-keyed by the same analytics window toggle — keep the previous sparkline visible
    // while the new window loads (flicker-free, mirrors useTurnover above).
    placeholderData: keepPreviousData,
  });
}

export function useDataHygiene(staleDays: number = DATA_HYGIENE_STALE_DAYS) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'data-hygiene', staleDays, currency],
    queryFn: () => getReportRepository().dataHygiene(staleDays),
  });
}

/**
 * Spend analytics (money out from received POs, project expenses and asset acquisitions).
 *
 * `options.enabled` lets the Reports screen skip the fetch when the Purchase-orders module is
 * off (Modular UI Phase 7) — the spend card is dropped rather than fetched-then-hidden.
 * Defaults to enabled.
 */
export function useSpendAnalytics(
  windowDays: number = DEFAULT_ANALYTICS_WINDOW,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: [...reportKeys.all, 'spend', windowDays, SPEND_BUCKETS],
    queryFn: () => getReportRepository().spendAnalytics(windowDays, SPEND_BUCKETS),
    enabled: options?.enabled ?? true,
    // The spend window toggle re-keys this query; hold the previous breakdown on screen
    // while the new window loads instead of flashing the panel to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * Sales & disposal analytics (proceeds vs a cost snapshot → margin, plus written-off value).
 *
 * `options.enabled` lets the Reports screen skip the fetch when the Sales & disposals module is
 * off — the sales card is dropped rather than fetched-then-hidden. Defaults to enabled.
 */
export function useSalesAnalytics(
  windowDays: number = DEFAULT_ANALYTICS_WINDOW,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: [...reportKeys.all, 'sales', windowDays, SALES_BUCKETS],
    queryFn: () => getReportRepository().salesAnalytics(windowDays, SALES_BUCKETS),
    enabled: options?.enabled ?? true,
    // The window toggle re-keys this query; hold the previous breakdown on screen while the new
    // window loads instead of flashing the panel to a spinner (mirrors useSpendAnalytics).
    placeholderData: keepPreviousData,
  });
}

/**
 * Insurance / estate schedule (G1) — the document's totals and room ordering, with no lines.
 *
 * Bounded by the location count rather than the asset count, so it is safe to read for any
 * inventory size (issue #163). It is also what the screen needs first: the grand total, the
 * room list and each room's asset count are what page navigation and the printed summary are
 * built from.
 */
export function useInsuranceScheduleSummary() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'insurance-schedule', 'summary', currency],
    queryFn: () => getReportRepository().insuranceScheduleSummary(),
  });
}

/**
 * One page of the insurance schedule's lines, addressed document-wide.
 *
 * `scheduleSlices` maps the requested window onto per-room reads — a page straddling a room
 * boundary becomes two — and the results are concatenated back into document order. Photos are
 * only fetched when the reader has asked for them, which is what keeps a large schedule's
 * payload to text (issue #163).
 */
export function useInsuranceSchedulePage(
  groups: readonly ScheduleGroupSummary[] | undefined,
  offset: number,
  limit: number,
  includePhotos: boolean,
) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'insurance-schedule', 'page', offset, limit, includePhotos, currency],
    queryFn: async () => {
      const repo = getReportRepository();
      const slices = scheduleSlices(groups ?? [], offset, limit);
      const pages = await Promise.all(
        slices.map((slice) =>
          repo.insuranceScheduleGroupPage(
            slice.locationId,
            { limit: slice.limit, offset: slice.offset },
            { includePhotos },
          ),
        ),
      );
      return slices.map((slice, i) => ({ locationId: slice.locationId, lines: pages[i]!.rows }));
    },
    enabled: groups !== undefined,
    // Re-keyed as the reader pages or toggles photos; hold the previous page rather than
    // flashing the document to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * Load **every** line of the insurance schedule, room by room, for printing.
 *
 * Deliberately not a cached query. A full document is the one read whose size scales with the
 * inventory, so it is materialised only when the reader explicitly asks to print, reported on
 * while it loads, abortable, and dropped as soon as the print is done — rather than sat in the
 * query cache holding megabytes of thumbnails alive (issue #163).
 *
 * Rooms are walked in the summary's order and each is paged at the repository ceiling, so no
 * single read is unbounded even though the assembled result is the whole document.
 */
export async function loadFullScheduleLines(
  groups: readonly ScheduleGroupSummary[],
  includePhotos: boolean,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Map<string | null, ScheduleLine[]>> {
  const repo = getReportRepository();
  const total = groups.reduce((sum, g) => sum + g.itemCount, 0);
  const byLocation = new Map<string | null, ScheduleLine[]>();
  let loaded = 0;

  for (const group of groups) {
    const lines: ScheduleLine[] = [];
    while (lines.length < group.itemCount) {
      if (signal?.aborted) throw new DOMException('Schedule preparation cancelled', 'AbortError');
      const page = await repo.insuranceScheduleGroupPage(
        group.locationId,
        { limit: MAX_PAGE_SIZE, offset: lines.length },
        { includePhotos },
      );
      // A room that shrank mid-read would otherwise spin forever waiting for rows that no
      // longer exist; the count came from a summary read a moment earlier, not this instant.
      if (page.rows.length === 0) break;
      lines.push(...page.rows);
      loaded += page.rows.length;
      onProgress(Math.min(loaded, total), total);
    }
    byLocation.set(group.locationId, lines);
  }
  return byLocation;
}

/**
 * Parts catalogue (issue #22): a printable list of items resolved from the chosen `scope`
 * (all / a location subtree / a project / an ad-hoc selection). Read-only aggregation over
 * `items` + `locations`, fetched through `ReportRepository`; the screen renders the returned
 * DTO, shows only the columns the reader selected and offers `window.print()`.
 *
 * `scope` is `null` while the reader has not yet chosen a location/project — the query stays
 * idle (disabled) until a concrete scope exists, so no rows are fetched for an incomplete pick.
 * `options.enabled` is the second gate: the screen counts the scope first
 * ({@link useCatalogueItemCount}) and leaves this read idle when it is too large to print at
 * all, so an unbounded document is never fetched (issue #338).
 */
export function usePartsCatalogue(
  scope: CatalogueScope | null,
  options: CataloguePartsOptions & { readonly enabled?: boolean } = {},
) {
  const { includePhotos = false, groupBy, sortBy, enabled = true } = options;
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'parts-catalogue', scope, includePhotos, groupBy, sortBy, currency],
    queryFn: () => getReportRepository().partsCatalogue(scope!, { includePhotos, groupBy, sortBy }),
    enabled: scope !== null && enabled,
    // Re-keyed as the reader changes scope/grouping/columns; keep the previous document on screen
    // while the new one loads instead of flashing to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * How many items a catalogue scope covers, without fetching any of them (issue #338).
 *
 * The catalogue screen leads with this — as the insurance schedule leads with its bounded
 * summary read — so the size of the job is known before a single row, thumbnail BLOB or QR
 * encode is paid for, and a scope too large to print never builds a document at all.
 *
 * Unlike {@link usePartsCatalogue} this is not re-keyed by the chosen columns or grouping:
 * neither changes which items are in scope, so switching a column on must not re-run the count.
 */
export function useCatalogueItemCount(scope: CatalogueScope | null) {
  return useQuery({
    queryKey: [...reportKeys.all, 'parts-catalogue-count', scope],
    queryFn: () => getReportRepository().partsCatalogueCount(scope!),
    enabled: scope !== null,
    // Deliberately **not** `keepPreviousData`, unlike every other read on this screen. This
    // count is a gate, not a display value: holding the previous scope's answer while a new
    // one loads would let a ten-item location's count wave through the read for "All items".
    // An undefined count has to mean "not known yet", so the caller can wait for it.
  });
}

/**
 * How many items are left unvalued because their preferred supplier price is quoted in a
 * currency other than the base one (issue #284). Drives the notice on the valuation card and
 * the insurance schedule, so an excluded price is visible rather than a silent gap in a total.
 */
export function useForeignCurrencyCostCount() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: [...reportKeys.all, 'foreign-currency-cost-count', currency],
    queryFn: () => getReportRepository().foreignCurrencyCostCount(),
  });
}
