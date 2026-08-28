import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Each badge is a dedicated count query (issue #573); stub the domain count hooks as
// arg-capturing spies so we can assert both the figure that reaches the tile *and* what was
// asked for — which filter/scope the query ran with, and that the counts a tile's metric does
// not need stay gated (`enabled: false`) rather than fetching.
const itemCountMock = vi.fn();
const projectCountMock = vi.fn();
const budgetAlertsMock = vi.fn();
const purchaseOrderCountMock = vi.fn();
const contactCountMock = vi.fn();
const bookingCountMock = vi.fn();
const lowStockMock = vi.fn();
const outOfStockMock = vi.fn();

vi.mock('@/features/inventory/queries', () => ({
  useItemCount: (filters: unknown, enabled?: boolean) => itemCountMock(filters, enabled),
}));
vi.mock('@/features/projects/projects', () => ({
  useProjectCount: (filter: unknown, opts: { enabled?: boolean }) => projectCountMock(filter, opts),
  useBudgetAlerts: (opts: { enabled?: boolean }) => budgetAlertsMock(opts),
}));
vi.mock('@/features/purchasing/queries', () => ({
  usePurchaseOrderCount: (filter: unknown) => purchaseOrderCountMock(filter),
}));
vi.mock('@/features/contacts/contacts', () => ({ useContactCount: () => contactCountMock() }));
vi.mock('@/features/bookings/bookings', () => ({
  useBookingCount: (scope: string) => bookingCountMock(scope),
}));
vi.mock('@/features/reports/queries', () => ({
  useLowStockCount: (opts: { enabled?: boolean }) => lowStockMock(opts),
  useOutOfStockCount: (opts: { enabled?: boolean }) => outOfStockMock(opts),
}));

import { countOverBudgetProjects, useNavCounts } from './useNavCounts';
import { ACTIVE_PROJECT_STATUSES } from '@/db/repositories';
import { DEFAULT_NAV_COUNT_METRICS, type NavCountRoute } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

/** Point one configurable tile at a metric for the duration of a test. */
function setMetric(route: NavCountRoute, metric: string): void {
  usePreferencesStore.getState().setNavCountMetric(route, metric);
}

beforeEach(() => {
  // Default: every source still loading (no data) ⇒ empty map.
  itemCountMock.mockReturnValue({ data: undefined });
  projectCountMock.mockReturnValue({ data: undefined });
  budgetAlertsMock.mockReturnValue({ data: undefined });
  purchaseOrderCountMock.mockReturnValue({ data: undefined });
  contactCountMock.mockReturnValue({ data: undefined });
  bookingCountMock.mockReturnValue({ data: undefined });
  lowStockMock.mockReturnValue({ data: undefined });
  outOfStockMock.mockReturnValue({ data: undefined });
  // Reset every tile to its shipped default metric so a prior test can't leak a choice.
  usePreferencesStore.setState({ navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS } });
});

afterEach(() => {
  usePreferencesStore.setState({ navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS } });
  vi.clearAllMocks();
});

describe('useNavCounts — default metrics', () => {
  it('omits a destination whose source has not resolved yet', () => {
    const { result } = renderHook(() => useNavCounts());
    expect(result.current).toEqual({});
  });

  it('passes the inventory total straight through (including a genuine 0)', () => {
    itemCountMock.mockReturnValue({ data: 0 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/inventory']).toEqual({
      count: 0,
      noun: 'item',
      nounPlural: 'items',
      tone: 'neutral',
    });
    // The default total costs no problem-metric fetch — both stay disabled.
    expect(lowStockMock).toHaveBeenCalledWith({ enabled: false });
    expect(outOfStockMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('counts active projects with a status filter the database resolves, and names them', () => {
    projectCountMock.mockReturnValue({ data: 250 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/projects']).toEqual({
      count: 250,
      noun: 'active project',
      nounPlural: 'active projects',
      tone: 'neutral',
    });
    // "Active" is asked of the database as a status set, not filtered out of a page of rows —
    // and it is the derived set, so a new non-terminal status joins it automatically.
    expect(projectCountMock).toHaveBeenCalledWith(
      { statuses: ACTIVE_PROJECT_STATUSES },
      { enabled: true, keepPrevious: false },
    );
    expect(ACTIVE_PROJECT_STATUSES).toEqual(['PLANNING', 'ACTIVE']);
    // The over-budget feed is not fetched while the tile shows its default metric.
    expect(budgetAlertsMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('counts open purchase orders through the open filter, not a page of rows', () => {
    // The regression this guards (issue #573): the first page of orders can be entirely
    // RECEIVED while a hundred open ones sit behind it, so the tile must ask for the count.
    purchaseOrderCountMock.mockReturnValue({ data: 137 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/purchase-orders']?.count).toBe(137);
    expect(purchaseOrderCountMock).toHaveBeenCalledWith({ open: true });
  });

  it('counts every contact from the exact total, past the 100-row page cap', () => {
    contactCountMock.mockReturnValue({ data: 250 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/contacts']).toEqual({
      count: 250,
      noun: 'contact',
      nounPlural: 'contacts',
      tone: 'neutral',
    });
  });

  it('counts upcoming bookings through the upcoming scope', () => {
    bookingCountMock.mockReturnValue({ data: 4 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']?.count).toBe(4);
    expect(bookingCountMock).toHaveBeenCalledWith('upcoming');
  });
});

describe('useNavCounts — configurable metrics', () => {
  it('counts all projects when the tile is re-pointed at "all"', () => {
    setMetric('/projects', 'all');
    projectCountMock.mockReturnValue({ data: 12 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/projects']).toEqual({
      count: 12,
      noun: 'project',
      nounPlural: 'projects',
      tone: 'neutral',
    });
    // "All" drops the status filter rather than passing an empty set (which matches nothing).
    expect(projectCountMock).toHaveBeenCalledWith({}, { enabled: true, keepPrevious: false });
  });

  it('counts all purchase orders when the tile is re-pointed at "all"', () => {
    setMetric('/purchase-orders', 'all');
    purchaseOrderCountMock.mockReturnValue({ data: 2 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/purchase-orders']).toEqual({
      count: 2,
      noun: 'order',
      nounPlural: 'orders',
      tone: 'neutral',
    });
    expect(purchaseOrderCountMock).toHaveBeenCalledWith({});
  });

  it('counts bookings starting this week and names them with the phrase plural', () => {
    setMetric('/bookings', 'thisWeek');
    bookingCountMock.mockReturnValue({ data: 1 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']).toEqual({
      count: 1,
      noun: 'booking starting this week',
      nounPlural: 'bookings starting this week',
      tone: 'neutral',
    });
    expect(bookingCountMock).toHaveBeenCalledWith('startingThisWeek');
  });

  it('counts every booking, terminal ones included, when re-pointed at "all"', () => {
    setMetric('/bookings', 'all');
    bookingCountMock.mockReturnValue({ data: 9 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']).toEqual({
      count: 9,
      noun: 'booking',
      nounPlural: 'bookings',
      tone: 'neutral',
    });
    expect(bookingCountMock).toHaveBeenCalledWith('all');
  });

  it('falls back to the tile default when a stale metric id is persisted', () => {
    usePreferencesStore.setState({
      navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS, '/projects': 'nonsense' },
    });
    projectCountMock.mockReturnValue({ data: 1 });
    const { result } = renderHook(() => useNavCounts());
    // 'active' default: the status filter is applied, and the tile is named for it.
    expect(result.current['/projects']?.noun).toBe('active project');
    expect(projectCountMock).toHaveBeenCalledWith(
      { statuses: ACTIVE_PROJECT_STATUSES },
      { enabled: true, keepPrevious: false },
    );
  });
});

describe('useNavCounts — A2 problem metrics', () => {
  it('counts low-stock items from the true-count hook, with a warning tone, when selected', () => {
    setMetric('/inventory', 'lowStock');
    itemCountMock.mockReturnValue({ data: 500 }); // the total is *not* what a low-stock tile shows
    lowStockMock.mockReturnValue({ data: 5 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/inventory']).toEqual({
      count: 5,
      noun: 'low-stock item',
      nounPlural: 'low-stock items',
      tone: 'warning',
    });
    // Only the selected count fetches — the item total is gated off as well.
    expect(lowStockMock).toHaveBeenCalledWith({ enabled: true });
    expect(outOfStockMock).toHaveBeenCalledWith({ enabled: false });
    expect(itemCountMock).toHaveBeenCalledWith({}, false);
  });

  it('counts out-of-stock items with a danger tone when selected', () => {
    setMetric('/inventory', 'outOfStock');
    outOfStockMock.mockReturnValue({ data: 2 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/inventory']).toEqual({
      count: 2,
      noun: 'out-of-stock item',
      nounPlural: 'out-of-stock items',
      tone: 'danger',
    });
    expect(outOfStockMock).toHaveBeenCalledWith({ enabled: true });
    expect(lowStockMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('omits the Inventory tile while its selected problem query is still loading', () => {
    setMetric('/inventory', 'lowStock');
    itemCountMock.mockReturnValue({ data: 500 });
    lowStockMock.mockReturnValue({ data: undefined }); // not resolved yet
    const { result } = renderHook(() => useNavCounts());
    // The default total must not leak through while low-stock is the chosen metric.
    expect(result.current['/inventory']).toBeUndefined();
  });

  it('counts over-budget projects from the budget feed, with a danger tone, when selected', () => {
    setMetric('/projects', 'overBudget');
    budgetAlertsMock.mockReturnValue({
      data: [
        // Spend (120) is over the 100 budget → OVER regardless of the warn threshold.
        { budget: 100, committedFromBom: 120, manualExpenseTotal: 0, estimatedCost: 120 },
        // Well within budget → not over.
        { budget: 100, committedFromBom: 10, manualExpenseTotal: 0, estimatedCost: 10 },
      ],
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/projects']).toEqual({
      count: 1,
      noun: 'over-budget project',
      nounPlural: 'over-budget projects',
      tone: 'danger',
    });
    expect(budgetAlertsMock).toHaveBeenCalledWith({ enabled: true });
    // The plain project count is gated off — the over-budget tile does not need it.
    expect(projectCountMock).toHaveBeenCalledWith(expect.anything(), {
      enabled: false,
      keepPrevious: false,
    });
  });
});

describe('nav-count selectors (pure)', () => {
  it('countOverBudgetProjects: counts a project over on either spend-so-far or projected cost', () => {
    const warnPercent = 80;
    const rows = [
      // Spend so far is over budget.
      { budget: 100, committedFromBom: 110, manualExpenseTotal: 0, estimatedCost: 50 },
      // Spend so far is fine, but the projected final cost (estimate + expenses) is over.
      { budget: 100, committedFromBom: 10, manualExpenseTotal: 20, estimatedCost: 90 },
      // Merely "warning" (≥80% but ≤100%), not over — excluded.
      { budget: 100, committedFromBom: 85, manualExpenseTotal: 0, estimatedCost: 85 },
      // Comfortably within budget — excluded.
      { budget: 100, committedFromBom: 10, manualExpenseTotal: 0, estimatedCost: 10 },
    ];
    expect(countOverBudgetProjects(rows, warnPercent)).toBe(2);
    expect(countOverBudgetProjects([], warnPercent)).toBe(0);
  });
});
