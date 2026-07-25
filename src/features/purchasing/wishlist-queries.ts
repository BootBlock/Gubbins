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
import { readAllPages } from '@/lib/read-all-pages';

export const wishlistKeys = {
  all: ['wishlist'] as const,
  list: () => [...wishlistKeys.all, 'list'] as const,
};

/**
 * The **whole** wishlist, already ordered for display (priority → name → oldest) — issue #149.
 *
 * Genuinely all of it, not the first hundred. The tab totals what it holds ("12 items · est.
 * £340"), so a capped read didn't just hide the tail of a hand-typed list — it understated the
 * estimate above it. The list is hand-curated, so reading it whole is cheap; the tab pages it
 * client-side for browsing and reports the {@link readAllPages} ceiling if one ever hits it.
 */
export function useWishlist() {
  return useQuery({
    queryKey: wishlistKeys.list(),
    queryFn: () => readAllPages((params) => getWishlistRepository().list(params)),
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
