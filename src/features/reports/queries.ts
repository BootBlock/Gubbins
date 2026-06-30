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
