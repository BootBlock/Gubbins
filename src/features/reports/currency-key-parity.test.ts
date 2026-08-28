/**
 * Every report whose figures depend on the base currency is keyed on it (issues #284, #572).
 *
 * The base currency is an *input* to these numbers, not a label on them: a supplier price or a
 * purchase order quoted in another currency is excluded rather than converted, and every money
 * figure is quantised to the base currency's minor unit. Nothing invalidates the report cache
 * when the preference changes — `setBaseCurrency` does no invalidation, so the query key *is*
 * the mechanism. A read that leaves the currency out therefore keeps a total computed under the
 * old currency's rules and simply re-renders it under the new symbol.
 *
 * That is how `spend` and `sales` came to be the last two unkeyed reads (issue #572): the rule
 * lived in prose and in the neighbours, so a report shipped without it looked exactly like one
 * that did not need it. This guard replaces that prose. It reads the repository's own source to
 * find which reads resolve `this.baseCurrency()` / `this.moneyDecimals()`, then drives each hook
 * under two different base currencies and asserts the currency-dependent ones produce different
 * keys — so the next omission fails the build rather than review.
 *
 * The implication runs one way only. Keying a currency-*independent* read on the currency costs
 * one needless refetch and is never wrong, so `unpricedGaugeCount` (keyed alongside the totals it
 * qualifies, issue #683) is left alone rather than asserted unkeyed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoPath } from '@/test/repo-path';

// Capture the options each hook hands to useQuery. No React, worker or repository is involved:
// the hooks are called directly, and the stubs below make that inert.
const useQuerySpy = vi.fn(() => ({ data: undefined, isLoading: false }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: (options: unknown) => useQuerySpy(options) };
});

// The base currency the hooks read, swapped between the two passes below.
let mockBaseCurrency = 'GBP';

vi.mock('@/state/stores/usePreferencesStore', () => ({
  usePreferencesStore: (selector: (s: unknown) => unknown) =>
    selector({
      baseCurrency: mockBaseCurrency,
      deadStockDays: 180,
      lowStockQtyThreshold: 1,
      lowStockGaugePercent: 10,
    }),
}));

// The queryFn is never invoked (useQuery is stubbed), so an empty repository is enough.
vi.mock('@/db/repositories', () => ({
  getReportRepository: () => ({}),
}));

import * as queries from './queries';

/**
 * How each report hook is driven, and which repository read it fetches.
 *
 * Every exported hook is listed — a new one fails the coverage test below until it is — with
 * arguments that are representative rather than realistic: only the query key is read, and a
 * paged hook builds the same key whether or not its groups have loaded.
 */
interface ReportRead {
  /** The exported hook, as named in `queries.ts`. */
  readonly hook: string;
  /** The `ReportRepository` method its queryFn reads. */
  readonly method: string;
  /** Calls the hook. */
  readonly call: () => void;
}

const REPORT_READS: readonly ReportRead[] = [
  { hook: 'useInventoryValue', method: 'inventoryValue', call: () => queries.useInventoryValue() },
  {
    hook: 'useLocationStats',
    method: 'locationStats',
    call: () => queries.useLocationStats('loc-1', true),
  },
  { hook: 'useConsumptionRate', method: 'consumptionRate', call: () => queries.useConsumptionRate() },
  { hook: 'useMovement', method: 'movement', call: () => queries.useMovement() },
  { hook: 'useLowStockCount', method: 'lowStockCount', call: () => queries.useLowStockCount() },
  { hook: 'useOutOfStockCount', method: 'outOfStockCount', call: () => queries.useOutOfStockCount() },
  { hook: 'useDeadStock', method: 'deadStock', call: () => queries.useDeadStock() },
  {
    hook: 'useDeadStockPolicy',
    method: 'deadStockPolicy',
    call: () => queries.useDeadStockPolicy('item-1'),
  },
  { hook: 'useAbcAnalysis', method: 'abcAnalysis', call: () => queries.useAbcAnalysis() },
  { hook: 'useTurnover', method: 'turnover', call: () => queries.useTurnover() },
  { hook: 'useStockAging', method: 'stockAging', call: () => queries.useStockAging() },
  { hook: 'useValuationTrend', method: 'valuationTrend', call: () => queries.useValuationTrend() },
  { hook: 'useDataHygiene', method: 'dataHygiene', call: () => queries.useDataHygiene() },
  { hook: 'useSpendAnalytics', method: 'spendAnalytics', call: () => queries.useSpendAnalytics() },
  { hook: 'useSalesAnalytics', method: 'salesAnalytics', call: () => queries.useSalesAnalytics() },
  {
    hook: 'useInsuranceScheduleSummary',
    method: 'insuranceScheduleSummary',
    call: () => queries.useInsuranceScheduleSummary(),
  },
  {
    hook: 'useInsuranceSchedulePage',
    method: 'insuranceScheduleGroupPage',
    call: () => queries.useInsuranceSchedulePage(undefined, 0, 50, false),
  },
  {
    hook: 'usePartsCatalogueSummary',
    method: 'partsCatalogueSummary',
    call: () => queries.usePartsCatalogueSummary(null),
  },
  {
    hook: 'usePartsCataloguePage',
    method: 'partsCatalogueGroupPage',
    call: () => queries.usePartsCataloguePage(null, undefined, 0, 50),
  },
  {
    hook: 'useForeignCurrencyCostCount',
    method: 'foreignCurrencyCostCount',
    call: () => queries.useForeignCurrencyCostCount(),
  },
  {
    hook: 'useUnpricedGaugeCount',
    method: 'unpricedGaugeCount',
    call: () => queries.useUnpricedGaugeCount(),
  },
];

/**
 * Currency-dependent repository reads that are deliberately **not** fetched through a cached
 * query, so no key could carry the currency for them.
 *
 * Empty today: every currency-dependent read reaches the screen through a hook above, and the
 * two uncached printable documents (`loadFullScheduleLines`, `loadFullCatalogueLines`) page the
 * same group reads the page hooks do. A read only belongs here if it genuinely bypasses the
 * query cache — anything a hook fetches goes in {@link REPORT_READS} instead.
 */
const UNCACHED_CURRENCY_READS: readonly string[] = [];

/** The repository source, read from the checkout this test file lives in. */
const REPOSITORY_SOURCE = readFileSync(
  join(repoPath(import.meta.dirname, 'src'), 'db', 'repositories', 'ReportRepository.ts'),
  'utf8',
);

/**
 * The methods declared in `ReportRepository.ts` whose bodies resolve the base currency — either
 * directly, or as the money decimals derived from it.
 *
 * Split on the class's own indentation: a method runs from its signature to the next one.
 */
function currencyDependentMethods(source: string): ReadonlySet<string> {
  const signature = /^ {2}(?:private |protected |public )?(?:async )?([A-Za-z_]\w*)\(/gm;
  const starts: { name: string; at: number }[] = [];
  for (const match of source.matchAll(signature)) {
    starts.push({ name: match[1]!, at: match.index });
  }
  const dependent = new Set<string>();
  starts.forEach((start, i) => {
    const body = source.slice(start.at, starts[i + 1]?.at ?? source.length);
    if (/this\.(?:baseCurrency|moneyDecimals)\(\)/.test(body)) dependent.add(start.name);
  });
  return dependent;
}

const CURRENCY_DEPENDENT = currencyDependentMethods(REPOSITORY_SOURCE);

/** The queryKey from the most recent useQuery call. */
function lastQueryKey(): readonly unknown[] {
  const call = useQuerySpy.mock.calls.at(-1);
  return (call?.[0] as { queryKey: readonly unknown[] }).queryKey;
}

/** The queryFn from the most recent useQuery call. */
function lastQueryFn(): () => unknown {
  const call = useQuerySpy.mock.calls.at(-1);
  return (call?.[0] as { queryFn: () => unknown }).queryFn;
}

/** Drives `read` with `currency` as the base currency and returns the key it built. */
function keyUnder(read: ReportRead, currency: string): readonly unknown[] {
  mockBaseCurrency = currency;
  read.call();
  return lastQueryKey();
}

beforeEach(() => {
  useQuerySpy.mockClear();
  mockBaseCurrency = 'GBP';
});

describe('the currency-dependence scan', () => {
  // The scan is what decides which reports the guard below actually checks, so a regex that
  // silently matched nothing would leave every assertion vacuous and green.
  it('classifies a known dependent read and a known independent one', () => {
    expect(CURRENCY_DEPENDENT.has('inventoryValue')).toBe(true);
    expect(CURRENCY_DEPENDENT.has('salesAnalytics')).toBe(true);
    expect(CURRENCY_DEPENDENT.has('outOfStockCount')).toBe(false);
    expect(CURRENCY_DEPENDENT.has('consumptionRate')).toBe(false);
  });
});

describe('report reads are classified', () => {
  it('lists every exported report hook', () => {
    const exported = Object.keys(queries)
      .filter((name) => /^use[A-Z]/.test(name))
      .sort();
    expect(REPORT_READS.map((r) => r.hook).sort()).toEqual(exported);
  });

  it('accounts for every currency-dependent repository read', () => {
    const accounted = new Set([...REPORT_READS.map((r) => r.method), ...UNCACHED_CURRENCY_READS]);
    const unaccounted = [...CURRENCY_DEPENDENT].filter((method) => !accounted.has(method));
    expect(unaccounted).toEqual([]);
  });

  it.each(REPORT_READS)('$hook fetches $method', (read) => {
    read.call();
    // The declared method is what decides whether this read is checked for the currency, so a
    // hook re-pointed at a different repository read must not keep the old classification.
    expect(String(lastQueryFn())).toContain(`.${read.method}(`);
  });
});

describe('a currency-dependent report is keyed on the base currency', () => {
  const dependent = REPORT_READS.filter((read) => CURRENCY_DEPENDENT.has(read.method));

  it('has reads to check', () => {
    expect(dependent.length).toBeGreaterThan(0);
  });

  it.each(dependent)('$hook re-keys when the base currency changes', (read) => {
    const pounds = keyUnder(read, 'GBP');
    const yen = keyUnder(read, 'JPY');

    expect(pounds).toContain('GBP');
    expect(yen).toContain('JPY');
    expect(yen).not.toEqual(pounds);
  });
});
