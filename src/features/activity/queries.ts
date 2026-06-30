/**
 * Tier-1 read hook for the global activity feed (Phase 80, spec §2.1, §4).
 *
 * The cross-item counterpart to `useItemHistory`: an `useInfiniteQuery` over
 * `ItemRepository.getHistoryFeed`, bounded by `MAX_LIST_PAGES` and absolute-indexed
 * through the Phase-37 `list-window.ts` seam so a deep scroll never retains every page.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  MAX_LIST_PAGES,
  getItemRepository,
  type HistoryAction,
} from '@/db/repositories';

export const activityKeys = {
  all: ['activity'] as const,
  feed: (actions: readonly HistoryAction[] | undefined) =>
    [...activityKeys.all, 'feed', actions ?? 'all'] as const,
};

/**
 * The global activity feed, newest-first. `actions` restricts the feed to a subset of
 * history actions (the kind-filter chips); pass `undefined` for the full feed so the
 * repository skips the `WHERE action IN (…)` clause entirely.
 */
export function useActivityFeed(actions: readonly HistoryAction[] | undefined) {
  return useInfiniteQuery({
    queryKey: activityKeys.feed(actions),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getItemRepository().getHistoryFeed({
        actions,
        limit: DEFAULT_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined,
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
  });
}
