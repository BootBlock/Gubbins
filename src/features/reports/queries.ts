/**
 * TanStack Query hooks for the §3 Reports screen (inventory-depth Phase 61). Each report
 * is a read-only aggregation over data already stored, fetched through `ReportRepository`
 * (never raw SQL in the component). The low-stock count honours the user-tuned Tier-2
 * thresholds (Phase 46), so the Reports figure agrees with the dashboard widget.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getReportRepository } from '@/db/repositories';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/** Trailing-window length (days) shared by the consumption + movement reports. */
export const REPORT_WINDOW_DAYS = 30;
/** Number of time buckets in the movement chart (≈ one bar every couple of days). */
export const REPORT_MOVEMENT_BUCKETS = 15;
/** "No movement in N days" cutoff for the dead-stock report. */
export const DEAD_STOCK_SINCE_DAYS = 90;

// Phase 74 — advanced analytics ------------------------------------------------
/** Annual window (days) for ABC analysis — the standard "annual consumption value" basis. */
export const ABC_WINDOW_DAYS = 365;
/** Selectable trailing windows (days) for the turnover + valuation-trend analytics. */
export const ANALYTICS_WINDOWS = [30, 90, 365] as const;
/** Default analytics window — a quarter reads well for both turnover and the value trend. */
export const DEFAULT_ANALYTICS_WINDOW = 90;
/** Number of reconstructed samples on the valuation-trend sparkline. */
export const VALUATION_TREND_POINTS = 12;

// Phase 77 — data-hygiene / quality report -------------------------------------
/** Records with no activity for at least this many days count as "stale" (≈ six months). */
export const DATA_HYGIENE_STALE_DAYS = 180;

// Phase 79 — procurement / spend analytics -------------------------------------
/** Number of time buckets in the spend-over-time strip (≈ one bar per couple of days at 90d). */
export const SPEND_BUCKETS = 15;

// Sales & disposals — proceeds vs cost margin ----------------------------------
/** Number of time buckets in the sales-over-time strip (mirrors the spend strip). */
export const SALES_BUCKETS = 15;

export function useInventoryValue() {
  return useQuery({
    queryKey: ['reports', 'inventory-value'],
    queryFn: () => getReportRepository().inventoryValue(),
  });
}

export function useConsumptionRate(windowDays: number = REPORT_WINDOW_DAYS) {
  return useQuery({
    queryKey: ['reports', 'consumption', windowDays],
    queryFn: () => getReportRepository().consumptionRate(windowDays),
  });
}

export function useMovement(
  windowDays: number = REPORT_WINDOW_DAYS,
  buckets: number = REPORT_MOVEMENT_BUCKETS,
) {
  return useQuery({
    queryKey: ['reports', 'movement', windowDays, buckets],
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
    queryKey: ['reports', 'low-stock-count', qtyThreshold, gaugePercent],
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
    queryKey: ['reports', 'out-of-stock-count'],
    queryFn: () => getReportRepository().outOfStockCount(),
    enabled: options.enabled ?? true,
  });
}

export function useDeadStock(sinceDays: number = DEAD_STOCK_SINCE_DAYS) {
  return useQuery({
    queryKey: ['reports', 'dead-stock', sinceDays],
    queryFn: () => getReportRepository().deadStock(sinceDays),
  });
}

export function useAbcAnalysis() {
  return useQuery({
    queryKey: ['reports', 'abc', ABC_WINDOW_DAYS],
    queryFn: () => getReportRepository().abcAnalysis(ABC_WINDOW_DAYS),
  });
}

export function useTurnover(windowDays: number = DEFAULT_ANALYTICS_WINDOW) {
  return useQuery({
    queryKey: ['reports', 'turnover', windowDays],
    queryFn: () => getReportRepository().turnover(windowDays),
    // The window toggle re-keys this query; hold the previous window's table on screen
    // while the new one loads so toggling never flashes the panel to a spinner and back.
    placeholderData: keepPreviousData,
  });
}

export function useStockAging() {
  return useQuery({
    queryKey: ['reports', 'stock-aging'],
    queryFn: () => getReportRepository().stockAging(),
  });
}

export function useValuationTrend(windowDays: number = DEFAULT_ANALYTICS_WINDOW) {
  return useQuery({
    queryKey: ['reports', 'valuation-trend', windowDays, VALUATION_TREND_POINTS],
    queryFn: () => getReportRepository().valuationTrend(windowDays, VALUATION_TREND_POINTS),
    // Re-keyed by the same analytics window toggle — keep the previous sparkline visible
    // while the new window loads (flicker-free, mirrors useTurnover above).
    placeholderData: keepPreviousData,
  });
}

export function useDataHygiene(staleDays: number = DATA_HYGIENE_STALE_DAYS) {
  return useQuery({
    queryKey: ['reports', 'data-hygiene', staleDays],
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
    queryKey: ['reports', 'spend', windowDays, SPEND_BUCKETS],
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
    queryKey: ['reports', 'sales', windowDays, SALES_BUCKETS],
    queryFn: () => getReportRepository().salesAnalytics(windowDays, SALES_BUCKETS),
    enabled: options?.enabled ?? true,
    // The window toggle re-keys this query; hold the previous breakdown on screen while the new
    // window loads instead of flashing the panel to a spinner (mirrors useSpendAnalytics).
    placeholderData: keepPreviousData,
  });
}

/**
 * Insurance / estate schedule (G1): the room-by-room document of every catalogued asset with
 * its replacement value. Read-only aggregation over `items` + `locations`, fetched through
 * `ReportRepository`; the print screen renders the returned DTO and offers `window.print()`.
 */
export function useInsuranceSchedule() {
  return useQuery({
    queryKey: ['reports', 'insurance-schedule'],
    queryFn: () => getReportRepository().insuranceSchedule(),
  });
}
