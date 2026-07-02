/**
 * Tier-1 hooks for Visual-Builder (AST) search (spec §2.1, §5.1).
 *
 * Results stream through the same `useInfiniteQuery` + strict offset pagination as
 * the plain item list, so they feed the existing virtualised `ItemList` unchanged.
 * The query is only `enabled` when the caller has confirmed the tree is non-empty
 * and {@link astError} returns null — so an in-progress, invalid edit never reaches
 * the worker (and never logs an error that would fail the §8.5.5 smoke).
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { DEFAULT_PAGE_SIZE, MAX_LIST_PAGES, getItemRepository } from '@/db/repositories';
import type { SearchAST } from '@/db/search/ast';
import { parseASTtoSQL } from '@/db/search/parseASTtoSQL';
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

export function useAstSearch(ast: SearchAST, enabled: boolean, pageSize = DEFAULT_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: [...inventoryKeys.search(), 'ast', ast] as const,
    enabled,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getItemRepository().searchByAst(ast, { limit: pageSize, offset: pageParam }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    // Bound the resident window exactly as the plain list does (spec §2.1) so a
    // long AST result set never accumulates every page's thumbnail BLOBs.
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
  });
}

export function useAstSearchCount(ast: SearchAST, enabled: boolean) {
  return useQuery({
    queryKey: [...inventoryKeys.search(), 'ast-count', ast] as const,
    enabled,
    queryFn: () => getItemRepository().countByAst(ast),
  });
}
