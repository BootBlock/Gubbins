/**
 * Tier-1 read hooks for the inventory domain (spec §2.1).
 *
 * Every database read goes through TanStack Query here, never directly from a
 * component. Item lists use `useInfiniteQuery` with strict offset pagination
 * (LIMIT/OFFSET ≤ 100) so pages feed incrementally into the virtualised list,
 * keeping the worker bridge and the DOM light with 100,000+ records.
 */
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  MAX_LIST_PAGES,
  getItemRepository,
  getLocationRepository,
  getSuggestionRepository,
  getSupplierPartRepository,
  type ItemListFilters,
  type SuggestionField,
} from '@/db/repositories';
import { PRESET_SUGGESTIONS, mergeSuggestions } from './field-suggestions';

/**
 * Stable filter slice used both as a query-key segment and the repository arg.
 *
 * The status-filter tuning fields (`status` / `lowStockThresholds` / `expirySoonWindowDays`)
 * are stable plain data, so they key the cache correctly; the live `now` is deliberately
 * *not* part of this slice — the repository stamps it at query time (see `list`/`count`).
 */
export type ItemQueryFilters = Pick<
  ItemListFilters,
  | 'locationId'
  | 'categoryId'
  | 'tagIds'
  | 'search'
  | 'includeInactive'
  | 'status'
  | 'lowStockThresholds'
  | 'expirySoonWindowDays'
>;

export const inventoryKeys = {
  all: ['inventory'] as const,
  items: () => [...inventoryKeys.all, 'items'] as const,
  itemList: (filters: ItemQueryFilters) => [...inventoryKeys.items(), 'list', filters] as const,
  item: (id: string) => [...inventoryKeys.items(), 'detail', id] as const,
  itemHistory: (id: string) => [...inventoryKeys.item(id), 'history'] as const,
  locations: () => [...inventoryKeys.all, 'locations'] as const,
  locationTree: () => [...inventoryKeys.locations(), 'tree'] as const,
  locationList: () => [...inventoryKeys.locations(), 'list'] as const,
  // Phase 3 — categories, custom fields, tags, images & attachments.
  categories: () => [...inventoryKeys.all, 'categories'] as const,
  categoryList: () => [...inventoryKeys.categories(), 'list'] as const,
  categoryFields: (categoryId: string) => [...inventoryKeys.categories(), 'fields', categoryId] as const,
  /** Every custom-field definition across all categories (the item-card field catalog, E1). */
  allCategoryFields: () => [...inventoryKeys.categories(), 'fields', 'all'] as const,
  itemFields: (itemId: string) => [...inventoryKeys.item(itemId), 'fields'] as const,
  /** Stored custom-field values for a set of on-screen items (item cards, E1). */
  itemFieldValues: (itemIds: readonly string[]) =>
    [...inventoryKeys.items(), 'fieldValues', itemIds] as const,
  tags: () => [...inventoryKeys.all, 'tags'] as const,
  tagList: () => [...inventoryKeys.tags(), 'list'] as const,
  itemTags: (itemId: string) => [...inventoryKeys.item(itemId), 'tags'] as const,
  itemImages: (itemId: string) => [...inventoryKeys.item(itemId), 'images'] as const,
  itemAttachments: (itemId: string) => [...inventoryKeys.item(itemId), 'attachments'] as const,
  // Phase 5 — weighted capabilities & Visual-Builder search.
  itemCapabilities: (itemId: string) => [...inventoryKeys.item(itemId), 'capabilities'] as const,
  search: () => [...inventoryKeys.all, 'search'] as const,
  // Phase 8 — Universal Alias Mapping (§4 external scraping).
  itemAliases: (itemId: string) => [...inventoryKeys.item(itemId), 'aliases'] as const,
  // Phase 60 — N suppliers per item (§4 supplier facet); under item() so an `items()`
  // invalidation refreshes it by prefix.
  itemSupplierParts: (itemId: string) => [...inventoryKeys.item(itemId), 'supplier-parts'] as const,
  // Phase 81 — a supplier part's recorded cost-over-time points; under item() so the
  // existing supplier-part invalidation (which invalidates item()) refreshes it by prefix.
  supplierPartPriceHistory: (itemId: string, supplierPartId: string) =>
    [...inventoryKeys.item(itemId), 'supplier-part-price-history', supplierPartId] as const,
  // Phase 9 — procurement & lifecycle logistics (§4, §4.3, §4.4).
  itemVariants: (parentId: string) => [...inventoryKeys.item(parentId), 'variants'] as const,
  expiring: () => [...inventoryKeys.all, 'expiring'] as const,
  /** Active items running low — the §3 "Low Stock Alerts" dashboard widget (Phase 45). */
  lowStock: () => [...inventoryKeys.all, 'low-stock'] as const,
  inTransit: () => [...inventoryKeys.all, 'in-transit'] as const,
  /** One item's derived incoming In-Transit quantity (Phase 20); under item() so an
   *  `items()` invalidation (fired by procurement mutations) refreshes it by prefix. */
  itemInTransit: (itemId: string) => [...inventoryKeys.item(itemId), 'in-transit'] as const,
  /** One item's per-location stock breakdown (Phase 25); under item() so an
   *  `items()` invalidation (any quantity/move write) refreshes it by prefix. */
  itemStock: (itemId: string) => [...inventoryKeys.item(itemId), 'stock'] as const,
  /** One item's per-location batch/lot breakdown (Phase 28); under item() so an
   *  `items()` invalidation (any quantity/move/receive write) refreshes it by prefix. */
  itemBatches: (itemId: string) => [...inventoryKeys.item(itemId), 'batches'] as const,
  maintenance: () => [...inventoryKeys.all, 'maintenance'] as const,
  itemMaintenance: (itemId: string) => [...inventoryKeys.item(itemId), 'maintenance'] as const,
  maintenanceDue: () => [...inventoryKeys.maintenance(), 'due'] as const,
  // Field auto-completion — distinct existing values for a suggestible free-text field.
  fieldSuggestions: (field: SuggestionField) => [...inventoryKeys.all, 'suggestions', field] as const,
} as const;

/**
 * Type-ahead suggestions for a free-text form field (manufacturer, supplier, gauge unit,
 * currency). The list unions the distinct values already in the catalogue with a seeded set
 * of popular defaults, so it is useful even on an empty database. Suggestions are a
 * shortcut, never a constraint — the caller stays free to type any value.
 */
export function useFieldSuggestions(field: SuggestionField) {
  return useQuery({
    queryKey: inventoryKeys.fieldSuggestions(field),
    queryFn: async () => {
      const existing = await getSuggestionRepository().distinctValues(field);
      return mergeSuggestions(existing, PRESET_SUGGESTIONS[field]);
    },
    // The catalogue's distinct set changes slowly; keep it briefly fresh to avoid a fetch
    // on every dialog open without going stale for a whole session.
    staleTime: 60_000,
  });
}

/** An item's supplier/alternative part aliases (§4 Universal Alias Mapping). */
export function useItemAliases(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemAliases(itemId ?? ''),
    queryFn: () => getItemRepository().listAliases(itemId!),
    enabled: Boolean(itemId),
  });
}

/** An item's supplier parts (§4 supplier facet; Phase 60), preferred-first. */
export function useItemSupplierParts(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemSupplierParts(itemId ?? ''),
    queryFn: () => getSupplierPartRepository().listForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

/** A supplier part's recorded cost-over-time points (Phase 81), newest-first. */
export function useSupplierPartPriceHistory(itemId: string | undefined, supplierPartId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.supplierPartPriceHistory(itemId ?? '', supplierPartId ?? ''),
    queryFn: () => getSupplierPartRepository().listPriceHistory(supplierPartId!),
    enabled: Boolean(itemId) && Boolean(supplierPartId),
  });
}

/** Paginated, virtualisation-ready item list. */
export function useInventoryItems(filters: ItemQueryFilters = {}, pageSize = DEFAULT_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.itemList(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getItemRepository().list({ ...filters, limit: pageSize, offset: pageParam }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    // Bound the resident window so a deep scroll never retains every page's
    // thumbnail BLOBs (spec §2.1). The previous-page param lets a trimmed-off
    // prefix refetch when the user scrolls back up; the virtualised list indexes
    // in absolute space so the refill never shifts the viewport.
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
    // Keep the previous filter's results on screen while the new filter loads, so toggling
    // a filter (e.g. "Show removed") or changing the search never clears the list to a
    // spinner and back. React reconciles the old→new rows by item id, so only genuinely
    // added/removed items animate in/out — no full-list flash. First load (no prior data)
    // still shows the spinner.
    placeholderData: keepPreviousData,
  });
}

/**
 * Item pages for one collapsible **location section** in the grouped inventory view
 * (spec §3 grouping axis). Mirrors {@link useInventoryItems} but deliberately omits
 * `maxPages`: a section renders its loaded pages as plain DOM rather than through the
 * virtualiser, so front-trimming would make earlier items *vanish* as the user pages
 * further down a large location. Every loaded page is retained while the section is
 * expanded; collapsing it unmounts the consumer, so the cache is released on `gcTime`.
 *
 * The `'section'` key suffix keeps this cache distinct from the flat list's cache for the
 * same filters (they configure `maxPages` differently) while staying under the
 * `inventoryKeys.items()` prefix, so item mutations invalidate it just the same.
 */
export function useLocationSectionItems(filters: ItemQueryFilters, pageSize = DEFAULT_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: [...inventoryKeys.itemList(filters), 'section'],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getItemRepository().list({ ...filters, limit: pageSize, offset: pageParam }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
  });
}

/** Live count of items matching a filter (for headers / dashboard widgets). */
export function useItemCount(filters: ItemQueryFilters = {}) {
  return useQuery({
    queryKey: [...inventoryKeys.itemList(filters), 'count'],
    queryFn: () => getItemRepository().count(filters),
    // Hold the previous count while a new filter loads (mirrors the list above) so the
    // header/sidebar total doesn't blink to "Loading…" on a filter toggle.
    placeholderData: keepPreviousData,
  });
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.item(id ?? ''),
    queryFn: () => getItemRepository().getById(id!),
    enabled: Boolean(id),
  });
}

/**
 * One item's Activity Log (§4), paginated newest-first for the detail view. The
 * resident window is bounded exactly like the inventory list (§2.1): a heavily-used
 * consumable can accrue thousands of `GAUGE_UPDATE` rows, so `maxPages` caps retained
 * pages and `getPreviousPageParam` lets a trimmed-off prefix refetch when the user
 * scrolls back up — the absolute-index `list-window.ts` seam keeps the viewport stable.
 */
export function useItemHistory(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.itemHistory(id ?? ''),
    enabled: Boolean(id),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getItemRepository().getHistory(id!, { limit: DEFAULT_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
  });
}

/** The full nested location hierarchy (powers the location sidebar/tree). */
export function useLocationTree() {
  return useQuery({
    queryKey: inventoryKeys.locationTree(),
    queryFn: () => getLocationRepository().getTree(),
  });
}

/** A flat, paginated location list (for pickers / move targets). */
export function useLocations() {
  return useQuery({
    queryKey: inventoryKeys.locationList(),
    queryFn: () => getLocationRepository().list({ limit: 100 }),
  });
}
