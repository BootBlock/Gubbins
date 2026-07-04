import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Each count comes from a domain hook; stub them so we exercise only the "what counts as
// active/open/upcoming/…" selectors that live in useNavCounts.
const itemCountMock = vi.fn();
const projectsMock = vi.fn();
const purchaseOrdersMock = vi.fn();
const contactsMock = vi.fn();
const bookingsMock = vi.fn();

vi.mock('@/features/inventory/queries', () => ({ useItemCount: () => itemCountMock() }));
vi.mock('@/features/projects/projects', () => ({ useProjects: () => projectsMock() }));
vi.mock('@/features/purchasing/queries', () => ({ usePurchaseOrders: () => purchaseOrdersMock() }));
vi.mock('@/features/contacts/contacts', () => ({ useContacts: () => contactsMock() }));
vi.mock('@/features/bookings/bookings', () => ({ useBookings: () => bookingsMock() }));

import { countBookings, countProjects, countPurchaseOrders, useNavCounts } from './useNavCounts';
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
  purchaseOrdersMock.mockReturnValue({ data: undefined });
  contactsMock.mockReturnValue({ data: undefined });
  bookingsMock.mockReturnValue({ data: undefined });
  // Reset every tile to its shipped default metric so a prior test can't leak a choice.
  usePreferencesStore.setState({ navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS } });
});

afterEach(() => {
  usePreferencesStore.setState({ navCountMetrics: { ...DEFAULT_NAV_COUNT_METRICS } });
});

describe('useNavCounts — default metrics', () => {
  it('omits a destination whose source has not resolved yet', () => {
    const { result } = renderHook(() => useNavCounts());
    expect(result.current).toEqual({});
  });

  it('passes the inventory total straight through (including a genuine 0)', () => {
    itemCountMock.mockReturnValue({ data: 0 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/inventory']).toEqual({ count: 0, noun: 'item', nounPlural: 'items' });
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
    });
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
    expect(result.current['/contacts']).toEqual({ count: 3, noun: 'contact', nounPlural: 'contacts' });
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
    expect(result.current['/projects']).toEqual({ count: 3, noun: 'project', nounPlural: 'projects' });
  });

  it('counts all purchase orders when the tile is re-pointed at "all"', () => {
    setMetric('/purchase-orders', 'all');
    purchaseOrdersMock.mockReturnValue({
      data: { rows: [{ effectiveStatus: 'RECEIVED' }, { effectiveStatus: 'CANCELLED' }] },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/purchase-orders']).toEqual({ count: 2, noun: 'order', nounPlural: 'orders' });
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
});
