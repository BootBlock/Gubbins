/**
 * Tier-1 read hook for the global activity feed (Phase 80, spec §2.1, §4).
 *
 * The cross-item counterpart to `useItemHistory`: an `useInfiniteQuery` over
 * `ItemRepository.getHistoryFeed`, bounded by `MAX_LIST_PAGES` and absolute-indexed
 * through the Phase-37 `list-window.ts` seam so a deep scroll never retains every page.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DEFAULT_PAGE_SIZE, MAX_LIST_PAGES, getItemRepository, type HistoryAction } from '@/db/repositories';

export const activityKeys = {
  all: ['activity'] as const,
  feed: (actions: readonly HistoryAction[] | undefined) =>
    [...activityKeys.all, 'feed', actions ?? 'all'] as const,
  /** One discrete page of the feed (issue #20 paginated mode). */
  page: (actions: readonly HistoryAction[] | undefined, page: number, pageSize: number) =>
    [...activityKeys.all, 'page', actions ?? 'all', page, pageSize] as const,
  /** Total feed row count for a filter — sizes the page count in paginated mode. */
  count: (actions: readonly HistoryAction[] | undefined) =>
    [...activityKeys.all, 'count', actions ?? 'all'] as const,
};

/**
 * The global activity feed, newest-first. `actions` restricts the feed to a subset of
 * history actions (the kind-filter chips); pass `undefined` for the full feed so the
 * repository skips the `WHERE action IN (…)` clause entirely.
 */
export function useActivityFeed(actions: readonly HistoryAction[] | undefined, enabled = true) {
  return useInfiniteQuery({
    queryKey: activityKeys.feed(actions),
    initialPageParam: 0,
    enabled,
    queryFn: ({ pageParam }) =>
      getItemRepository().getHistoryFeed({
        actions,
        limit: DEFAULT_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
    // Keep the current feed on screen while a changed kind-filter re-queries, so toggling a
    // filter chip reconciles rows in place instead of clearing the list to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * A single discrete page of the global activity feed (issue #20) — the paginated-mode
 * counterpart to the infinite {@link useActivityFeed}. Fetches page `page` (1-based) at
 * `pageSize`; the total that sizes the page count comes from {@link useActivityFeedCount}.
 * `keepPreviousData` holds the current page while the next loads. Gated off in infinite mode.
 */
export function useActivityPage(
  actions: readonly HistoryAction[] | undefined,
  page: number,
  pageSize: number,
  enabled = true,
) {
  return useQuery({
    queryKey: activityKeys.page(actions, page, pageSize),
    queryFn: () =>
      getItemRepository().getHistoryFeed({ actions, limit: pageSize, offset: (page - 1) * pageSize }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Total number of activity-feed rows for the current kind-filter (issue #20) — sizes the page
 * count when the feed is shown paginated. `keepPreviousData` holds the last count while a changed
 * filter re-counts, so the page strip doesn't flicker. Gated off in infinite-scroll mode.
 */
export function useActivityFeedCount(actions: readonly HistoryAction[] | undefined, enabled = true) {
  return useQuery({
    queryKey: activityKeys.count(actions),
    queryFn: () => getItemRepository().countHistoryFeed({ actions }),
    enabled,
    placeholderData: keepPreviousData,
  });
}
