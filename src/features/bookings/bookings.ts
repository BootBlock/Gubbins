/**
 * Tier-1 hooks for the asset-booking domain (spec §4 extended; Phase 78).
 *
 * Reads go through TanStack Query; writes are invalidation-based (a booking action is a
 * low-frequency single tap). Creating/cancelling/deleting a booking reshapes the bookings
 * list and the §3 "Upcoming" agenda, so those invalidate the `bookings` + `agenda` keys.
 * A booking→checkout conversion additionally touches the item table (on-hand stock) and the
 * checkout records, so it invalidates the borrowing keys too (mirroring `useCheckoutItem`).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getAssetBookingRepository,
  MS_PER_DAY,
  type BookingCountFilter,
  type ConvertBookingInput,
  type CreateBookingInput,
  type UpdateBookingInput,
} from '@/db/repositories';
import { startOfUtcDay } from '@/lib/calendar-days';
import { nowMs } from '@/lib/clock';
import { agendaKeys } from '@/features/calendar/keys';
import { checkoutKeys, contactKeys } from '@/features/contacts/keys';
import { invalidateItems } from '@/features/inventory/invalidate';

export const bookingKeys = {
  all: ['bookings'] as const,
  list: () => [...bookingKeys.all, 'list'] as const,
  /**
   * One counted scope of the calendar. Nested **under** {@link bookingKeys.list} so every
   * existing `invalidateQueries` against the list (or `all`) refreshes the counts too — no write
   * has to learn that the Dashboard counts bookings.
   */
  count: (scope: BookingCountScope) => [...bookingKeys.list(), 'count', scope] as const,
  bookable: () => [...bookingKeys.all, 'bookable'] as const,
} as const;

/**
 * Which bookings a count takes in (issue #573) — the three questions the Dashboard's Bookings
 * tile can be pointed at.
 *
 * - `all` — every booking on record, cancelled and converted ones included.
 * - `upcoming` — live bookings not yet past their last booked day (what the agenda shows).
 * - `startingThisWeek` — live bookings starting in the next seven days.
 */
export type BookingCountScope = 'all' | 'upcoming' | 'startingThisWeek';

/**
 * The `BookingCountFilter` for `scope`, resolved against the start of today in UTC.
 *
 * @internal Exported for unit tests only.
 */
export function bookingCountFilter(scope: BookingCountScope): BookingCountFilter {
  // Bookings store midnight-UTC day starts (issue #320), so the cut-off is taken in UTC to keep
  // the comparison in one time frame. Read when the query runs, so a refetch re-dates it.
  const startOfToday = startOfUtcDay(nowMs());
  if (scope === 'all') return {};
  if (scope === 'upcoming') return { liveOnly: true, endsOnOrAfter: startOfToday };
  // A UTC day is exactly MS_PER_DAY (no DST), so the far edge stays on a UTC midnight aligned
  // with the stored dates.
  return { liveOnly: true, startsFrom: startOfToday, startsBefore: startOfToday + 7 * MS_PER_DAY };
}

/** Invalidate every view a booking write reshapes (the list + the upcoming agenda). */
function invalidateBookings(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: bookingKeys.all });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
}

// --- reads ---------------------------------------------------------------------

export function useBookings() {
  return useQuery({
    queryKey: bookingKeys.list(),
    queryFn: () => getAssetBookingRepository().list({ limit: 100 }),
  });
}

/**
 * How many bookings fall in `scope` (issue #573) — the Dashboard's Bookings tile.
 *
 * A count query rather than a filter over {@link useBookings}: that read is a single capped page
 * of a list ordered live-first-then-soonest, so a long booking history could push every upcoming
 * booking off the page and the tile then reported there was nothing coming up. Pass
 * `{ enabled: false }` to mount without fetching.
 */
export function useBookingCount(scope: BookingCountScope, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: bookingKeys.count(scope),
    queryFn: () => getAssetBookingRepository().count(bookingCountFilter(scope)),
    enabled: options.enabled ?? true,
  });
}

/**
 * One page of the bookings list, for the export's read-everything walk (issue #132). The screen
 * reads a single capped page (and says so with its truncation notice), so serialising the rows
 * in hand would stop the file at 100 bookings; the export re-reads from the start through
 * `exportEveryPage`. Not a hook — it is called from the export's `build` callback.
 */
export function readBookingsPage(params: { limit: number; offset: number }) {
  return getAssetBookingRepository().list(params);
}

export function useBookableAssets() {
  return useQuery({
    queryKey: bookingKeys.bookable(),
    queryFn: () => getAssetBookingRepository().listBookableAssets({ limit: 100 }),
  });
}

// --- writes --------------------------------------------------------------------

export function useCreateBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBookingInput) => getAssetBookingRepository().create(input),
    onSettled: () => {
      invalidateBookings(client);
      // Booking "for" a name not yet in the dictionary creates that contact (§4 Ergonomics).
      void client.invalidateQueries({ queryKey: contactKeys.all });
    },
  });
}

/**
 * Amend an existing booking — its contact, dates or note (issue #659).
 *
 * Invalidates the contact keys as well as the booking views: naming a borrower who is not yet in
 * the dictionary creates that contact, so the contacts list and its pickers are stale afterwards.
 */
export function useUpdateBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateBookingInput }) =>
      getAssetBookingRepository().update(id, input),
    onSettled: () => {
      invalidateBookings(client);
      void client.invalidateQueries({ queryKey: contactKeys.all });
    },
  });
}

export function useCancelBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getAssetBookingRepository().cancel(id),
    onSettled: () => invalidateBookings(client),
  });
}

export function useDeleteBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getAssetBookingRepository().remove(id),
    onSettled: () => invalidateBookings(client),
  });
}

export function useConvertBooking() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input?: ConvertBookingInput }) =>
      getAssetBookingRepository().convertToCheckout(id, input),
    onSettled: () => {
      invalidateBookings(client);
      // A conversion creates a loan: it decrements on-hand stock and opens a checkout.
      void client.invalidateQueries({ queryKey: checkoutKeys.all });
      void client.invalidateQueries({ queryKey: contactKeys.all });
      invalidateItems(client);
    },
  });
}
