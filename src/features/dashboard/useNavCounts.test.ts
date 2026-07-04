import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Each count comes from a domain hook; stub them so we exercise only the "what counts as
// active/open/upcoming/…" selectors that live in useNavCounts. The A2 problem-metric hooks are
// stubbed as arg-capturing spies so we can also assert they are *gated* — only fetched (enabled)
// when their metric is the tile's current choice.
const itemCountMock = vi.fn();
const projectsMock = vi.fn();
const budgetAlertsMock = vi.fn();
const purchaseOrdersMock = vi.fn();
const contactsMock = vi.fn();
const bookingsMock = vi.fn();
const lowStockMock = vi.fn();
const outOfStockMock = vi.fn();

vi.mock('@/features/inventory/queries', () => ({ useItemCount: () => itemCountMock() }));
vi.mock('@/features/projects/projects', () => ({
  useProjects: () => projectsMock(),
  useBudgetAlerts: (opts: { enabled?: boolean }) => budgetAlertsMock(opts),
}));
vi.mock('@/features/purchasing/queries', () => ({ usePurchaseOrders: () => purchaseOrdersMock() }));
vi.mock('@/features/contacts/contacts', () => ({ useContacts: () => contactsMock() }));
vi.mock('@/features/bookings/bookings', () => ({ useBookings: () => bookingsMock() }));
vi.mock('@/features/reports/queries', () => ({
  useLowStockCount: (opts: { enabled?: boolean }) => lowStockMock(opts),
  useOutOfStockCount: (opts: { enabled?: boolean }) => outOfStockMock(opts),
}));

import {
  countBookings,
  countOverBudgetProjects,
  countProjects,
  countPurchaseOrders,
  useNavCounts,
} from './useNavCounts';
import { DEFAULT_NAV_COUNT_METRICS, type NavCountRoute } from '@/features/settings/settings';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';

const DAY = 24 * 60 * 60 * 1000;

/** Point one configurable tile at a metric for the duration of a test. */
function setMetric(route: NavCountRoute, metric: string): void {
  usePreferencesStore.getState().setNavCountMetric(route, metric);
}

beforeEach(() => {
  // Default: every source still loading (no data) ⇒ empty map.
  itemCountMock.mockReturnValue({ data: undefined });
  projectsMock.mockReturnValue({ data: undefined });
  budgetAlertsMock.mockReturnValue({ data: undefined });
  purchaseOrdersMock.mockReturnValue({ data: undefined });
  contactsMock.mockReturnValue({ data: undefined });
  bookingsMock.mockReturnValue({ data: undefined });
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

  it('counts only active projects — not completed or archived — and names them', () => {
    projectsMock.mockReturnValue({
      data: {
        rows: [{ status: 'PLANNING' }, { status: 'ACTIVE' }, { status: 'COMPLETED' }, { status: 'ARCHIVED' }],
      },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/projects']).toEqual({
      count: 2,
      noun: 'active project',
      nounPlural: 'active projects',
      tone: 'neutral',
    });
    // The over-budget feed is not fetched while the tile shows its default metric.
    expect(budgetAlertsMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('counts only open purchase orders — not received or cancelled', () => {
    purchaseOrdersMock.mockReturnValue({
      data: {
        rows: [
          { effectiveStatus: 'DRAFT' },
          { effectiveStatus: 'ORDERED' },
          { effectiveStatus: 'PARTIAL' },
          { effectiveStatus: 'RECEIVED' },
          { effectiveStatus: 'CANCELLED' },
        ],
      },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/purchase-orders']?.count).toBe(3);
  });

  it('counts every contact', () => {
    contactsMock.mockReturnValue({ data: { rows: [{}, {}, {}] } });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/contacts']).toEqual({
      count: 3,
      noun: 'contact',
      nounPlural: 'contacts',
      tone: 'neutral',
    });
  });

  it('counts upcoming bookings — excluding cancelled, converted and past ones', () => {
    const future = Date.now() + 5 * DAY;
    const past = Date.now() - 5 * DAY;
    bookingsMock.mockReturnValue({
      data: {
        rows: [
          { startDate: future, endDate: future, cancelledAt: null, convertedCheckoutId: null }, // upcoming ✓
          { startDate: past, endDate: past, cancelledAt: null, convertedCheckoutId: null }, // ended ✗
          { startDate: future, endDate: future, cancelledAt: Date.now(), convertedCheckoutId: null }, // cancelled ✗
          { startDate: future, endDate: future, cancelledAt: null, convertedCheckoutId: 'co-1' }, // converted ✗
        ],
      },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']?.count).toBe(1);
  });
});

describe('useNavCounts — configurable metrics', () => {
  it('counts all projects when the tile is re-pointed at "all"', () => {
    setMetric('/projects', 'all');
    projectsMock.mockReturnValue({
      data: { rows: [{ status: 'ACTIVE' }, { status: 'COMPLETED' }, { status: 'ARCHIVED' }] },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/projects']).toEqual({
      count: 3,
      noun: 'project',
      nounPlural: 'projects',
      tone: 'neutral',
    });
  });

  it('counts all purchase orders when the tile is re-pointed at "all"', () => {
    setMetric('/purchase-orders', 'all');
    purchaseOrdersMock.mockReturnValue({
      data: { rows: [{ effectiveStatus: 'RECEIVED' }, { effectiveStatus: 'CANCELLED' }] },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/purchase-orders']).toEqual({
      count: 2,
      noun: 'order',
      nounPlural: 'orders',
      tone: 'neutral',
    });
  });

  it('counts bookings starting this week and names them with the phrase plural', () => {
    setMetric('/bookings', 'thisWeek');
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const inWeek = start.getTime() + 3 * DAY;
    const nextWeek = start.getTime() + 10 * DAY;
    bookingsMock.mockReturnValue({
      data: {
        rows: [
          { startDate: inWeek, endDate: inWeek, cancelledAt: null, convertedCheckoutId: null }, // this week ✓
          { startDate: nextWeek, endDate: nextWeek, cancelledAt: null, convertedCheckoutId: null }, // later ✗
          { startDate: inWeek, endDate: inWeek, cancelledAt: Date.now(), convertedCheckoutId: null }, // cancelled ✗
        ],
      },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']).toEqual({
      count: 1,
      noun: 'booking starting this week',
      nounPlural: 'bookings starting this week',
      tone: 'neutral',
    });
  });

  it('falls back to the tile default when a stale metric id is persisted', () => {
    usePreferencesStore.setState({
      navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS, '/projects': 'nonsense' },
    });
    projectsMock.mockReturnValue({ data: { rows: [{ status: 'ACTIVE' }, { status: 'COMPLETED' }] } });
    const { result } = renderHook(() => useNavCounts());
    // 'active' default: the COMPLETED row is excluded.
    expect(result.current['/projects']?.count).toBe(1);
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
    // Only the selected problem query fetches.
    expect(lowStockMock).toHaveBeenCalledWith({ enabled: true });
    expect(outOfStockMock).toHaveBeenCalledWith({ enabled: false });
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
  });
});

describe('nav-count selectors (pure)', () => {
  it('countProjects: active excludes finished/shelved; all counts everything', () => {
    const rows = [{ status: 'ACTIVE' }, { status: 'COMPLETED' }, { status: 'ARCHIVED' }];
    expect(countProjects(rows, 'active')).toBe(1);
    expect(countProjects(rows, 'all')).toBe(3);
  });

  it('countPurchaseOrders: open excludes received/cancelled; all counts everything', () => {
    const rows = [
      { effectiveStatus: 'ORDERED' },
      { effectiveStatus: 'RECEIVED' },
      { effectiveStatus: 'CANCELLED' },
    ];
    expect(countPurchaseOrders(rows, 'open')).toBe(1);
    expect(countPurchaseOrders(rows, 'all')).toBe(3);
  });

  it('countBookings: keeps a booking whose last day is today (endDate snapped to that day start)', () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const rows = [
      {
        startDate: todayStart.getTime(),
        endDate: todayStart.getTime(),
        cancelledAt: null,
        convertedCheckoutId: null,
      },
    ];
    expect(countBookings(rows, 'upcoming')).toBe(1);
  });

  it('countBookings: "all" counts every booking, even cancelled/converted/past ones', () => {
    const past = Date.now() - 30 * DAY;
    const rows = [
      { startDate: past, endDate: past, cancelledAt: Date.now(), convertedCheckoutId: null },
      { startDate: past, endDate: past, cancelledAt: null, convertedCheckoutId: 'co-1' },
    ];
    expect(countBookings(rows, 'all')).toBe(2);
    expect(countBookings(rows, 'upcoming')).toBe(0);
  });

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
