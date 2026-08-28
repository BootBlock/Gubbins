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
  /**
   * `omittedKinds` is part of the key because it changes the report's rows *and* its
   * "N of M need attention" headline — a device with the Cycle-counts module off reads a
   * genuinely different report from one with it on, so the two must not share a cache entry.
   * It stays a required parameter, so a caller cannot forget it, but the body tolerates a
   * missing value: `report-invalidation.test.ts` calls every member with no arguments to prove
   * it is built from the shared prefix, and a bare spread would throw there.
   */
  dataHygiene: (staleDays: number, currency: string, omittedKinds: readonly string[]) =>
    [
      ...reportKeys.all,
      'data-hygiene',
      staleDays,
      currency,
      [...(omittedKinds ?? [])].sort().join(','),
    ] as const,
  /**
   * Keyed on the base currency like every other money report (issue #572): the spend total is a
   * *function* of it — a purchase order priced in another currency is excluded from the figures
   * rather than converted — so a cached total belongs to the currency it was computed under.
   */
  spend: (windowDays: number, buckets: number, currency: string) =>
    [...reportKeys.all, 'spend', windowDays, buckets, currency] as const,
  /**
   * Keyed on the base currency for the same reason as {@link reportKeys.spend} (issue #572), by
   * way of its decimals: proceeds, cost and margin are quantised to the base currency's minor
   * unit, so figures computed at one scale must not be re-labelled at another.
   */
  sales: (windowDays: number, buckets: number, currency: string) =>
    [...reportKeys.all, 'sales', windowDays, buckets, currency] as const,

  /** The insurance schedule's own prefix — its summary and its pages share it (G1, issue #163). */
  insuranceSchedule: () => [...reportKeys.all, 'insurance-schedule'] as const,
  insuranceScheduleSummary: (currency: string) =>
    [...reportKeys.insuranceSchedule(), 'summary', currency] as const,
  insuranceSchedulePage: (offset: number, limit: number, includePhotos: boolean, currency: string) =>
    [...reportKeys.insuranceSchedule(), 'page', offset, limit, includePhotos, currency] as const,

  /** The parts catalogue's own prefix — its summary and its pages share it (issue #410). */
  partsCatalogue: () => [...reportKeys.all, 'parts-catalogue'] as const,
  /**
   * Keyed on the scope and the grouping — and deliberately not on the chosen columns or the sort,
   * neither of which changes a section's heading, its item count or its subtotal.
   */
  partsCatalogueSummary: (
    scope: CatalogueScope | null,
    groupBy: CatalogueGroupBy | undefined,
    currency: string,
  ) => [...reportKeys.partsCatalogue(), 'summary', scope, groupBy, currency] as const,
  /**
   * A page is addressed *through* the summary's section order, so the grouping is part of its
   * key as well as the window itself: the same offset over a differently-grouped document is a
   * different set of lines.
   */
  partsCataloguePage: (
    scope: CatalogueScope | null,
    groupBy: CatalogueGroupBy | undefined,
    sortBy: CatalogueSortBy | undefined,
    offset: number,
    limit: number,
    includePhotos: boolean,
    currency: string,
  ) =>
    [
      ...reportKeys.partsCatalogue(),
      'page',
      scope,
      groupBy,
      sortBy,
      offset,
      limit,
      includePhotos,
      currency,
    ] as const,

  foreignCurrencyCostCount: (currency: string) =>
    [...reportKeys.all, 'foreign-currency-cost-count', currency] as const,

  /**
   * Keyed on the currency like its foreign-currency sibling, so a base-currency change
   * re-reads it alongside the totals it qualifies (issue #683).
   */
  unpricedGaugeCount: (currency: string) => [...reportKeys.all, 'unpriced-gauge-count', currency] as const,
} as const;
