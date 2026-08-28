/**
 * Tier-1 read hooks for the supplier dictionary (issue #384).
 *
 * Suppliers are a first-class entity referenced by both `supplier_parts` (inventory) and
 * `purchase_orders` (purchasing), so the hooks live in their own feature rather than under
 * either consumer — the same shape `contacts` uses for the borrower dictionary.
 *
 * Reads go through TanStack Query, never straight from a component (spec §2.1).
 *
 * Two shapes of read live here, because a supplier is looked at two ways (issue #386). The
 * **picker** wants one bounded, browsable page of the whole dictionary; the **management
 * screen** wants a specific page of a specific filter, plus the total that sizes the page
 * strip. Only the latter can reach past the first page — which is what makes every supplier
 * editable, mergeable and deletable however long the list grows.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { getSupplierRepository, MAX_PAGE_SIZE } from '@/db/repositories';
import { supplierNameKey } from '@/lib/supplier-name';

/**
 * How many suppliers a name-search offers at once — the merge dialog's pickers, and anything
 * else choosing one supplier out of the whole dictionary. Generous enough that opening an
 * empty field is a real browse of the list, bounded so a huge dictionary can't build a
 * thousand-row popup.
 */
export const SUPPLIER_SEARCH_LIMIT = 50;

export const supplierKeys = {
  all: ['suppliers'] as const,
  list: () => [...supplierKeys.all, 'list'] as const,
  /** One discrete page of the management screen's (optionally filtered) list. */
  page: (search: string, page: number, pageSize: number) =>
    [...supplierKeys.all, 'page', search, page, pageSize] as const,
  /** How many suppliers match a filter — sizes the page strip. */
  count: (search: string) => [...supplierKeys.all, 'count', search] as const,
  /** A name-search for a picker that must reach the whole dictionary. */
  search: (term: string) => [...supplierKeys.all, 'search', term] as const,
  /** Lookup by folded identity key — "is this name already taken, anywhere?". */
  byName: (nameKey: string) => [...supplierKeys.all, 'byName', nameKey] as const,
  detail: (id: string) => [...supplierKeys.all, 'detail', id] as const,
} as const;

/**
 * The canonical supplier list, name-ordered, that the {@link SupplierPicker} offers.
 *
 * Capped at the strict-pagination maximum (§2.1) — a supplier dictionary is a small
 * hand-curated list, so one page is the whole of it in practice. Kept briefly fresh so
 * re-opening a dialog does not re-read a set that changes only when a supplier is added.
 *
 * A caller that must reach *every* supplier rather than the first page — the management
 * screen, the merge pickers — uses {@link useSupplierPage} or {@link useSupplierSearch}
 * instead; this one reports `hasMore` so a consumer knows when it holds only part of the
 * dictionary and can stop claiming otherwise.
 */
export function useSuppliers() {
  return useQuery({
    queryKey: supplierKeys.list(),
    queryFn: () => getSupplierRepository().list({ limit: MAX_PAGE_SIZE }),
    staleTime: 60_000,
  });
}

/**
 * One discrete page of the supplier dictionary, optionally narrowed to names containing
 * `search` (issue #386). The page is resolved by the database, so paging or searching reaches
 * suppliers that sort past the first page — the ones that were previously unreachable, and so
 * un-editable and un-mergeable. `keepPreviousData` holds the current page on screen while the
 * next one (or a changed filter) loads, so the list reconciles in place instead of blanking.
 */
export function useSupplierPage(search: string, page: number, pageSize: number) {
  return useQuery({
    queryKey: supplierKeys.page(search, page, pageSize),
    queryFn: () => getSupplierRepository().list({ search, limit: pageSize, offset: (page - 1) * pageSize }),
    placeholderData: keepPreviousData,
  });
}

/**
 * How many suppliers match the screen's filter — the total behind the page strip, and behind
 * "showing the first N of M". Held through a filter change by `keepPreviousData` so the strip
 * doesn't flicker between counts.
 */
export function useSupplierCount(search: string) {
  return useQuery({
    queryKey: supplierKeys.count(search),
    queryFn: () => getSupplierRepository().count({ search }),
    placeholderData: keepPreviousData,
  });
}

/**
 * Suppliers whose name contains `term`, for a picker that has to reach the whole dictionary
 * rather than the first page of it (issue #386) — chiefly the merge dialog, where a duplicate
 * pair that both sort late is exactly the case merge exists for.
 *
 * An empty term returns the first {@link SUPPLIER_SEARCH_LIMIT} suppliers by name, so opening
 * the field still browses the list rather than demanding a search before it shows anything.
 */
export function useSupplierSearch(term: string) {
  const search = term.trim();
  return useQuery({
    queryKey: supplierKeys.search(search),
    queryFn: () => getSupplierRepository().list({ search, limit: SUPPLIER_SEARCH_LIMIT }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

/**
 * The supplier a typed name folds onto, looked up across the **whole** table under the
 * canonical name key — the same comparison the database's UNIQUE index makes.
 *
 * This is how a rename collision is caught before it is submitted, and it deliberately does not
 * consult any loaded page: a name can clash with a supplier the screen has never read, and
 * "no clash found" from a partial list would be a claim we cannot back. Keyed on the folded
 * key, so `RS Components` and `rs-components` share one cached answer.
 */
export function useSupplierByName(name: string) {
  const key = supplierNameKey(name);
  return useQuery({
    queryKey: supplierKeys.byName(key),
    queryFn: () => getSupplierRepository().findByName(name),
    enabled: key.length > 0,
    staleTime: 60_000,
  });
}

/** A single supplier by id — for surfaces that hold only the stored `supplier_id`. */
export function useSupplier(id: string | undefined) {
  return useQuery({
    queryKey: supplierKeys.detail(id ?? ''),
    // `getById` answers `undefined` for a record that isn't there, which TanStack Query
    // refuses as query data — it logs "Query data cannot be undefined" and marks the query
    // errored. Deleting the supplier you are looking at refetches this key before the screen
    // drops the selection, so that is a reachable state. `null` says the same thing in a
    // value the cache accepts.
    queryFn: async () => (await getSupplierRepository().getById(id!)) ?? null,
    enabled: Boolean(id),
  });
}
