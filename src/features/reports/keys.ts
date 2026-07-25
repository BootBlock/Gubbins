/**
 * Query-key SSOT for the §3 Reports screen.
 *
 * Every report query hangs off the `['reports', …]` prefix, so invalidating the prefix
 * refreshes the whole screen at once. This lives in its own dependency-free module (rather
 * than in `./queries`, which consumes the preferences store) so the write side — inventory,
 * purchasing, sales, projects — can import the prefix without pulling the read hooks in. The
 * type-only import below is erased at build time, so that stays true.
 *
 * There is a **named member per report**, not just the shared prefix: the arguments a report's
 * figures depend on — the analytics window, the tuned thresholds, the base currency (#284) —
 * are what make its key correct, and spelling them out at the `useQuery` call site is how a new
 * report quietly ships keyed on fewer of them than it reads. Adding one here forces the same
 * decision to be made in the one place it can be checked against its neighbours (issue #379).
 */
import type { CatalogueGroupBy, CatalogueScope, CatalogueSortBy } from './parts-catalogue';

export const reportKeys = {
  /** The prefix every report query is built from; invalidate this to refresh them all. */
  all: ['reports'] as const,

  inventoryValue: (currency: string) => [...reportKeys.all, 'inventory-value', currency] as const,
  locationStats: (locationId: string, includeSubtree: boolean, currency: string) =>
    [...reportKeys.all, 'location-stats', locationId, includeSubtree, currency] as const,
  consumption: (windowDays: number) => [...reportKeys.all, 'consumption', windowDays] as const,
  movement: (windowDays: number, buckets: number) =>
    [...reportKeys.all, 'movement', windowDays, buckets] as const,
  lowStockCount: (qtyThreshold: number, gaugePercent: number) =>
    [...reportKeys.all, 'low-stock-count', qtyThreshold, gaugePercent] as const,
  outOfStockCount: () => [...reportKeys.all, 'out-of-stock-count'] as const,
  deadStock: (sinceDays: number, currency: string) =>
    [...reportKeys.all, 'dead-stock', sinceDays, currency] as const,
  deadStockPolicy: (itemId: string, defaultDays: number) =>
    [...reportKeys.all, 'dead-stock-policy', itemId, defaultDays] as const,
  abc: (windowDays: number, currency: string) => [...reportKeys.all, 'abc', windowDays, currency] as const,
  turnover: (windowDays: number, currency: string) =>
    [...reportKeys.all, 'turnover', windowDays, currency] as const,
  stockAging: (currency: string) => [...reportKeys.all, 'stock-aging', currency] as const,
  valuationTrend: (windowDays: number, points: number, currency: string) =>
    [...reportKeys.all, 'valuation-trend', windowDays, points, currency] as const,
  dataHygiene: (staleDays: number, currency: string) =>
    [...reportKeys.all, 'data-hygiene', staleDays, currency] as const,
  spend: (windowDays: number, buckets: number) => [...reportKeys.all, 'spend', windowDays, buckets] as const,
  sales: (windowDays: number, buckets: number) => [...reportKeys.all, 'sales', windowDays, buckets] as const,

  /** The insurance schedule's own prefix — its summary and its pages share it (G1, issue #163). */
  insuranceSchedule: () => [...reportKeys.all, 'insurance-schedule'] as const,
  insuranceScheduleSummary: (currency: string) =>
    [...reportKeys.insuranceSchedule(), 'summary', currency] as const,
  insuranceSchedulePage: (offset: number, limit: number, includePhotos: boolean, currency: string) =>
    [...reportKeys.insuranceSchedule(), 'page', offset, limit, includePhotos, currency] as const,

  partsCatalogue: (
    scope: CatalogueScope | null,
    includePhotos: boolean,
    groupBy: CatalogueGroupBy | undefined,
    sortBy: CatalogueSortBy | undefined,
    currency: string,
  ) => [...reportKeys.all, 'parts-catalogue', scope, includePhotos, groupBy, sortBy, currency] as const,
  /**
   * Deliberately keyed on the scope alone — neither the chosen columns nor the grouping change
   * which items are in scope, so switching a column on must not re-run the count (issue #338).
   */
  partsCatalogueCount: (scope: CatalogueScope | null) =>
    [...reportKeys.all, 'parts-catalogue-count', scope] as const,

  foreignCurrencyCostCount: (currency: string) =>
    [...reportKeys.all, 'foreign-currency-cost-count', currency] as const,
} as const;
