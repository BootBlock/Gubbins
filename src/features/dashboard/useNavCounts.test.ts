import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Each count comes from a domain hook; stub them so we exercise only the "what counts as
// active/open/upcoming" filters that live in useNavCounts.
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

import { useNavCounts } from './useNavCounts';

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  // Default: every source still loading (no data) ⇒ empty map.
  itemCountMock.mockReturnValue({ data: undefined });
  projectsMock.mockReturnValue({ data: undefined });
  purchaseOrdersMock.mockReturnValue({ data: undefined });
  contactsMock.mockReturnValue({ data: undefined });
  bookingsMock.mockReturnValue({ data: undefined });
});

describe('useNavCounts', () => {
  it('omits a destination whose source has not resolved yet', () => {
    const { result } = renderHook(() => useNavCounts());
    expect(result.current).toEqual({});
  });

  it('passes the inventory total straight through (including a genuine 0)', () => {
    itemCountMock.mockReturnValue({ data: 0 });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/inventory']).toBe(0);
  });

  it('counts only active projects — not completed or archived', () => {
    projectsMock.mockReturnValue({
      data: {
        rows: [{ status: 'PLANNING' }, { status: 'ACTIVE' }, { status: 'COMPLETED' }, { status: 'ARCHIVED' }],
      },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/projects']).toBe(2);
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
    expect(result.current['/purchase-orders']).toBe(3);
  });

  it('counts every contact', () => {
    contactsMock.mockReturnValue({ data: { rows: [{}, {}, {}] } });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/contacts']).toBe(3);
  });

  it('counts upcoming bookings — excluding cancelled, converted and past ones', () => {
    const future = Date.now() + 5 * DAY;
    const past = Date.now() - 5 * DAY;
    bookingsMock.mockReturnValue({
      data: {
        rows: [
          { endDate: future, cancelledAt: null, convertedCheckoutId: null }, // upcoming ✓
          { endDate: past, cancelledAt: null, convertedCheckoutId: null }, // ended ✗
          { endDate: future, cancelledAt: Date.now(), convertedCheckoutId: null }, // cancelled ✗
          { endDate: future, cancelledAt: null, convertedCheckoutId: 'co-1' }, // converted ✗
        ],
      },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']).toBe(1);
  });

  it('keeps a booking whose last day is today (endDate snapped to that day start)', () => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    bookingsMock.mockReturnValue({
      data: { rows: [{ endDate: todayStart.getTime(), cancelledAt: null, convertedCheckoutId: null }] },
    });
    const { result } = renderHook(() => useNavCounts());
    expect(result.current['/bookings']).toBe(1);
  });
});
