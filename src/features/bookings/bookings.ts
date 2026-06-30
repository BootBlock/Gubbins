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
  type ConvertBookingInput,
  type CreateBookingInput,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';

export const bookingKeys = {
  all: ['bookings'] as const,
  list: () => [...bookingKeys.all, 'list'] as const,
  bookable: () => [...bookingKeys.all, 'bookable'] as const,
} as const;

/** Invalidate every view a booking write reshapes (the list + the upcoming agenda). */
function invalidateBookings(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: bookingKeys.all });
  void client.invalidateQueries({ queryKey: ['agenda'] });
}

// --- reads ---------------------------------------------------------------------

export function useBookings() {
  return useQuery({
    queryKey: bookingKeys.list(),
    queryFn: () => getAssetBookingRepository().list({ limit: 100 }),
  });
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
    onSettled: () => invalidateBookings(client),
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
      void client.invalidateQueries({ queryKey: ['checkouts'] });
      void client.invalidateQueries({ queryKey: ['contacts'] });
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}
