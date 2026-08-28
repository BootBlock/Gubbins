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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AssetBookingWithNames } from '@/db/repositories';

let bookingsState: {
  isLoading: boolean;
  isError?: boolean;
  data?: { rows: AssetBookingWithNames[]; hasMore: boolean };
};

// The export menu owns its own download + toast machinery (covered by its own tests) and needs a
// ToastProvider; here we only care that the screen offers it.
vi.mock('@/features/export/TabularExportMenu', () => ({
  TabularExportMenu: ({ disabled, testIdPrefix }: { disabled?: boolean; testIdPrefix: string }) => (
    <button type="button" data-testid={testIdPrefix} disabled={disabled}>
      Export
    </button>
  ),
}));

// Hoisted so the tests below can assert what the card actually asked the repository to do.
const mutations = vi.hoisted(() => ({ convert: vi.fn(), update: vi.fn() }));

vi.mock('./bookings', () => ({
  useBookings: () => ({ ...bookingsState, refetch: vi.fn(), isFetching: false }),
  readBookingsPage: vi.fn(),
  useBookableAssets: () => ({ data: [] }),
  useCreateBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelBooking: () => ({ mutate: vi.fn(), isPending: false }),
  useConvertBooking: () => ({ mutate: mutations.convert, isPending: false }),
  useUpdateBooking: () => ({ mutate: mutations.update, isPending: false }),
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
  mutations.convert.mockReset();
  mutations.update.mockReset();
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

/**
 * The booking list can be taken away as a file (issue #132). The menu is stubbed (its download +
 * toast machinery has its own suite), so these assert what this screen owns: that it offers the
 * control, and gates it on there being a booking to write.
 */
describe('BookingsScreen — export', () => {
  it('offers an export once there are bookings', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);
    expect(screen.getByTestId('export-bookings')).not.toBeDisabled();
  });

  it('disables it while there are no bookings to write', () => {
    bookingsState = { isLoading: false, data: { rows: [], hasMore: false } };
    render(<BookingsScreen />);
    expect(screen.getByTestId('export-bookings')).toBeDisabled();
  });
});

/**
 * A booking with no contact used to be a dead end (issue #659): the form invites a blank contact
 * for a slot-only reservation, `contact_id` is ON DELETE SET NULL so deleting a contact clears it
 * from their future bookings, and either way **Check out** failed with "add a contact to the
 * booking" — an instruction the card gave no way to follow. These assert the two ways out.
 */
describe('BookingsScreen — a booking with no contact (issue #659)', () => {
  /** The same booking, but reserved for someone. */
  function withContact(booking: AssetBookingWithNames): AssetBookingWithNames {
    return { ...booking, contactId: 'contact-1', contactName: 'Ada' };
  }

  it('asks who the asset is going out to instead of converting a contactless booking', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-convert-b1'));

    expect(mutations.convert).not.toHaveBeenCalled();
    expect(screen.getByTestId('booking-checkout-contact')).toBeInTheDocument();
  });

  it('converts with the name that was given', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-convert-b1'));
    fireEvent.change(screen.getByTestId('booking-checkout-contact'), { target: { value: ' Grace ' } });
    fireEvent.click(screen.getByTestId('booking-checkout-confirm'));

    expect(mutations.convert).toHaveBeenCalledTimes(1);
    expect(mutations.convert.mock.calls[0]?.[0]).toEqual({
      id: 'b1',
      input: { contactName: 'Grace' },
    });
  });

  it('refuses to convert on an empty name rather than sending a blank one', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-convert-b1'));
    fireEvent.click(screen.getByTestId('booking-checkout-confirm'));

    expect(mutations.convert).not.toHaveBeenCalled();
    expect(screen.getByTestId('booking-checkout-error')).toHaveTextContent(/going out to/i);
  });

  it('still checks a booking that names someone out on a single tap', () => {
    bookingsState = {
      isLoading: false,
      data: { rows: [withContact(makeBooking('b1'))], hasMore: false },
    };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-convert-b1'));

    expect(screen.queryByTestId('booking-checkout-contact')).toBeNull();
    expect(mutations.convert).toHaveBeenCalledTimes(1);
    expect(mutations.convert.mock.calls[0]?.[0]).toEqual({ id: 'b1' });
  });

  it('offers an edit that can name the borrower on the booking itself', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-edit-b1'));
    fireEvent.change(screen.getByTestId('booking-edit-contact'), { target: { value: 'Grace' } });
    fireEvent.click(screen.getByTestId('booking-edit-save'));

    expect(mutations.update).toHaveBeenCalledTimes(1);
    expect(mutations.update.mock.calls[0]?.[0]).toEqual({
      id: 'b1',
      input: { contactName: 'Grace' },
    });
  });

  it('sends only the fields that actually changed', () => {
    bookingsState = {
      isLoading: false,
      data: { rows: [withContact(makeBooking('b1'))], hasMore: false },
    };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-edit-b1'));
    fireEvent.change(screen.getByTestId('booking-edit-note'), { target: { value: 'trade show' } });
    fireEvent.click(screen.getByTestId('booking-edit-save'));

    expect(mutations.update.mock.calls[0]?.[0]).toEqual({ id: 'b1', input: { note: 'trade show' } });
  });

  it('closes an untouched edit without writing anything', () => {
    bookingsState = { isLoading: false, data: { rows: [makeBooking('b1')], hasMore: false } };
    render(<BookingsScreen />);

    fireEvent.click(screen.getByTestId('booking-edit-b1'));
    fireEvent.click(screen.getByTestId('booking-edit-save'));

    expect(mutations.update).not.toHaveBeenCalled();
    expect(screen.queryByTestId('booking-edit-contact')).toBeNull();
  });
});
