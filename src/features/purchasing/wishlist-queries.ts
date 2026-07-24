/**
 * TanStack Query hooks + write mutations for the manual wishlist (feature-gap G8).
 *
 * Every read/write funnels through `WishlistRepository` (never raw SQL in a component). Mutations
 * invalidate the single wishlist list cache so the tab refreshes. The wishlist is a small,
 * self-contained list with no cross-entity effects, so there is nothing else to invalidate.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getWishlistRepository, type CreateWishlistInput, type UpdateWishlistInput } from '@/db/repositories';
import { useReportWriteFailure } from '@/features/errors';

export const wishlistKeys = {
  all: ['wishlist'] as const,
  list: () => [...wishlistKeys.all, 'list'] as const,
};

/** The full wishlist, already ordered for display (priority → name → oldest). */
export function useWishlist() {
  return useQuery({
    queryKey: wishlistKeys.list(),
    queryFn: () => getWishlistRepository().list({ limit: 100 }),
  });
}

export function useCreateWishlistEntry() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.wishlistAdd',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: CreateWishlistInput) => getWishlistRepository().create(input),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}

export function useUpdateWishlistEntry() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.wishlistUpdate',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateWishlistInput }) =>
      getWishlistRepository().update(id, input),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}

export function useDeleteWishlistEntry() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.wishlistRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (id: string) => getWishlistRepository().delete(id),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}
