/**
 * Component tests for BookingsScreen — the bounded-read notice (issue #149).
 *
 * The bookings list is grouped by derived status with a count on each heading, so it does not
 * take a pager: slicing the list into pages would leave every one of those badges counting only
 * the rows that happened to land on the current page. It reports that the read is cut short
 * instead — which is the thing that was missing, not the pager.
 *
 * Mocked at the query boundary so no DB or QueryClient is needed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { AssetBookingWithNames } from '@/db/repositories';

let bookingsState: {
  isLoading: boolean;
  isError?: boolean;
  data?: { rows: AssetBookingWithNames[]; hasMore: boolean };
};

vi.mock('./bookings', () => ({
  useBookings: () => ({ ...bookingsState, refetch: vi.fn(), isFetching: false }),
  useBookableAssets: () => ({ data: [] }),
  useCreateBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useConvertBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteBooking: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/features/contacts/contacts', () => ({
  useContacts: () => ({ data: { rows: [] } }),
}));

vi.mock('@/lib/useFormatters', () => ({
  useFormatters: () => ({
    calendarDate: () => '1 Jan 2026',
    currency: (v: number) => `£${v.toFixed(2)}`,
    currencyParts: (v: number) => [
      { type: 'currency', value: '£' },
      { type: 'literal', value: v.toFixed(2) },
    ],
    quantity: (v: number) => String(v),
    date: () => '',
    dateTime: () => '',
    relativeTime: () => '',
    percent: () => '',
  }),
}));

// Stub the router Link so the screen renders without a RouterProvider.
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

// The global nav menu has its own suite; stub it so this test needs no router/alerts context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

// Imported after the mocks are registered.
import { BookingsScreen } from './BookingsScreen';

/** One booking, far enough in the future to derive as "upcoming". */
function makeBooking(id: string): AssetBookingWithNames {
  return {
    id,
    itemId: `item-${id}`,
    itemName: `Asset ${id}`,
    contactId: null,
    contactName: null,
    startDate: Date.UTC(2099, 0, 1),
    endDate: Date.UTC(2099, 0, 2),
    note: null,
    cancelledAt: null,
    convertedCheckoutId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

afterEach(cleanup);

beforeEach(() => {
  bookingsState = { isLoading: false, data: { rows: [], hasMore: false } };
});

describe('BookingsScreen — a bounded read (issue #149)', () => {
  it('says the list is cut short when the read came back full', () => {
    const rows = Array.from({ length: 100 }, (_, i) => makeBooking(String(i)));
    bookingsState = { isLoading: false, data: { rows, hasMore: true } };
    render(<BookingsScreen />);

    const notice = screen.getByTestId('bookings-truncated');
    expect(notice.textContent).toContain('100');
  });

  it('stays quiet when every booking fits in one read', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);
    expect(screen.queryByTestId('bookings-truncated')).toBeNull();
  });

  it('stays quiet while the list is still loading', () => {
    bookingsState = { isLoading: true };
    render(<BookingsScreen />);
    expect(screen.queryByTestId('bookings-truncated')).toBeNull();
  });

  it('stays quiet on a failed load, where the error speaks instead', () => {
    bookingsState = { isLoading: false, isError: true };
    render(<BookingsScreen />);
    expect(screen.queryByTestId('bookings-truncated')).toBeNull();
    expect(screen.getByTestId('bookings-load-error')).toBeInTheDocument();
  });
});
