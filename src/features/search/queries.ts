/**
 * Tier-1 hooks for Visual-Builder (AST) search (spec §2.1, §5.1).
 *
 * Results stream through the same `useInfiniteQuery` + strict offset pagination as
 * the plain item list, so they feed the existing virtualised `ItemList` unchanged.
 * The query is only `enabled` when the caller has confirmed the tree is non-empty
 * and {@link astError} returns null — so an in-progress, invalid edit never reaches
 * the worker (and never logs an error that would fail the §8.5.5 smoke).
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DEFAULT_PAGE_SIZE, MAX_LIST_PAGES, getItemRepository, type ItemSort } from '@/db/repositories';
import type { SearchAST } from '@/db/search/ast';
import { astFiltersLocation, parseASTtoSQL } from '@/db/search/parseASTtoSQL';
import { inventoryKeys } from '@/features/inventory/queries';

/**
 * Validate a tree by attempting translation. Returns a user-facing message when it
 * cannot be parsed (unknown field, non-numeric value, over-deep nesting), else null.
 */
export function astError(ast: SearchAST): string | null {
  try {
    parseASTtoSQL(ast);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid search.';
  }
}

/**
 * Which location a Visual-Builder search actually runs inside (issue #626) — the caller's
 * selected location, or `null` when the search spans the whole inventory.
 *
 * The scope is lifted for a tree that names `location` itself: that condition already says
 * where to look, and AND-ing a *different* location onto it can only return nothing. The
 * repository applies the same rule, so a caller that skips this helper is still safe; the
 * point of having it on the UI side is that the screen can say which scope the results are
 * under without restating the rule and drifting from it.
 */
export function astLocationScope(ast: SearchAST, locationId: string | null): string | null {
  return locationId && !astFiltersLocation(ast) ? locationId : null;
}

/**
 * @param sort - the inventory's ordering axis (issue #128), or `undefined` to keep the AST
 *   search's own relevance ordering (capability "best match" rank, then alphabetical). An
 *   explicit sort **replaces** that ranking — the user asked for a specific order, so it wins
 *   over relevance. Part of the query key, so re-sorting re-runs the search.
 * @param locationId - the location the search is scoped to (issue #626), or `null` to search
 *   the whole inventory. The Inventory sidebar's selection scopes these results exactly as it
 *   scopes the plain list, so the screen's chrome and its rows can't disagree. Also part of the
 *   query key, so changing the selection re-runs the search.
 */
export function useAstSearch(
  ast: SearchAST,
  enabled: boolean,
  sort?: readonly ItemSort[],
  locationId: string | null = null,
  pageSize = DEFAULT_PAGE_SIZE,
) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.astSearch(ast, sort ?? null, locationId),
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getItemRepository().searchByAst(ast, { limit: pageSize, offset: pageParam, sort, locationId }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    // Bound the resident window exactly as the plain list does (spec §2.1) so a
    // long AST result set never accumulates every page's thumbnail BLOBs.
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
    // Keep prior results on screen while a refined AST re-runs, so tweaking the visual
    // builder reconciles rows in place rather than flashing the list to a spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * How many items the AST matches **in total** — not how many pages are currently resident
 * (issue #220). The result list trims its leading pages as the user scrolls, so its row count
 * answers "how far have I scrolled", never "how much matched"; this `COUNT(*)` is the only
 * honest source for the result summary a screen-reader user hears.
 *
 * Order-independent, so it deliberately omits the sort axis from the key — re-sorting must not
 * re-run a count that is certain to return the same number (mirrors `useItemCount`). It does
 * carry `locationId`, though: that scope changes which items match, so the summary would
 * otherwise announce a total the list beneath it contradicts (issue #626).
 */
export function useAstCount(ast: SearchAST, enabled: boolean, locationId: string | null = null) {
  return useQuery({
    queryKey: inventoryKeys.astCount(ast, locationId),
    enabled,
    queryFn: () => getItemRepository().countByAst(ast, { locationId }),
    // Hold the previous count while a refined AST re-counts, so the summary doesn't blink.
    placeholderData: keepPreviousData,
  });
}
