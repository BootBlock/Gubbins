/**
 * Component tests for the ReportsScreen aria-live aggregate-completion announcement
 * (Phase 63 — broader aria-live status-message coverage / WCAG 4.1.3).
 *
 * Strategy: mock the five query hooks (./queries) at the module boundary so the
 * component under test never touches TanStack Query, the SQLite worker, or any
 * repository. Also mock leaf dependencies that pull in the router or chart canvas
 * so the test stays in happy-dom with no extra providers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

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
  | 'spend',
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
    data: { perDay: 1, totalConsumed: 5, windowDays: 30 },
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

vi.mock('./queries', () => ({
  REPORT_WINDOW_DAYS: 30,
  DEAD_STOCK_SINCE_DAYS: 90,
  REPORT_MOVEMENT_BUCKETS: 15,
  ABC_WINDOW_DAYS: 365,
  ANALYTICS_WINDOWS: [30, 90, 365],
  DEFAULT_ANALYTICS_WINDOW: 90,
  VALUATION_TREND_POINTS: 12,
  DATA_HYGIENE_STALE_DAYS: 180,
  SPEND_BUCKETS: 15,
  useInventoryValue: () => ({ ...queryState.value }),
  useConsumptionRate: () => ({ ...queryState.consumption }),
  useMovement: () => ({ ...queryState.movement }),
  useLowStockCount: () => ({ ...queryState.lowStock }),
  useDeadStock: () => ({ ...queryState.deadStock }),
  useAbcAnalysis: () => ({ ...queryState.abc }),
  useTurnover: () => ({ ...queryState.turnover }),
  useStockAging: () => ({ ...queryState.aging }),
  useValuationTrend: () => ({ ...queryState.trend }),
  useDataHygiene: () => ({ ...queryState.hygiene }),
  useSpendAnalytics: () => ({ ...queryState.spend }),
}));

// --------------------------------------------------------------------------
// The component under test (imported AFTER all mocks are declared).
// --------------------------------------------------------------------------
import { ReportsScreen } from './ReportsScreen';

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  makeAllLoading();
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
  });

  it('announces a failure once the analytics queries error', () => {
    makeAllErrored();
    render(<ReportsScreen />);
    const alertRegions = screen.getAllByRole('alert');
    const errorRegion = alertRegions.find((el) => el.textContent?.includes('Analytics failed'));
    expect(errorRegion).toBeTruthy();
  });
});
