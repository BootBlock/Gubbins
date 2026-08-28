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
import type {
  CatalogueGroupBy,
  CatalogueGroupSummary,
  CatalogueLine,
  CatalogueScope,
  CatalogueSortBy,
} from './parts-catalogue';
import { sliceGroupsForPage } from './group-slices';
import type { HygieneIssueKind } from './data-hygiene';
import { scheduleSlices, type ScheduleGroupSummary, type ScheduleLine } from './insurance-schedule';
import { MAX_PAGE_SIZE } from '@/db/repositories/constants';

// The `['reports', …]` prefix and a named key per report are the SSOT in ./keys — every hook
// below reads its key from there, so invalidating the prefix (see `invalidateItems`) provably
// refreshes all of them, and the inputs a report is keyed on are visible side by side.
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
/** Shared empty omission list, so the common "run every check" call keys stably. */
const NO_OMITTED_HYGIENE_KINDS: readonly HygieneIssueKind[] = [];

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
 * How long a slow-moving report stays fresh before a remount will refetch it (issue #528).
 *
 * The §3 analytics — ABC over a year of consumption, turnover, stock aging, the valuation
 * trend, the hygiene checklist, dead stock, spend and sales — are each a whole-catalogue pass,
 * and each answers a question whose shape does not move from minute to minute: a Pareto
 * classification or a six-month tidy-up list is not a live figure. The app-wide 30-second default therefore
 * bought nothing and cost a full recompute every time the reader scrolled a panel out of view
 * and back, or navigated away and returned.
 *
 * This is **not** a correctness lever. `invalidateQueries` marks a query stale whatever its
 * `staleTime`, so every write still refreshes what is on screen exactly as before (issue #375);
 * all this changes is the *unprompted* refetch when nothing has written.
 */
export const ANALYTICS_STALE_TIME_MS = 5 * 60_000;

/**
 * The gate a report hook accepts so its caller can leave the query idle.
 *
 * The Reports screen is long and mostly below the fold, so it passes each panel's on-screen
 * state here (see `useInViewport`): a report nobody is looking at neither runs on mount nor
 * refetches when a write invalidates it, and picks the new figures up when the panel is next
 * scrolled to. Defaults to enabled, so a caller that wants the report unconditionally — the
 * CSV export, a test — says nothing.
 */
export interface ReportQueryOptions {
  readonly enabled?: boolean;
}

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
    queryKey: reportKeys.inventoryValue(currency),
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
    queryKey: reportKeys.locationStats(locationId, includeSubtree, currency),
    queryFn: () => getReportRepository().locationStats(locationId, { includeSubtree }),
  });
}

export function useConsumptionRate(windowDays: number = REPORT_WINDOW_DAYS) {
  return useQuery({
    queryKey: reportKeys.consumption(windowDays),
    queryFn: () => getReportRepository().consumptionRate(windowDays),
  });
}

export function useMovement(
  windowDays: number = REPORT_WINDOW_DAYS,
  buckets: number = REPORT_MOVEMENT_BUCKETS,
  options?: ReportQueryOptions,
) {
  return useQuery({
    queryKey: reportKeys.movement(windowDays, buckets),
    queryFn: () => getReportRepository().movement(windowDays, buckets),
    enabled: options?.enabled ?? true,
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
    queryKey: reportKeys.lowStockCount(qtyThreshold, gaugePercent),
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
    queryKey: reportKeys.outOfStockCount(),
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
    queryKey: reportKeys.deadStock(effective, currency),
    queryFn: () => getReportRepository().deadStock(effective),
    // Eager (a headline card reads it) but slow-moving: an item crosses its idle threshold on
    // a timescale of months, and any write that moves the figure invalidates the key anyway.
    staleTime: ANALYTICS_STALE_TIME_MS,
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
    queryKey: reportKeys.deadStockPolicy(itemId, defaultDays),
    queryFn: () => getReportRepository().deadStockPolicy(itemId, defaultDays),
  });
}

export function useAbcAnalysis(options?: ReportQueryOptions) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.abc(ABC_WINDOW_DAYS, currency),
    queryFn: () => getReportRepository().abcAnalysis(ABC_WINDOW_DAYS),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
  });
}

export function useTurnover(windowDays: number = DEFAULT_ANALYTICS_WINDOW, options?: ReportQueryOptions) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.turnover(windowDays, currency),
    queryFn: () => getReportRepository().turnover(windowDays),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
    // The window toggle re-keys this query; hold the previous window's table on screen
    // while the new one loads so toggling never flashes the panel to a spinner and back.
    placeholderData: keepPreviousData,
  });
}

export function useStockAging(options?: ReportQueryOptions) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.stockAging(currency),
    queryFn: () => getReportRepository().stockAging(),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
  });
}

export function useValuationTrend(
  windowDays: number = DEFAULT_ANALYTICS_WINDOW,
  options?: ReportQueryOptions,
) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.valuationTrend(windowDays, VALUATION_TREND_POINTS, currency),
    queryFn: () => getReportRepository().valuationTrend(windowDays, VALUATION_TREND_POINTS),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
    // Re-keyed by the same analytics window toggle — keep the previous sparkline visible
    // while the new window loads (flicker-free, mirrors useTurnover above).
    placeholderData: keepPreviousData,
  });
}

/**
 * The data-hygiene / quality checklist.
 *
 * `options.omitKinds` drops whole checks the device has no use for — the Reports screen leaves
 * out "Never counted" when the Cycle-counts module is off, since nothing on that device can
 * clear the flag. Pass a module-level constant (or a memoised array): the value is part of the
 * query key.
 */
export function useDataHygiene(
  staleDays: number = DATA_HYGIENE_STALE_DAYS,
  options?: ReportQueryOptions & { omitKinds?: readonly HygieneIssueKind[] },
) {
  const currency = useValuationCurrency();
  const omitKinds = options?.omitKinds ?? NO_OMITTED_HYGIENE_KINDS;
  return useQuery({
    queryKey: reportKeys.dataHygiene(staleDays, currency, omitKinds),
    queryFn: () => getReportRepository().dataHygiene(staleDays, undefined, omitKinds),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
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
  options?: ReportQueryOptions,
) {
  return useQuery({
    queryKey: reportKeys.spend(windowDays, SPEND_BUCKETS),
    queryFn: () => getReportRepository().spendAnalytics(windowDays, SPEND_BUCKETS),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
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
  options?: ReportQueryOptions,
) {
  return useQuery({
    queryKey: reportKeys.sales(windowDays, SALES_BUCKETS),
    queryFn: () => getReportRepository().salesAnalytics(windowDays, SALES_BUCKETS),
    enabled: options?.enabled ?? true,
    staleTime: ANALYTICS_STALE_TIME_MS,
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
    queryKey: reportKeys.insuranceScheduleSummary(currency),
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
    queryKey: reportKeys.insuranceSchedulePage(offset, limit, includePhotos, currency),
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
 * Parts catalogue (issue #22) — the document's totals and section ordering, with no lines.
 *
 * Bounded by the section count rather than the item count (issue #410), so it is safe to read for
 * any scope. It is also what the screen needs first: the grand total, the section list and each
 * section's item count are what page navigation, the print-size readout and the printed summary
 * are all built from.
 *
 * `scope` is `null` while the reader has not yet chosen a location/project — the query stays idle
 * until a concrete scope exists, so nothing is read for an incomplete pick.
 */
export function usePartsCatalogueSummary(scope: CatalogueScope | null, groupBy?: CatalogueGroupBy) {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.partsCatalogueSummary(scope, groupBy, currency),
    queryFn: () => getReportRepository().partsCatalogueSummary(scope!, { groupBy }),
    enabled: scope !== null,
    // Re-keyed as the reader changes scope or grouping; keep the previous document's shape on
    // screen while the new one loads instead of flashing to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * One page of the catalogue's lines, addressed document-wide.
 *
 * `sliceGroupsForPage` maps the requested window onto per-section reads — a page straddling a
 * section boundary becomes two — and the results are returned in document order. Thumbnails are
 * only fetched when the Photo column is on, which is what keeps a page's payload to text.
 */
export function usePartsCataloguePage(
  scope: CatalogueScope | null,
  groups: readonly CatalogueGroupSummary[] | undefined,
  offset: number,
  limit: number,
  options: {
    readonly includePhotos?: boolean;
    readonly groupBy?: CatalogueGroupBy;
    readonly sortBy?: CatalogueSortBy;
  } = {},
) {
  const { includePhotos = false, groupBy, sortBy } = options;
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.partsCataloguePage(scope, groupBy, sortBy, offset, limit, includePhotos, currency),
    queryFn: async () => {
      const repo = getReportRepository();
      const slices = sliceGroupsForPage(groups ?? [], offset, limit);
      const pages = await Promise.all(
        slices.map((slice) =>
          repo.partsCatalogueGroupPage(
            scope!,
            slice.group.ref,
            { limit: slice.limit, offset: slice.offset },
            { includePhotos, sortBy },
          ),
        ),
      );
      return slices.map((slice, i) => ({ groupId: slice.group.groupId, lines: pages[i]!.rows }));
    },
    enabled: scope !== null && groups !== undefined,
    // Re-keyed as the reader pages, re-sorts or toggles a media column; hold the previous page
    // rather than flashing the document to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * Load **every** line of the catalogue, section by section, for printing.
 *
 * Deliberately not a cached query. A full document is the one read whose size scales with the
 * scope, so it is materialised only when the reader explicitly asks to print, reported on while
 * it loads, abortable, and dropped once the print is over — rather than sat in the query cache
 * holding a whole inventory (and, with the Photo column on, its thumbnails) alive.
 *
 * Sections are walked in the summary's order and each is paged at the repository ceiling, so no
 * single read is unbounded even though the assembled result is the whole document.
 */
export async function loadFullCatalogueLines(
  scope: CatalogueScope,
  groups: readonly CatalogueGroupSummary[],
  options: { readonly includePhotos?: boolean; readonly sortBy?: CatalogueSortBy },
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Map<string | null, CatalogueLine[]>> {
  const repo = getReportRepository();
  const total = groups.reduce((sum, g) => sum + g.itemCount, 0);
  const byGroup = new Map<string | null, CatalogueLine[]>();
  let loaded = 0;

  for (const group of groups) {
    const lines: CatalogueLine[] = [];
    while (lines.length < group.itemCount) {
      if (signal?.aborted) throw new DOMException('Catalogue preparation cancelled', 'AbortError');
      const page = await repo.partsCatalogueGroupPage(
        scope,
        group.ref,
        { limit: MAX_PAGE_SIZE, offset: lines.length },
        options,
      );
      // A section that shrank mid-read would otherwise spin forever waiting for rows that no
      // longer exist; the count came from a summary read a moment earlier, not this instant.
      if (page.rows.length === 0) break;
      lines.push(...page.rows);
      loaded += page.rows.length;
      onProgress(Math.min(loaded, total), total);
    }
    byGroup.set(group.groupId, lines);
  }
  return byGroup;
}

/**
 * How many items are left unvalued because their preferred supplier price is quoted in a
 * currency other than the base one (issue #284). Drives the notice on the valuation card and
 * the insurance schedule, so an excluded price is visible rather than a silent gap in a total.
 */
export function useForeignCurrencyCostCount() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.foreignCurrencyCostCount(currency),
    queryFn: () => getReportRepository().foreignCurrencyCostCount(),
  });
}

/**
 * How many gauges hold material that nothing prices (issue #683) — they have no cost per unit
 * of measure, and a gauge is never valued from a per-unit price. Drives the notice on the
 * valuation card and the insurance schedule, so contents left out of a total are visible
 * rather than reported as a confident zero.
 */
export function useUnpricedGaugeCount() {
  const currency = useValuationCurrency();
  return useQuery({
    queryKey: reportKeys.unpricedGaugeCount(currency),
    queryFn: () => getReportRepository().unpricedGaugeCount(),
  });
}
