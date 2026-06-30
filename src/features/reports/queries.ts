/**
 * TanStack Query hooks for the §3 Reports screen (inventory-depth Phase 61). Each report
 * is a read-only aggregation over data already stored, fetched through `ReportRepository`
 * (never raw SQL in the component). The low-stock count honours the user-tuned Tier-2
 * thresholds (Phase 46), so the Reports figure agrees with the dashboard widget.
 */
import { useQuery } from '@tanstack/react-query';
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

export function useMovement(windowDays: number = REPORT_WINDOW_DAYS, buckets: number = REPORT_MOVEMENT_BUCKETS) {
  return useQuery({
    queryKey: ['reports', 'movement', windowDays, buckets],
    queryFn: () => getReportRepository().movement(windowDays, buckets),
  });
}

export function useLowStockCount() {
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  return useQuery({
    queryKey: ['reports', 'low-stock-count', qtyThreshold, gaugePercent],
    queryFn: () => getReportRepository().lowStockCount({ qtyThreshold, gaugePercent }),
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
  });
}

export function useDataHygiene(staleDays: number = DATA_HYGIENE_STALE_DAYS) {
  return useQuery({
    queryKey: ['reports', 'data-hygiene', staleDays],
    queryFn: () => getReportRepository().dataHygiene(staleDays),
  });
}
