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
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string; [k: string]: unknown }) =>
    <a href={to} {...props}>{children}</a>,
}));

// Stub the Foundry BrandMark and icon-heavy sub-components so happy-dom
// doesn't need real SVG / canvas support.
vi.mock('@/components/BrandMark', () => ({
  BrandMark: () => <span data-testid="brand-mark" />,
}));
vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  // Replace every icon with a lightweight span so we don't need SVG/canvas in jsdom.
  return Object.fromEntries(
    Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]),
  );
});

// Stub the breakdown / chart / export sub-components (not under test here).
vi.mock('./components/ValueBreakdown', () => ({
  ValueBreakdown: () => <div data-testid="value-breakdown" />,
}));
vi.mock('./components/MovementChart', () => ({
  MovementChart: () => <div data-testid="movement-chart" />,
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
  'value' | 'consumption' | 'movement' | 'lowStock' | 'deadStock',
  FakeQueryState
> = {
  value:       { isLoading: true, isError: false },
  consumption: { isLoading: true, isError: false },
  movement:    { isLoading: true, isError: false },
  lowStock:    { isLoading: true, isError: false },
  deadStock:   { isLoading: true, isError: false },
};

function makeAllLoaded() {
  queryState.value       = { isLoading: false, isError: false, data: { totalValue: 99.5, totalQuantity: 10, byCategory: [], byLocation: [] } };
  queryState.consumption = { isLoading: false, isError: false, data: { perDay: 1, totalConsumed: 5, windowDays: 30 } };
  queryState.movement    = { isLoading: false, isError: false, data: { buckets: [], totalIn: 0, totalOut: 0, windowDays: 30 } };
  queryState.lowStock    = { isLoading: false, isError: false, data: 0 };
  queryState.deadStock   = { isLoading: false, isError: false, data: { lines: [], totalValue: 0 } };
}

function makeAllErrored() {
  queryState.value       = { isLoading: false, isError: true };
  queryState.consumption = { isLoading: false, isError: true };
  queryState.movement    = { isLoading: false, isError: true };
  queryState.lowStock    = { isLoading: false, isError: true };
  queryState.deadStock   = { isLoading: false, isError: true };
}

function makeAllLoading() {
  queryState.value       = { isLoading: true, isError: false };
  queryState.consumption = { isLoading: true, isError: false };
  queryState.movement    = { isLoading: true, isError: false };
  queryState.lowStock    = { isLoading: true, isError: false };
  queryState.deadStock   = { isLoading: true, isError: false };
}

vi.mock('./queries', () => ({
  REPORT_WINDOW_DAYS: 30,
  DEAD_STOCK_SINCE_DAYS: 90,
  REPORT_MOVEMENT_BUCKETS: 15,
  useInventoryValue:   () => ({ ...queryState.value }),
  useConsumptionRate:  () => ({ ...queryState.consumption }),
  useMovement:         () => ({ ...queryState.movement }),
  useLowStockCount:    () => ({ ...queryState.lowStock }),
  useDeadStock:        () => ({ ...queryState.deadStock }),
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
