/**
 * Tier-1 read hooks for the global activity feed (Phase 80, spec §2.1, §4).
 *
 * The cross-item counterpart to `useItemHistory`: an `useInfiniteQuery` over
 * `ItemRepository.getHistoryFeed`, bounded by `MAX_LIST_PAGES` and absolute-indexed
 * through the Phase-37 `list-window.ts` seam so a deep scroll never retains every page.
 *
 * The **Locations** lane (issue #693) mirrors it hook-for-hook over
 * `LocationRepository.getHistoryFeed`. Its reads are separate rather than interleaved: the two
 * ledgers are separate tables with different row shapes read by separate paged methods, so a
 * genuine chronological merge would have to re-solve offset pagination and the row count across
 * both — deliberately left as a later step.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  MAX_LIST_PAGES,
  getItemRepository,
  getLocationRepository,
  type HistoryAction,
  type LocationHistoryAction,
} from '@/db/repositories';

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

/**
 * One page of the feed under the current kind-filter, for the export's read-everything walk
 * (issue #132). The export cannot serialise what the screen is holding — that is one page in
 * paginated mode and a trimmed window in infinite mode — so it re-reads the feed from the start
 * through `exportEveryPage`, which pairs this with the `readAllPages` ceiling. Not a hook: it is
 * called from the export's `build` callback, outside React's render.
 */
export function readActivityFeedPage(actions: readonly HistoryAction[] | undefined) {
  return (params: { limit: number; offset: number }) =>
    getItemRepository().getHistoryFeed({ actions, ...params });
}

// ---------------------------------------------------------------------------
// Locations lane (issue #693) — the same four reads over `location_history`
// ---------------------------------------------------------------------------

export const locationActivityKeys = {
  all: ['location-activity'] as const,
  feed: (actions: readonly LocationHistoryAction[] | undefined) =>
    [...locationActivityKeys.all, 'feed', actions ?? 'all'] as const,
  page: (actions: readonly LocationHistoryAction[] | undefined, page: number, pageSize: number) =>
    [...locationActivityKeys.all, 'page', actions ?? 'all', page, pageSize] as const,
  count: (actions: readonly LocationHistoryAction[] | undefined) =>
    [...locationActivityKeys.all, 'count', actions ?? 'all'] as const,
};

/**
 * The cross-location activity feed, newest-first (issue #693) — the lane that gives a **deleted**
 * location's record an in-app reader at all. `location_history` rows outlive the location they
 * describe, so this feed is the only screen that can show one; the editor's History tab is opened
 * *from* a location, and a deleted one has no editor left to open.
 *
 * `actions` restricts the feed to a subset of location actions (the lane's filter chips); pass
 * `undefined` for the full feed so the repository skips the `WHERE action IN (…)` clause.
 */
export function useLocationActivityFeed(
  actions: readonly LocationHistoryAction[] | undefined,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: locationActivityKeys.feed(actions),
    initialPageParam: 0,
    enabled,
    queryFn: ({ pageParam }) =>
      getLocationRepository().getHistoryFeed({
        actions,
        limit: DEFAULT_PAGE_SIZE,
        offset: pageParam,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
    placeholderData: keepPreviousData,
  });
}

/**
 * A single discrete page of the location activity feed — the paginated-mode counterpart to
 * {@link useLocationActivityFeed}, sized by {@link useLocationActivityFeedCount}. Gated off in
 * infinite mode, and while the Items lane is showing, so only one lane ever reads.
 */
export function useLocationActivityPage(
  actions: readonly LocationHistoryAction[] | undefined,
  page: number,
  pageSize: number,
  enabled = true,
) {
  return useQuery({
    queryKey: locationActivityKeys.page(actions, page, pageSize),
    queryFn: () =>
      getLocationRepository().getHistoryFeed({ actions, limit: pageSize, offset: (page - 1) * pageSize }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Total number of location activity rows under the current filter — sizes the page count when the
 * lane is shown paginated. `keepPreviousData` holds the last count while a changed filter
 * re-counts, so the page strip doesn't flicker.
 */
export function useLocationActivityFeedCount(
  actions: readonly LocationHistoryAction[] | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: locationActivityKeys.count(actions),
    queryFn: () => getLocationRepository().countHistoryFeed({ actions }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * One page of the location feed under the current filter, for the export's read-everything walk.
 * Same reasoning as {@link readActivityFeedPage}: the screen holds one page or a trimmed window,
 * so the export re-reads from the start through `exportEveryPage`. Not a hook.
 */
export function readLocationActivityFeedPage(actions: readonly LocationHistoryAction[] | undefined) {
  return (params: { limit: number; offset: number }) =>
    getLocationRepository().getHistoryFeed({ actions, ...params });
}
