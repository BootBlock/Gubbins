/**
 * TanStack Query hooks + write mutations for the manual wishlist (feature-gap G8).
 *
 * Every read/write funnels through `WishlistRepository` (never raw SQL in a component). Mutations
 * invalidate the single wishlist list cache so the tab refreshes. The wishlist is a small,
 * self-contained list with no cross-entity effects, so there is nothing else to invalidate.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getWishlistRepository, type CreateWishlistInput, type UpdateWishlistInput } from '@/db/repositories';

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
  return useMutation({
    mutationFn: (input: CreateWishlistInput) => getWishlistRepository().create(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}

export function useUpdateWishlistEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateWishlistInput }) =>
      getWishlistRepository().update(id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}

export function useDeleteWishlistEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getWishlistRepository().delete(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: wishlistKeys.list() });
    },
  });
}
