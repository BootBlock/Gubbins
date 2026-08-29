/**
 * Component tests for the ReportsScreen aria-live aggregate-completion announcement
 * (Phase 63 — broader aria-live status-message coverage / WCAG 4.1.3).
 *
 * Strategy: mock the five query hooks (./queries) at the module boundary so the
 * component under test never touches TanStack Query, the SQLite worker, or any
 * repository. Also mock leaf dependencies that pull in the router or chart canvas
 * so the test stays in happy-dom with no extra providers.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';

// --------------------------------------------------------------------------
// Dependency stubs (hoisted so vi.mock factory runs before imports)
// --------------------------------------------------------------------------

// Stub @tanstack/react-router's Link as a plain <a> so the screen renders
// without a RouterProvider in the test.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// The global nav menu has its own suite; stub it so this screen test needs no
// router/alerts context for the header.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

// Stub the Foundry BrandMark and icon-heavy sub-components so happy-dom
// doesn't need real SVG / canvas support.
vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  // Replace every icon with a lightweight span so we don't need SVG/canvas in jsdom.
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

// Stub the breakdown / chart / export sub-components (not under test here).
vi.mock('./components/ValueBreakdown', () => ({
  ValueBreakdown: () => <div data-testid="value-breakdown" />,
}));
vi.mock('./components/MovementChart', () => ({
  MovementChart: () => <div data-testid="movement-chart" />,
}));
vi.mock('./components/AbcBreakdown', () => ({
  AbcBreakdown: () => <div data-testid="abc-breakdown" />,
}));
vi.mock('./components/TurnoverTable', () => ({
  TurnoverTable: () => <div data-testid="turnover-table" />,
}));
vi.mock('./components/StockAgingChart', () => ({
  StockAgingChart: () => <div data-testid="stock-aging-chart" />,
}));
vi.mock('./components/ValuationSparkline', () => ({
  ValuationSparkline: () => <div data-testid="valuation-sparkline" />,
}));
vi.mock('./components/HygieneChecklist', () => ({
  HygieneChecklist: () => <div data-testid="hygiene-checklist" />,
}));
vi.mock('./components/SpendBreakdown', () => ({
  SpendBreakdown: () => <div data-testid="spend-breakdown" />,
}));
vi.mock('@/features/export/ExportWizard', () => ({
  ExportWizard: () => null,
}));

// Stub useFormatters so the announcement text is deterministic.
vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    currency: (v: number) => `£${v.toFixed(2)}`,
    // Mirrors `currency` split into Intl-style parts so the <Money> control renders.
    currencyParts: (v: number) => [
      { type: 'currency', value: '£' },
      { type: 'literal', value: v.toFixed(2) },
    ],
    quantity: (v: number) => String(v),
    percent: () => '0%',
    bytes: () => '0B',
    measure: (v: number, u: string) => `${v}${u}`,
    date: () => '01 Jan 2026',
    dateTime: () => '01 Jan 2026, 00:00',
  }),
}));

// --------------------------------------------------------------------------
// Controlled query hook stubs — overridden per-test via a shared config object.
// --------------------------------------------------------------------------

type FakeQueryState = {
  isLoading: boolean;
  isError: boolean;
  data?: unknown;
};

// Mutable state shared between the factory closures and each test.
const queryState: Record<
  | 'value'
  | 'consumption'
  | 'movement'
  | 'lowStock'
  | 'deadStock'
  | 'abc'
  | 'turnover'
  | 'aging'
  | 'trend'
  | 'hygiene'
  | 'spend'
  | 'foreignCurrency',
  FakeQueryState
> = {
  value: { isLoading: true, isError: false },
  consumption: { isLoading: true, isError: false },
  movement: { isLoading: true, isError: false },
  lowStock: { isLoading: true, isError: false },
  deadStock: { isLoading: true, isError: false },
  abc: { isLoading: true, isError: false },
  turnover: { isLoading: true, isError: false },
  aging: { isLoading: true, isError: false },
  trend: { isLoading: true, isError: false },
  hygiene: { isLoading: true, isError: false },
  spend: { isLoading: true, isError: false },
  sales: { isLoading: true, isError: false },
  // Nothing excluded by default, so the currency notice stays out of every existing test.
  foreignCurrency: { isLoading: false, isError: false, data: 0 },
  // Likewise no unpriced gauge contents by default, so that notice stays out too (#683).
  unpricedGauges: { isLoading: false, isError: false, data: 0 },
};

function makeAllLoaded() {
  queryState.value = {
    isLoading: false,
    isError: false,
    data: { totalValue: 99.5, totalQuantity: 10, byCategory: [], byLocation: [] },
  };
  queryState.consumption = {
    isLoading: false,
    isError: false,
    data: {
      windowDays: 30,
      lines: [
        { unit: 'g', totalConsumed: 30, perDay: 1 },
        { unit: null, totalConsumed: 5, perDay: 0.2 },
      ],
    },
  };
  queryState.movement = {
    isLoading: false,
    isError: false,
    data: { buckets: [], totalIn: 0, totalOut: 0, windowDays: 30 },
  };
  queryState.lowStock = { isLoading: false, isError: false, data: 0 };
  queryState.deadStock = { isLoading: false, isError: false, data: { lines: [], totalValue: 0 } };
  queryState.abc = { isLoading: false, isError: false, data: { lines: [], tiers: {}, totalValue: 0 } };
  queryState.turnover = {
    isLoading: false,
    isError: false,
    data: { lines: [], turnover: null, daysOnHand: null },
  };
  queryState.aging = {
    isLoading: false,
    isError: false,
    data: { buckets: [], totalQuantity: 0, totalValue: 0 },
  };
  queryState.trend = {
    isLoading: false,
    isError: false,
    data: { points: [], startValue: 0, endValue: 0, changeValue: 0 },
  };
  queryState.hygiene = {
    isLoading: false,
    isError: false,
    data: { sections: [], totalItems: 0, flaggedItems: 0 },
  };
  queryState.spend = {
    isLoading: false,
    isError: false,
    data: {
      total: 0,
      eventCount: 0,
      buckets: [],
      bySource: [],
      bySupplier: [],
      byCategory: [],
      windowStart: 0,
      windowEnd: 0,
    },
  };
}

function makeAllErrored() {
  queryState.value = { isLoading: false, isError: true };
  queryState.consumption = { isLoading: false, isError: true };
  queryState.movement = { isLoading: false, isError: true };
  queryState.lowStock = { isLoading: false, isError: true };
  queryState.deadStock = { isLoading: false, isError: true };
  queryState.abc = { isLoading: false, isError: true };
  queryState.turnover = { isLoading: false, isError: true };
  queryState.aging = { isLoading: false, isError: true };
  queryState.trend = { isLoading: false, isError: true };
  queryState.hygiene = { isLoading: false, isError: true };
  queryState.spend = { isLoading: false, isError: true };
}

function makeAllLoading() {
  queryState.value = { isLoading: true, isError: false };
  queryState.consumption = { isLoading: true, isError: false };
  queryState.movement = { isLoading: true, isError: false };
  queryState.lowStock = { isLoading: true, isError: false };
  queryState.deadStock = { isLoading: true, isError: false };
  queryState.abc = { isLoading: true, isError: false };
  queryState.turnover = { isLoading: true, isError: false };
  queryState.aging = { isLoading: true, isError: false };
  queryState.trend = { isLoading: true, isError: false };
  queryState.hygiene = { isLoading: true, isError: false };
  queryState.spend = { isLoading: true, isError: false };
}

// Captures the `enabled` option the spend query hook was last called with, so the gating test
// can assert the query is disabled (not merely filtered out of the DOM) when the module is off.
let spendEnabled: boolean | undefined;

// The same, for the reports gated on their panel being on screen (issue #528). Each records
// whether the screen actually left the query idle, which is the saving — a panel merely
// rendered empty would still have fetched.
let movementEnabled: boolean | undefined;
let abcEnabled: boolean | undefined;
let turnoverEnabled: boolean | undefined;
let agingEnabled: boolean | undefined;
let trendEnabled: boolean | undefined;
let hygieneEnabled: boolean | undefined;
let salesEnabled: boolean | undefined;

// Captures the window (days) the movement query hook was last called with, so the issue #86
// tests can assert the selected period actually reaches the query rather than only retitling
// the panel.
let movementWindowArg: number | undefined;

// The selectable windows are re-exported by `./queries` from the dependency-free
// `./analytics-windows` module, so the mock takes them from the real module rather than
// restating the list, which would drift the moment a window is added or the normaliser
// changes.
vi.mock('./queries', async () => ({
  REPORT_WINDOW_DAYS: 30,
  DEAD_STOCK_SINCE_DAYS: 90,
  REPORT_MOVEMENT_BUCKETS: 15,
  ABC_WINDOW_DAYS: 365,
  ...(await import('./analytics-windows')),
  VALUATION_TREND_POINTS: 12,
  DATA_HYGIENE_STALE_DAYS: 180,
  SPEND_BUCKETS: 15,
  SALES_BUCKETS: 15,
  useInventoryValue: () => ({ ...queryState.value }),
  useConsumptionRate: () => ({ ...queryState.consumption }),
  useMovement: (windowDays?: number, _buckets?: number, options?: { enabled?: boolean }) => {
    movementWindowArg = windowDays;
    movementEnabled = options?.enabled;
    return { ...queryState.movement };
  },
  useLowStockCount: () => ({ ...queryState.lowStock }),
  useDeadStock: () => ({ ...queryState.deadStock }),
  useAbcAnalysis: (options?: { enabled?: boolean }) => {
    abcEnabled = options?.enabled;
    return { ...queryState.abc };
  },
  useTurnover: (_windowDays?: number, options?: { enabled?: boolean }) => {
    turnoverEnabled = options?.enabled;
    return { ...queryState.turnover };
  },
  useStockAging: (options?: { enabled?: boolean }) => {
    agingEnabled = options?.enabled;
    return { ...queryState.aging };
  },
  useValuationTrend: (_windowDays?: number, options?: { enabled?: boolean }) => {
    trendEnabled = options?.enabled;
    return { ...queryState.trend };
  },
  useDataHygiene: (_staleDays?: number, options?: { enabled?: boolean }) => {
    hygieneEnabled = options?.enabled;
    return { ...queryState.hygiene };
  },
  useSpendAnalytics: (_windowDays?: number, options?: { enabled?: boolean }) => {
    spendEnabled = options?.enabled;
    return { ...queryState.spend };
  },
  useSalesAnalytics: (_windowDays?: number, options?: { enabled?: boolean }) => {
    salesEnabled = options?.enabled;
    return { ...queryState.sales };
  },
  useForeignCurrencyCostCount: () => ({ ...queryState.foreignCurrency }),
  useUnpricedGaugeCount: () => ({ ...queryState.unpricedGauges }),
}));

// --------------------------------------------------------------------------
// The component under test (imported AFTER all mocks are declared).
// --------------------------------------------------------------------------
import { ReportsScreen } from './ReportsScreen';
import { useModulesStore } from '@/state/stores/useModulesStore';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { DEFAULT_ANALYTICS_WINDOW } from './analytics-windows';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

/**
 * The screen leaves its below-the-fold reports idle until their panel is on screen (issue
 * #528), which it decides with an IntersectionObserver. happy-dom supplies a constructor that
 * never delivers an entry, so every gated panel would sit idle here and these tests would
 * assert against a screen that had fetched nothing. Stand in an observer that reports the
 * element as visible — the state every test below is written against.
 */
class AlwaysVisibleObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly thresholds: readonly number[] = [];
  constructor(private readonly cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', AlwaysVisibleObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  makeAllLoading();
  useModulesStore.setState({ intent: {} });
  // The movement window is a persisted preference on the real store — reset it so a test
  // that changes it can't leak its pick into the next one.
  usePreferencesStore.setState({ reportsMovementWindow: DEFAULT_ANALYTICS_WINDOW });
  spendEnabled = undefined;
  movementEnabled = undefined;
  abcEnabled = undefined;
  turnoverEnabled = undefined;
  agingEnabled = undefined;
  trendEnabled = undefined;
  hygieneEnabled = undefined;
  salesEnabled = undefined;
  movementWindowArg = undefined;
});

describe('ReportsScreen — aggregate-completion aria-live announcement (Phase 63 / WCAG 4.1.3)', () => {
  it('has a role="status" live region mounted in the DOM before data resolves', () => {
    // Queries still loading → the region exists but carries no announcement text.
    render(<ReportsScreen />);
    const region = screen.getByTestId('reports-live-region');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent?.trim()).toBe('');
  });

  it('announces "Reports ready" with the inventory value once all queries resolve', async () => {
    // Start with queries loading so the region is mounted but empty.
    render(<ReportsScreen />);
    const region = screen.getByTestId('reports-live-region');
    expect(region.textContent?.trim()).toBe('');

    // Resolve all queries; the component re-renders via act so effects flush.
    await act(async () => {
      makeAllLoaded();
    });

    // Re-render is not automatic here because the mock returns a new object on every
    // render call — we need to trigger a re-render by re-rendering the component.
    cleanup();
    makeAllLoaded();
    render(<ReportsScreen />);

    // The region must now carry the "ready" announcement (with the formatted value).
    const readyRegion = screen.getByTestId('reports-live-region');
    const text = readyRegion.textContent ?? '';
    expect(text).toContain('Reports ready');
    expect(text).toContain('£99.50');
  });

  it('announces a failure once all queries error', async () => {
    cleanup();
    makeAllErrored();
    render(<ReportsScreen />);

    // The polite region is empty; the assertive region carries the error.
    const politeRegion = screen.getByTestId('reports-live-region');
    expect(politeRegion.textContent?.trim()).toBe('');

    const alertRegions = screen.getAllByRole('alert');
    const errorRegion = alertRegions.find((el) => el.textContent?.includes('failed'));
    expect(errorRegion).toBeTruthy();
    expect(errorRegion!.textContent).toContain('Reports failed to load.');
  });

  it('warns when stock is left out of the totals for being priced in another currency (#284)', () => {
    cleanup();
    makeAllLoaded();
    queryState.foreignCurrency = { isLoading: false, isError: false, data: 2 };
    render(<ReportsScreen />);

    const notice = screen.getByTestId('foreign-currency-notice');
    expect(notice.textContent).toContain('2 items are not included in these totals');
    // It must name the currency the totals *are* in, or the reader can't act on it.
    expect(notice.textContent).toContain(usePreferencesStore.getState().baseCurrency);
  });

  it('stays silent when every price is in the base currency', () => {
    cleanup();
    makeAllLoaded();
    queryState.foreignCurrency = { isLoading: false, isError: false, data: 0 };
    render(<ReportsScreen />);
    expect(screen.queryByTestId('foreign-currency-notice')).toBeNull();
  });

  it('the polite region stays mounted (empty) while loading — always-mounted contract', () => {
    render(<ReportsScreen />);
    // Must exist in the DOM even before any data, and the SR-only wrapper must be applied.
    const region = screen.getByTestId('reports-live-region');
    expect(region).toBeTruthy();
    // visuallyHidden adds the sr-only class.
    expect(region.className).toContain('sr-only');
  });
});

describe('ReportsScreen — advanced analytics (Phase 74)', () => {
  it('mounts its own analytics live region, empty while the analytics queries load', () => {
    render(<ReportsScreen />);
    const region = screen.getByTestId('analytics-live-region');
    expect(region).toBeTruthy();
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent?.trim()).toBe('');
  });

  it('renders the four analytics panels and announces "Analytics ready" once resolved', () => {
    makeAllLoaded();
    render(<ReportsScreen />);

    expect(screen.getByTestId('abc-breakdown')).toBeTruthy();
    expect(screen.getByTestId('turnover-table')).toBeTruthy();
    expect(screen.getByTestId('stock-aging-chart')).toBeTruthy();
    expect(screen.getByTestId('valuation-sparkline')).toBeTruthy();

    expect(screen.getByTestId('analytics-live-region').textContent).toContain('Analytics ready');
  });

  it('offers the selectable analytics window control', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    const group = screen.getByRole('group', { name: 'Analytics window' });
    expect(group).toBeTruthy();
    // The default 90-day window is pressed.
    const active = group.querySelector('[aria-pressed="true"]');
    expect(active?.textContent).toContain('90');
    // The windows issue #116 asks for, shortest-first. Spelled out rather than compared to
    // `ANALYTICS_WINDOWS`, so the control is pinned to what the user was promised and not
    // merely to whatever the constant happens to say — a window added to the constant but
    // dropped, reordered or relabelled on the way to the DOM fails here.
    const offered = [...group.querySelectorAll('button')].map((b) =>
      Number((b.textContent ?? '').replace(/[^0-9]/g, '')),
    );
    expect(offered).toEqual([7, 14, 30, 60, 90, 180, 365]);
  });

  it('announces a failure once the analytics queries error', () => {
    makeAllErrored();
    render(<ReportsScreen />);
    const alertRegions = screen.getAllByRole('alert');
    const errorRegion = alertRegions.find((el) => el.textContent?.includes('Analytics failed'));
    expect(errorRegion).toBeTruthy();
  });
});

describe('ReportsScreen — spend card gating (Modular UI Phase 7)', () => {
  it('shows the Spend analytics card and enables its query when Purchase orders is on', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    expect(screen.queryByRole('heading', { name: 'Spend analytics' })).not.toBeNull();
    expect(screen.queryByTestId('spend-live-region')).not.toBeNull();
    expect(spendEnabled).toBe(true);
  });

  it('drops the Spend analytics card and disables its query when Purchase orders is off', () => {
    useModulesStore.getState().setFeatureIntent('purchase-orders', false);
    makeAllLoaded();
    render(<ReportsScreen />);
    // The whole card and its aria-live regions are gone — no empty shell, no orphaned announce.
    expect(screen.queryByRole('heading', { name: 'Spend analytics' })).toBeNull();
    expect(screen.queryByTestId('spend-live-region')).toBeNull();
    expect(screen.queryByTestId('spend-error-live-region')).toBeNull();
    // The gated query is disabled, not merely hidden.
    expect(spendEnabled).toBe(false);
    // Sibling report cards are untouched.
    expect(screen.queryByTestId('abc-breakdown')).not.toBeNull();
  });
});

describe('ReportsScreen — below-the-fold reports are gated on visibility (issue #528)', () => {
  /** An observer that is wired up but never reports the element as on screen. */
  class NeverVisibleObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '';
    readonly thresholds: readonly number[] = [];
    constructor(_cb: IntersectionObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }

  /**
   * Put every gated report into the shape a *disabled* TanStack query returns — not loading, not
   * errored, no data. That is what a panel reads while it is off screen, and it is the state the
   * render guards exist for: `!isLoading && !data` is otherwise the screen's "this failed" test.
   * `makeAllLoaded` alone cannot exercise it, because a report with data never reaches the guard.
   */
  function makeGatedIdle() {
    const idle = { isLoading: false, isError: false };
    queryState.movement = { ...idle };
    queryState.abc = { ...idle };
    queryState.turnover = { ...idle };
    queryState.aging = { ...idle };
    queryState.trend = { ...idle };
    queryState.hygiene = { ...idle };
    queryState.spend = { ...idle };
    queryState.sales = { ...idle };
  }

  /** Every report the screen leaves idle until its panel is scrolled to. */
  const gated = () => ({
    movement: movementEnabled,
    abc: abcEnabled,
    turnover: turnoverEnabled,
    aging: agingEnabled,
    trend: trendEnabled,
    hygiene: hygieneEnabled,
    spend: spendEnabled,
    sales: salesEnabled,
  });

  it('leaves every below-the-fold report idle while its panel is off screen', () => {
    // The screen used to fire fourteen queries on mount, six of them a pass over the whole
    // catalogue, before the reader had scrolled anywhere. Eight of them now wait.
    vi.stubGlobal('IntersectionObserver', NeverVisibleObserver);
    makeAllLoaded();
    render(<ReportsScreen />);

    expect(gated()).toEqual({
      movement: false,
      abc: false,
      turnover: false,
      aging: false,
      trend: false,
      hygiene: false,
      spend: false,
      sales: false,
    });
  });

  it('runs every report once the panels are on screen', () => {
    // The default stub reports everything visible, so this is the scrolled-through state.
    makeAllLoaded();
    render(<ReportsScreen />);

    expect(gated()).toEqual({
      movement: true,
      abc: true,
      turnover: true,
      aging: true,
      trend: true,
      hygiene: true,
      spend: true,
      sales: true,
    });
  });

  it('keeps the headline cards ungated, and holds the section announcements back', () => {
    vi.stubGlobal('IntersectionObserver', NeverVisibleObserver);
    makeAllLoaded();
    makeGatedIdle();
    render(<ReportsScreen />);

    // The headline row is above the fold by definition and still resolves. Asserted through
    // the announcement rather than the tile, whose figure counts up from zero on mount.
    expect(screen.getByTestId('reports-live-region').textContent).toContain('Reports ready');
    expect(screen.getByTestId('reports-live-region').textContent).toContain('£99.50');

    // An idle query is not a loading one, so without the gate in the guard these regions would
    // announce a readiness that never happened.
    expect(screen.getByTestId('analytics-live-region').textContent?.trim()).toBe('');
    expect(screen.getByTestId('hygiene-live-region').textContent?.trim()).toBe('');
    expect(screen.getByTestId('spend-live-region').textContent?.trim()).toBe('');
    expect(screen.getByTestId('sales-live-region').textContent?.trim()).toBe('');
  });

  it('shows a spinner rather than a failure in a panel whose report has not run', () => {
    // `!isLoading && !data` is the screen's "this failed" test, and an idle query matches it —
    // so each gated panel folds the gate into that test. Drop `!inView` from any one of the four
    // guards and its message appears here.
    vi.stubGlobal('IntersectionObserver', NeverVisibleObserver);
    makeAllLoaded();
    makeGatedIdle();
    render(<ReportsScreen />);

    expect(screen.queryByText('The stock movement report failed to load.')).toBeNull();
    expect(screen.queryByText('The data hygiene report failed to load.')).toBeNull();
    expect(screen.queryByText('The spend analytics report failed to load.')).toBeNull();
    expect(screen.queryByText('The sales analytics report failed to load.')).toBeNull();

    // …and each of the eight is waiting instead. The ungated panels are all loaded, so every
    // spinner on screen belongs to a gated one.
    expect(screen.getAllByLabelText('Loading')).toHaveLength(8);
  });

  it('reports a gated failure in the panel once its report has actually run', () => {
    // The counterpart: the gate must not swallow a real error. Stock movement is the one that
    // needs its own message — it left the headline `isAnyError` aggregate when it was gated.
    makeAllErrored();
    render(<ReportsScreen />);

    expect(screen.queryByText('The stock movement report failed to load.')).not.toBeNull();
  });
});

describe('ReportsScreen — stock-movement window (issue #86)', () => {
  it('offers a movement window control defaulting to the shared analytics window', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    const group = screen.getByRole('group', { name: 'Stock movement window' });
    expect(group.querySelector('[aria-pressed="true"]')?.textContent).toContain(
      String(DEFAULT_ANALYTICS_WINDOW),
    );
    // The panel heading names the same span the control reports.
    expect(
      screen.queryByRole('heading', { name: `Stock movement (last ${DEFAULT_ANALYTICS_WINDOW} days)` }),
    ).not.toBeNull();
    // …and the query is actually fetched over that span, not the old fixed 30-day one.
    expect(movementWindowArg).toBe(DEFAULT_ANALYTICS_WINDOW);
  });

  it('retitles the panel and stores the pick when another window is chosen', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    const group = screen.getByRole('group', { name: 'Stock movement window' });
    const option365 = Array.from(group.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('365'),
    );
    expect(option365).toBeDefined();
    act(() => {
      fireEvent.click(option365!);
    });
    expect(screen.queryByRole('heading', { name: 'Stock movement (last 365 days)' })).not.toBeNull();
    // The refetch uses the new span — the title and the data agree.
    expect(movementWindowArg).toBe(365);
    // Persisted as intent so the pick survives a reload.
    expect(usePreferencesStore.getState().reportsMovementWindow).toBe(365);
  });

  it('leaves the sibling analytics window untouched when the movement window changes', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    const movementGroup = screen.getByRole('group', { name: 'Stock movement window' });
    const option7 = Array.from(movementGroup.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('7'),
    );
    act(() => {
      fireEvent.click(option7!);
    });
    // Each section remembers its own window independently.
    const analyticsGroup = screen.getByRole('group', { name: 'Analytics window' });
    expect(analyticsGroup.querySelector('[aria-pressed="true"]')?.textContent).toContain('90');
  });
});

describe('ReportsScreen — consumption is reported per unit of measure (issue #685)', () => {
  it('labels the headline tile with the largest unit and counts the others', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    // The test id sits on the value itself; the sub-label is its sibling in the card.
    const card = screen.getByTestId('stat-consumption').parentElement!;
    // The rate carries its unit, and the tile says the figure is not the whole story.
    // (The figure itself animates up from 0, so only the unit is asserted here.)
    expect(card.textContent).toContain('g/day');
    expect(card.textContent).toContain('30g total, plus 1 other unit');
  });

  it('lists every unit separately, with no total across them', () => {
    makeAllLoaded();
    render(<ReportsScreen />);
    const list = screen.getByTestId('consumption-breakdown');
    const rows = Array.from(list.querySelectorAll('li')).map((li) => li.textContent ?? '');
    expect(rows).toHaveLength(2);
    // A real unit prints through the shared `measure` formatter, exactly as a gauge does.
    expect(rows[0]).toContain('30g total');
    expect(rows[0]).toContain('1g/day');
    // Items with no unit of measure read as a plain count of units.
    expect(rows[1]).toContain('5 units total');
    expect(rows[1]).toContain('0.2 units/day');
  });

  it('says nothing was consumed rather than showing a zero rate', () => {
    makeAllLoaded();
    queryState.consumption = { isLoading: false, isError: false, data: { windowDays: 30, lines: [] } };
    render(<ReportsScreen />);
    const card = screen.getByTestId('stat-consumption').parentElement!;
    expect(card.textContent).toContain('Nothing consumed');
    expect(screen.queryByTestId('consumption-breakdown')).toBeNull();
  });
});
