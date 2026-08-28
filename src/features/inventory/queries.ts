/**
 * Tier-1 read hooks for the inventory domain (spec §2.1).
 *
 * Every database read goes through TanStack Query here, never directly from a
 * component. The infinite-scroll item list uses `useInfiniteQuery` with keyset (seek)
 * pagination (issue #172) — each page seeks past the previous page's boundary row rather
 * than by a growing `OFFSET`, so a deep scroll stays constant-cost — while the discrete
 * page read ({@link useItemPage}) keeps `OFFSET` for random page access. Pages (≤ 100 rows)
 * feed incrementally into the virtualised list, keeping the worker bridge and the DOM light
 * with 100,000+ records.
 */
import { useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  ITEM_STATUS_FILTERS,
  MAX_LIST_PAGES,
  STATUS_FILTER_FEATURE,
  getItemRepository,
  isStockDependentStatus,
  getLocationRepository,
  getSuggestionRepository,
  getSupplierPartRepository,
  type ItemListFilters,
  type ItemSeek,
  type ItemSort,
  type ItemStatusCount,
  type ItemStatusFilter,
  type LocationWithCount,
  type LowStockThresholds,
  type Page,
  type SuggestionField,
  type TagListParams,
} from '@/db/repositories';
// Type-only: the AST search's keys live in the factory below with the rest of the inventory
// domain's, but nothing here executes any of the search machinery.
import type { SearchAST } from '@/db/search/ast';
import { useEnabledFeatures } from '@/features/modules/useFeature';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { PRESET_SUGGESTIONS, mergeSuggestions } from './field-suggestions';

/** Stable tuning slice keying the applicable-statuses query (see {@link useApplicableStatuses}). */
type ApplicableStatusTuning = {
  /** The currently-viewed location, so applicability recomputes when the selection changes. */
  readonly locationId: string | null;
  readonly lowStockThresholds: LowStockThresholds;
  readonly expirySoonWindowDays: number;
  /**
   * The feature-enabled statuses actually probed, so turning a module off (which drops its
   * candidate) re-keys the query — the repo then skips that status's `EXISTS`. In canonical
   * order, so the key is stable regardless of how the enabled set was derived.
   */
  readonly candidates: readonly ItemStatusFilter[];
};

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
  | 'sort'
>;

/**
 * How the Tags screen's dictionary list is narrowed and ordered (issue #137) — the filter plus
 * the sort, with the page supplied separately.
 */
export type TagBrowse = Omit<TagListParams, 'limit' | 'offset'>;

export const inventoryKeys = {
  all: ['inventory'] as const,
  items: () => [...inventoryKeys.all, 'items'] as const,
  /**
   * Sibling prefix to {@link inventoryKeys.items} for item-derived reads a **stock-only** write
   * cannot change (issue #166). It is deliberately *outside* `items()` so
   * {@link invalidateItemStock} — the narrow invalidation a quantity stepper or gauge adjust
   * uses — can leave it alone, while the ordinary {@link invalidateItems} still sweeps both.
   */
  itemAttention: () => [...inventoryKeys.all, 'item-attention'] as const,
  itemList: (filters: ItemQueryFilters) => [...inventoryKeys.items(), 'list', filters] as const,
  /** One discrete page of a filtered list (issue #20) — the paginated counterpart to the
   *  infinite list, whose own cache is {@link inventoryKeys.itemList} unsuffixed. */
  itemPage: (filters: ItemQueryFilters, page: number, pageSize: number) =>
    [...inventoryKeys.itemList(filters), 'page', page, pageSize] as const,
  /** One collapsible **location section**'s pages (issue #171). The suffix keeps a section's
   *  cache distinct from the flat list's for the same filters — a section pages independently —
   *  while staying under `items()`, so item mutations invalidate it just the same. */
  itemSection: (filters: ItemQueryFilters) => [...inventoryKeys.itemList(filters), 'section'] as const,
  /** How many items match a filter. Callers strip the sort axis first (issue #128): a count is
   *  order-independent, so re-sorting must not re-run a certain-to-be-equal `COUNT(*)`. */
  itemListCount: (filters: ItemQueryFilters) => [...inventoryKeys.itemList(filters), 'count'] as const,
  /** The items physically in one location, as the cycle-count/audit dialogs read them
   *  (batch lots plus serialised instances) — under `itemList` so a stock write refreshes it. */
  locationCycleCount: (locationId: string) =>
    [...inventoryKeys.itemList({ locationId }), 'cycle-count'] as const,
  /** The **stock-derived** status counts (low/out of stock, and expiring — which a stock write
   *  moves through the lots' own expiry dates) — under items(), so every item mutation including
   *  a bare quantity change invalidates them by prefix. */
  applicableStatuses: (tuning: ApplicableStatusTuning) =>
    [...inventoryKeys.items(), 'applicable-statuses', tuning] as const,
  /** The status counts a stock write cannot move (on order, warranty, on loan, overdue,
   *  maintenance due) — under itemAttention() so a stepper tap does not recompute them. These
   *  carry the correlated per-row subqueries, so they are the costly half. */
  stableStatuses: (tuning: ApplicableStatusTuning) =>
    [...inventoryKeys.itemAttention(), 'stable-statuses', tuning] as const,
  item: (id: string) => [...inventoryKeys.items(), 'detail', id] as const,
  /** Items already carrying a barcode — the Barcode field's duplicate advisory (issue #513). */
  barcodeCarriers: (barcode: string) => [...inventoryKeys.items(), 'barcode', barcode] as const,
  itemHistory: (id: string) => [...inventoryKeys.item(id), 'history'] as const,
  locations: () => [...inventoryKeys.all, 'locations'] as const,
  locationTree: () => [...inventoryKeys.locations(), 'tree'] as const,
  locationList: () => [...inventoryKeys.locations(), 'list'] as const,
  /** One location's activity record (issue #691). Under locations() so every location write —
   *  which is exactly what appends to it — refreshes it by prefix. */
  locationHistory: (id: string) => [...inventoryKeys.locations(), 'history', id] as const,
  /** How many locations exist — the Dashboard's tally, which wants the number and no rows. */
  locationCount: () => [...inventoryKeys.locations(), 'count'] as const,
  // Phase 3 — categories, custom fields, tags, images & attachments.
  categories: () => [...inventoryKeys.all, 'categories'] as const,
  categoryList: () => [...inventoryKeys.categories(), 'list'] as const,
  /** Category ids used by ≥1 active item in a (location-scoped) view — the Category facet
   *  declutter (issue #76). Under items() so any item mutation refreshes it by prefix. */
  categoriesInUse: (locationId: string | null) =>
    [...inventoryKeys.items(), 'categories-in-use', locationId] as const,
  categoryFields: (categoryId: string) => [...inventoryKeys.categories(), 'fields', categoryId] as const,
  /** Every custom-field definition across all categories (the item-card field catalog, E1). */
  allCategoryFields: () => [...inventoryKeys.categories(), 'fields', 'all'] as const,
  itemFields: (itemId: string) => [...inventoryKeys.item(itemId), 'fields'] as const,
  /** The global custom-field dictionary (issue #97) — the definitions a location may set. */
  fieldDefs: () => [...inventoryKeys.categories(), 'field-defs'] as const,
  /** The dictionary definitions nothing references any more — the removable leftovers. */
  unusedFieldDefs: () => [...inventoryKeys.fieldDefs(), 'unused'] as const,
  /** One location's custom-field values, inheritable or not (issue #97). Under locations()
   *  so a location write refreshes it by prefix. */
  locationFields: (locationId: string) => [...inventoryKeys.locations(), locationId, 'fields'] as const,
  /** Every location's field values as one searchable blob each — the sidebar search (#617, N2).
   *  Under locations() so a location write refreshes it by prefix; a *field-value* write names it
   *  explicitly (see `invalidateInheritance`), since that write touches no location row. */
  locationFieldSearchText: () => [...inventoryKeys.locations(), 'field-search-text'] as const,
  /** The prefix every on-card custom-field read shares (one query per resident window, so a
   *  field write invalidates *this* rather than trying to name each window's item ids). */
  itemFieldValuesAll: () => [...inventoryKeys.items(), 'fieldValues'] as const,
  /** Stored custom-field values for a set of on-screen items (item cards, E1), restricted to
   *  the card-field ids being rendered (issue #560) — so the *fields* are part of the identity
   *  of what was fetched, and choosing another field can't be answered from a narrower cache
   *  entry. `fieldIds` is expected sorted (see `useItemFieldValues`), so merely *reordering*
   *  the card fields doesn't re-key the read. */
  itemFieldValues: (itemIds: readonly string[], fieldIds: readonly string[]) =>
    [...inventoryKeys.itemFieldValuesAll(), itemIds, fieldIds] as const,
  tags: () => [...inventoryKeys.all, 'tags'] as const,
  /** One server-side page of the counted dictionary, for one filter and ordering (#84, #137). */
  tagList: (offset: number, limit: number, browse: TagBrowse = {}) =>
    [...inventoryKeys.tags(), 'list', offset, limit, browse] as const,
  /** How many tags match a filter — the pagination denominator (issues #84, #137). */
  tagCount: (search = '') => [...inventoryKeys.tags(), 'count', search] as const,
  /** The dictionary without usage counts — the tag-entry combobox (issue #84). */
  tagNames: () => [...inventoryKeys.tags(), 'names'] as const,
  /** Prefix autocomplete over the dictionary, keyed by the trimmed term (issue #84). */
  tagSuggest: (term: string) => [...inventoryKeys.tags(), 'suggest', term] as const,
  itemTags: (itemId: string) => [...inventoryKeys.item(itemId), 'tags'] as const,
  /** The prefix every on-card Tags read shares — the tag counterpart of `itemFieldValuesAll`
   *  (issue #624). Each resident window keys its read on its own item ids, so a per-item tag
   *  write names this prefix rather than trying to name each window's ids. */
  itemsTagsAll: () => [...inventoryKeys.items(), 'tags-batch'] as const,
  /** Tags for a set of on-screen items in one round-trip (the item-card Tags field, issue #84);
   *  under items() so any *item* write refreshes it by prefix. A *tag* write touches no item row,
   *  so it names `itemsTagsAll()` explicitly (see `useSetItemTags`). */
  itemsTags: (itemIds: readonly string[]) => [...inventoryKeys.itemsTagsAll(), itemIds] as const,
  /** One location's assigned tags (issue #84); under locations() so a tag/location write
   *  refreshes it by prefix. */
  locationTags: (locationId: string) => [...inventoryKeys.locations(), locationId, 'tags'] as const,
  /** The whole location→tags index that powers the sidebar tag filter (issue #84); under
   *  locations() so a tag/location write refreshes it by prefix. */
  locationTagIndex: () => [...inventoryKeys.locations(), 'tag-index'] as const,
  itemImages: (itemId: string) => [...inventoryKeys.item(itemId), 'images'] as const,
  /** One location's photos (issue #81); under locations() so a location write refreshes it. */
  locationPhotos: (locationId: string) => [...inventoryKeys.locations(), locationId, 'photos'] as const,
  /** The regions drawn on one photo (issue #81). */
  photoRegions: (photoId: string) => [...inventoryKeys.locations(), 'photo', photoId, 'regions'] as const,
  /**
   * Which items are placed in one region (issue #81). Addressed by region id alone — the item
   * side of a placement knows the region but not always the photo it was drawn on (issue #392)
   * — so it hangs off the photo-less `photoRegions('')` prefix rather than a specific photo's.
   */
  regionItems: (regionId: string) => [...inventoryKeys.photoRegions(''), 'items', regionId] as const,
  /** Every region an item is placed in, resolved up to its location (issue #81). */
  itemPlacements: (itemId: string) => [...inventoryKeys.item(itemId), 'placements'] as const,
  itemAttachments: (itemId: string) => [...inventoryKeys.item(itemId), 'attachments'] as const,
  // Phase 5 — weighted capabilities & Visual-Builder search.
  itemCapabilities: (itemId: string) => [...inventoryKeys.item(itemId), 'capabilities'] as const,
  /**
   * Every Visual-Builder (AST) search read. A **child of {@link inventoryKeys.items}**, not a
   * sibling (issue #622): the rows it caches *are* item rows, so an item write has to reach them.
   * While it sat outside the prefix, nothing swept it — a ± tap on a result card wrote the new
   * quantity and left the card showing the old one, an edit updated only the dialog above it, and
   * a removed item kept its row. Under `items()` both {@link invalidateItems} and
   * {@link invalidateItemStock} sweep it by prefix, as does any future write that sweeps that
   * prefix, so the mode cannot drift back out of the invalidation.
   */
  search: () => [...inventoryKeys.items(), 'search'] as const,
  /** One Visual-Builder (AST) search's result pages. `sort` is part of the key — an explicit
   *  ordering replaces the search's own relevance ranking, so re-sorting must re-run it
   *  (issue #128) — and so is `locationId`, the sidebar scope the search runs inside
   *  (issue #626): it decides which items match, so changing the selection must re-run it. */
  astSearch: (ast: SearchAST, sort: readonly ItemSort[] | null, locationId: string | null) =>
    [...inventoryKeys.search(), 'ast', ast, locationId, sort] as const,
  /** How many items an AST matches in total (issue #220). Order-independent, so — unlike
   *  {@link inventoryKeys.astSearch} — it deliberately omits the sort axis. It does keep
   *  `locationId`: that scope changes which items match, so dropping it would let the summary
   *  announce a total the list beneath it contradicts (issue #626).
   *
   *  It carries its own `'ast-count'` segment rather than suffixing the results key. Suffixed, the
   *  two families were the *same length* — separable only by inspecting the last segment — and the
   *  write side matches result pages by length and prefix in order to patch them optimistically. A
   *  count caches a bare number, not `InfiniteData`, so it must never be mistaken for a page of
   *  rows (issue #622). */
  astCount: (ast: SearchAST, locationId: string | null) =>
    [...inventoryKeys.search(), 'ast-count', ast, locationId] as const,
  /** The closest `limit` matches for a free-text query, plus the total that matched (issue #629).
   *  Its own `'relevance'` segment keeps it clear of both page families: it caches
   *  `{ rows, total }`, not `InfiniteData`, so the optimistic page patcher must never reach it. */
  relevanceSearch: (search: string, limit: number) =>
    [...inventoryKeys.search(), 'relevance', search, limit] as const,
  // Phase 8 — Universal Alias Mapping (§4 external scraping).
  itemAliases: (itemId: string) => [...inventoryKeys.item(itemId), 'aliases'] as const,
  // Phase 60 — N suppliers per item (§4 supplier facet); under item() so an `items()`
  // invalidation refreshes it by prefix.
  itemSupplierParts: (itemId: string) => [...inventoryKeys.item(itemId), 'supplier-parts'] as const,
  // Issue #37 — supplier parts for a set of on-screen items in one round-trip (the PO line
  // editor's price-break lookup); under items() so any supplier-part write refreshes it by prefix.
  itemsSupplierParts: (itemIds: readonly string[]) =>
    [...inventoryKeys.items(), 'supplier-parts-batch', itemIds] as const,
  // Phase 81 — a supplier part's recorded cost-over-time points; under item() so the
  // existing supplier-part invalidation (which invalidates item()) refreshes it by prefix.
  supplierPartPriceHistory: (itemId: string, supplierPartId: string) =>
    [...inventoryKeys.item(itemId), 'supplier-part-price-history', supplierPartId] as const,
  // Feature-gap G9 — an item's recorded manual-value revaluation points; under item() so a
  // revaluation (which invalidates item()) refreshes the trend + value badge by prefix.
  itemRevaluations: (itemId: string) => [...inventoryKeys.item(itemId), 'revaluations'] as const,
  // Feature-gap G6 — an item's related-items cross-links ("works with"/accessory/spare-for); under
  // item() so an `items()` invalidation refreshes it by prefix.
  itemRelations: (itemId: string) => [...inventoryKeys.item(itemId), 'relations'] as const,
  // Issue #618 — which of an item's sections hold data, so a section its category hides is
  // still shown when it has something in it.
  //
  // Filed under item() so a broad `items()` sweep reaches it, but note that most of the writes
  // which *change* the answer (adding a schedule, a tag, an attachment, a capability, a
  // custom-field value, a placement) invalidate only their own deeper sibling key, which no
  // prefix match reaches. Those hooks therefore invalidate this key explicitly — a section
  // that has just gained its first row must stop being hidden, and a stale `false` here is
  // the one failure this whole feature exists to prevent.
  itemSectionPresence: (itemId: string) => [...inventoryKeys.item(itemId), 'section-presence'] as const,
  // Issue #70 — full rows for a set of items in one round-trip (the checkout prerequisite panel);
  // under items() so any item write refreshes it by prefix.
  itemsById: (itemIds: readonly string[]) => [...inventoryKeys.items(), 'by-id-batch', itemIds] as const,
  // Issue #70 — relations for a set of on-screen items in one round-trip (the BOM dependency
  // check); under items() so any relation write refreshes it by prefix.
  itemsRelations: (itemIds: readonly string[]) =>
    [...inventoryKeys.items(), 'relations-batch', itemIds] as const,
  // Issue #653 — how much of a set of items is free versus claimed by open projects, in one
  // round-trip (the BOM table's over-commitment flags, the item dialog's Reservations section).
  // Under items() so any stock write — which is exactly what changes the answer — refreshes it
  // by prefix, and so a reservation write's `invalidateItems` sweep reaches it too.
  itemsAvailability: (itemIds: readonly string[]) =>
    [...inventoryKeys.items(), 'availability-batch', itemIds] as const,
  // Issue #608 — the tracking mode of a set of on-screen items in one round-trip, so a screen can
  // say whether an action on each will actually move stock. Under items() so an item edit that
  // converts Bulk ↔ Untracked refreshes it by prefix.
  itemsTrackingModes: (itemIds: readonly string[]) =>
    [...inventoryKeys.items(), 'tracking-modes-batch', itemIds] as const,
  // Feature-gap G7 — an item's test/calibration/service records; under item() so an `items()`
  // invalidation refreshes it by prefix.
  itemTestRecords: (itemId: string) => [...inventoryKeys.item(itemId), 'test-records'] as const,
  // Phase 9 — procurement & lifecycle logistics (§4, §4.3, §4.4).
  itemVariants: (parentId: string) => [...inventoryKeys.item(parentId), 'variants'] as const,
  /** One kit item's component definition (Kits v1); under item() so an `items()`
   *  invalidation (a component's stock changing) refreshes its buildable count by prefix. */
  itemKit: (kitId: string) => [...inventoryKeys.item(kitId), 'kit'] as const,
  /** A kit's nested-kit roll-up availability (Kits v3) — under {@link inventoryKeys.itemKit}
   *  so an assemble/disassemble or a component edit refreshes it by prefix. */
  itemKitRollup: (kitId: string) => [...inventoryKeys.itemKit(kitId), 'rollup'] as const,
  expiring: () => [...inventoryKeys.all, 'expiring'] as const,
  /** Items expiring inside one lookahead window (§3 "Expiring Soon"). */
  expiringWithin: (withinDays: number) => [...inventoryKeys.expiring(), withinDays] as const,
  /** Active items running low — the §3 "Low Stock Alerts" dashboard widget (Phase 45). */
  lowStock: () => [...inventoryKeys.all, 'low-stock'] as const,
  /** Low-stock items for one set of thresholds; `null` means the repository defaults. Keyed on
   *  them so a caller that overrides the defaults gets its own cache entry. */
  lowStockFor: (thresholds: LowStockThresholds | null) => [...inventoryKeys.lowStock(), thresholds] as const,
  /** Items whose warranty is expiring — the §3 alerts feed. */
  warrantyExpiring: () => [...inventoryKeys.all, 'warranty-expiring'] as const,
  /**
   * Opted-in custom-field due dates — the alert centre's `field-due` lane (W1a). The prefix,
   * so every write that can move one (an item's field value, a location's inheritable value,
   * a definition's opt-in) can sweep them all without naming a window.
   */
  fieldDueDates: () => [...inventoryKeys.all, 'field-due-dates'] as const,
  /** The due-date feed under one shared horizon; omitted = each definition's own lead time. */
  fieldDueDatesWithin: (withinDays: number | null) => [...inventoryKeys.fieldDueDates(), withinDays] as const,
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

/**
 * Supplier parts for a whole set of items in a single round-trip (issue #37) — the Purchase-Order
 * line editor reads its pickable items' supplier pricing once (to apply quantity price-breaks)
 * rather than N+1 times. The item ids are sorted into the cache key so a re-ordered but otherwise
 * identical set hits the same entry. Resolves to a `Map` keyed by item id (a key is absent when the
 * item has no supplier parts); disabled for an empty set.
 */
export function useSupplierPartsForItems(itemIds: readonly string[]) {
  const sortedIds = [...itemIds].sort();
  return useQuery({
    queryKey: inventoryKeys.itemsSupplierParts(sortedIds),
    queryFn: () => getSupplierPartRepository().listForItems(sortedIds),
    enabled: sortedIds.length > 0,
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

/** An item's recorded manual-value revaluation points (feature-gap G9), newest-first. */
export function useItemRevaluations(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemRevaluations(itemId ?? ''),
    queryFn: () => getItemRepository().listRevaluations(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * Which of an item's sections actually hold data (issue #618).
 *
 * Only asked when the item's category hides at least one capability — `enabled` is what keeps
 * the overwhelmingly common "hides nothing" case free, so an inventory that never hides a
 * capability never runs this query at all.
 */
export function useItemSectionPresence(itemId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: inventoryKeys.itemSectionPresence(itemId ?? ''),
    queryFn: () => getItemRepository().getSectionPresence(itemId!),
    enabled: Boolean(itemId) && enabled,
  });
}

/** An item's related-items cross-links (feature-gap G6), each resolved to the other item. */
export function useItemRelations(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemRelations(itemId ?? ''),
    queryFn: () => getItemRepository().listRelations(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * Full item rows for a set of ids in one round-trip (issue #70), keyed by id — the checkout dialog
 * reads the prerequisites of an outgoing loan to show their stock. Ids are sorted into the cache
 * key so a re-ordered but identical set hits the same entry; disabled for an empty set.
 */
export function useItemsById(itemIds: readonly string[]) {
  const sortedIds = [...itemIds].sort();
  return useQuery({
    queryKey: inventoryKeys.itemsById(sortedIds),
    queryFn: () => getItemRepository().getManyById(sortedIds),
    enabled: sortedIds.length > 0,
  });
}

/**
 * The tracking mode of a whole set of items in one round-trip (issue #608) — the BOM table asks
 * it of every in-transit line at once so each receive control can say whether it will move stock.
 * Reads only the enum, never the item rows, so a table never pays for thumbnails it does not
 * render. The ids are sorted into the cache key so a re-ordered but otherwise identical set hits
 * the same entry. Resolves to a `Map` keyed by item id (a key is absent when the id matches no
 * item); disabled for an empty set.
 */
export function useItemsTrackingModes(itemIds: readonly string[]) {
  const sortedIds = [...itemIds].sort();
  return useQuery({
    queryKey: inventoryKeys.itemsTrackingModes(sortedIds),
    queryFn: () => getItemRepository().getTrackingModes(sortedIds),
    enabled: sortedIds.length > 0,
  });
}

/**
 * Relations for a whole set of items in a single round-trip (issue #70) — the project BOM checks
 * every line's hard dependencies at once rather than N+1 times. The item ids are sorted into the
 * cache key so a re-ordered but otherwise identical set hits the same entry. Resolves to a `Map`
 * keyed by item id (a key is absent when the item has no relations); disabled for an empty set.
 */
export function useItemsRelations(itemIds: readonly string[]) {
  const sortedIds = [...itemIds].sort();
  return useQuery({
    queryKey: inventoryKeys.itemsRelations(sortedIds),
    queryFn: () => getItemRepository().listRelationsForItems(sortedIds),
    enabled: sortedIds.length > 0,
  });
}

/**
 * How much of each item is free, and which open projects hold the rest (issue #653) — one
 * round-trip for a whole screen's worth of items rather than N+1. The ids are sorted into the
 * cache key so a re-ordered but otherwise identical set hits the same entry. Resolves to a `Map`
 * keyed by item id (a key is absent when the id matches no item); disabled for an empty set.
 */
export function useItemsAvailability(itemIds: readonly string[]) {
  const sortedIds = [...itemIds].sort();
  return useQuery({
    queryKey: inventoryKeys.itemsAvailability(sortedIds),
    queryFn: () => getItemRepository().getAvailability(sortedIds),
    enabled: sortedIds.length > 0,
  });
}

/**
 * One item's availability (issue #653). Shares {@link useItemsAvailability}'s cache entry shape
 * rather than adding a second key for the singular case, so an item shown in both the BOM table
 * and its own dialog is not read twice.
 */
export function useItemAvailability(itemId: string | undefined) {
  const query = useItemsAvailability(itemId === undefined ? [] : [itemId]);
  return { ...query, data: itemId === undefined ? undefined : query.data?.get(itemId) };
}

/** An item's test / calibration / service records (feature-gap G7), newest-first. */
export function useItemTestRecords(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemTestRecords(itemId ?? ''),
    queryFn: () => getItemRepository().listTestRecords(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * The infinite-scroll page cursor (issue #172): `null` is the first page (no seek, absolute index
 * 0); every later page carries a keyset cursor from {@link ItemSeek}. Never returned from
 * `getNextPageParam`/`getPreviousPageParam` as `null` (those return `undefined` to stop), so it
 * never collides with the "no more pages" signal.
 */
type ItemListPageParam = ItemSeek | null;

/**
 * Paginated, virtualisation-ready item list. `enabled` gates the query off (default on) so the
 * inventory screen can suspend it while the list is shown in discrete-pagination mode (issue #20)
 * — the {@link useItemPage} read drives the list then, and running both would be wasted work.
 *
 * Pages are fetched by **keyset (seek) pagination** (issue #172): each page seeks strictly past the
 * previous page's boundary row rather than by a growing `OFFSET`, so scrolling to page 1000 of a
 * 100k list costs no more than page 1 (SQLite no longer produces and discards every skipped row).
 * The discrete-pagination path ({@link useItemPage}) keeps its `OFFSET` — it needs random access.
 */
export function useInventoryItems(
  filters: ItemQueryFilters = {},
  pageSize = DEFAULT_PAGE_SIZE,
  enabled = true,
) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.itemList(filters),
    initialPageParam: null as ItemListPageParam,
    enabled,
    queryFn: ({ pageParam }) =>
      getItemRepository().list({ ...filters, limit: pageSize, ...(pageParam ? { seek: pageParam } : {}) }),
    // Seek strictly after the last row's sort key. `startIndex` is the running absolute index the
    // virtualised list positions the page at (it replaces the SQL OFFSET, not the seek), computed
    // by advancing from the previous page's offset by the rows it returned.
    getNextPageParam: (lastPage): ItemListPageParam | undefined =>
      lastPage.hasMore && lastPage.endCursor
        ? {
            cursor: lastPage.endCursor,
            direction: 'forward',
            startIndex: lastPage.offset + lastPage.rows.length,
          }
        : undefined,
    // Bound the resident window so a deep scroll never retains every page's thumbnail BLOBs
    // (spec §2.1). The previous-page param lets a trimmed-off prefix refetch when the user scrolls
    // back up; the virtualised list indexes in absolute space so the refill never shifts the
    // viewport. It seeks *before* the first resident row, so it too is constant-cost at any depth.
    getPreviousPageParam: (firstPage): ItemListPageParam | undefined =>
      firstPage.offset > 0 && firstPage.startCursor
        ? {
            cursor: firstPage.startCursor,
            direction: 'backward',
            startIndex: Math.max(0, firstPage.offset - firstPage.limit),
          }
        : undefined,
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
 * A single page of the item list (issue #20) — the discrete-pagination counterpart to the
 * infinite-scroll {@link useInventoryItems}. Fetches exactly page `page` (1-based) at `pageSize`
 * via one `LIMIT/OFFSET` read; the total that sizes the page count comes from the existing
 * {@link useItemCount}. `keepPreviousData` holds the current page on screen while the next loads,
 * so stepping between pages never blinks the list to a spinner. Gated off (`enabled: false`) while
 * the list is in infinite-scroll mode, so the two read paths never both run.
 */
export function useItemPage(filters: ItemQueryFilters, page: number, pageSize: number, enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.itemPage(filters, page, pageSize),
    queryFn: () => getItemRepository().list({ ...filters, limit: pageSize, offset: (page - 1) * pageSize }),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/**
 * Item pages for one collapsible **location section** in the grouped inventory view
 * (spec §3 grouping axis). Mirrors {@link useInventoryItems}, including the bounded
 * resident window: a section that has paged past its first page renders through the
 * virtualiser in absolute index space, so trimming a page off the front neither moves
 * the rows on screen nor loses the user's place — the trimmed prefix refetches via
 * `getPreviousPageParam` when they scroll back up. Without the cap, paging to the bottom
 * of a location holding tens of thousands of items retained every page's thumbnail BLOBs
 * for as long as the section stayed open (issue #171).
 *
 * The `'section'` key suffix keeps this cache distinct from the flat list's cache for the
 * same filters (a section pages independently of the flat list) while staying under the
 * `inventoryKeys.items()` prefix, so item mutations invalidate it just the same.
 */
export function useLocationSectionItems(filters: ItemQueryFilters, pageSize = DEFAULT_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.itemSection(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) => getItemRepository().list({ ...filters, limit: pageSize, offset: pageParam }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    getPreviousPageParam: (firstPage) =>
      firstPage.offset > 0 ? Math.max(0, firstPage.offset - firstPage.limit) : undefined,
    maxPages: MAX_LIST_PAGES,
  });
}

/**
 * The closest `limit` items for a free-text query, best match first, with the size of the whole
 * match set beside them (issue #629).
 *
 * The read a **fixed-size picker** wants, as opposed to {@link useInventoryItems}, which a
 * scrollable list wants: it ranks by FTS5 relevance across every match rather than returning the
 * alphabetically-first page of them, so the closest hit is in the returned rows however many
 * matched. `total` is what lets the picker say how many it is not showing instead of presenting a
 * capped read as the whole set.
 *
 * `enabled` gates it off (default on) for an empty query or a session that may not read items.
 */
export function useItemRelevanceSearch(search: string, limit: number, enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.relevanceSearch(search, limit),
    queryFn: () => getItemRepository().searchByRelevance(search, { limit }),
    enabled: enabled && search.trim().length > 0,
    // Hold the previous query's matches on screen while the next loads, so each keystroke
    // refines the list rather than blanking it to a spinner and back.
    placeholderData: keepPreviousData,
  });
}

/**
 * Live count of items matching a filter (for headers / dashboard widgets, and the page count in
 * paginated mode — issue #20). `enabled` gates it off (default on) so a caller that only needs the
 * count while paginating doesn't run it in infinite-scroll mode.
 */
export function useItemCount(filters: ItemQueryFilters = {}, enabled = true) {
  // A count is order-independent, so the sort axis (issue #128) is stripped from both the key
  // and the argument — otherwise re-sorting the list would re-run a `COUNT(*)` that is certain
  // to return the same number, which is real work at 100k+ scale.
  const { sort: _sort, ...counted } = filters;
  return useQuery({
    queryKey: inventoryKeys.itemListCount(counted),
    queryFn: () => getItemRepository().count(counted),
    enabled,
    // Hold the previous count while a new filter loads (mirrors the list above) so the
    // header/sidebar total doesn't blink to "Loading…" on a filter toggle.
    placeholderData: keepPreviousData,
  });
}

/** Shared empty result for a gated-off half, so the merge memo sees a stable reference. */
const EMPTY_STATUS_COUNTS: readonly ItemStatusCount[] = [];

/**
 * How many items match each status filter **in the currently-viewed location** — the filter
 * bar uses this both to hide a chip that would return nothing (spec §3 filter axis) and to
 * show its match count in the label. Judged against the same user-tuned low-stock / expiry
 * thresholds the filters themselves use, so the counts agree with what a chip would actually
 * return. Re-runs when the location selection changes (it keys the query); a slightly stale
 * count is only cosmetic.
 *
 * **Split across two caches by what can invalidate them (issue #166).** The counts used to sit
 * under one key beneath `items()`, so *every* item mutation recomputed all of them — a single
 * tap of a card's quantity stepper re-probed all eight statuses, and the ones a stock write
 * cannot possibly move are the expensive ones (each carries a correlated per-row subquery
 * against purchase-order lines, checkouts or maintenance schedules). They are therefore keyed
 * separately: the {@link STOCK_DEPENDENT_STATUSES} stay under `items()` and recompute on
 * any write, while the rest live under `itemAttention()`, which {@link invalidateItemStock}
 * deliberately leaves alone. The two result sets are merged back into one list here, so callers
 * see the same shape as before.
 *
 * Only statuses whose Modular-UI capability is enabled are probed (via
 * {@link STATUS_FILTER_FEATURE}) — the filter bar hides a gated-off chip anyway, so its
 * (sometimes heavy) count is never computed. The candidate set keys the query, so toggling
 * a module recomputes it. A half with no enabled candidates is gated off entirely rather than
 * issuing a query that could only return nothing.
 *
 * @param locationId - the selected location, or null/undefined for the "All items" view.
 * @param active - gate the query off (default `true`). When the Visual Builder is driving the
 *   results the status chips are superseded and disabled, so their per-location count
 *   round-trip is wasted work; callers pass `!astActive` to skip it. `keepPreviousData`
 *   keeps the last-known counts on screen while gated off (harmless — the chips are disabled).
 */
export function useApplicableStatuses(locationId?: string | null, active = true) {
  const qtyThreshold = usePreferencesStore((s) => s.lowStockQtyThreshold);
  const gaugePercent = usePreferencesStore((s) => s.lowStockGaugePercent);
  const expirySoonWindowDays = usePreferencesStore((s) => s.expirySoonWindowDays);
  // Only probe statuses whose module is on — the filter bar hides the rest, so computing
  // their (sometimes heavy) EXISTS would be wasted work. Core stock statuses (no entry in
  // STATUS_FILTER_FEATURE) are always in. Kept in canonical order so the query key is stable.
  const enabled = useEnabledFeatures();
  const candidates = useMemo(
    () =>
      ITEM_STATUS_FILTERS.filter((status) => {
        const feature = STATUS_FILTER_FEATURE[status];
        return feature == null || enabled.has(feature);
      }),
    [enabled],
  );
  const stockCandidates = useMemo(() => candidates.filter(isStockDependentStatus), [candidates]);
  const stableCandidates = useMemo(() => candidates.filter((s) => !isStockDependentStatus(s)), [candidates]);

  const base = {
    locationId: locationId ?? null,
    lowStockThresholds: { qtyThreshold, gaugePercent },
    expirySoonWindowDays,
  };
  const stockTuning: ApplicableStatusTuning = { ...base, candidates: stockCandidates };
  const stableTuning: ApplicableStatusTuning = { ...base, candidates: stableCandidates };

  const stock = useQuery({
    queryKey: inventoryKeys.applicableStatuses(stockTuning),
    queryFn: (): Promise<ItemStatusCount[]> => getItemRepository().applicableStatuses(stockTuning),
    // Skip the round-trip entirely while the Visual Builder supersedes the (now disabled) chips.
    enabled: active && stockCandidates.length > 0,
    // Keep the previous set on screen while a refresh runs, so chips don't flicker out and back.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const stable = useQuery({
    queryKey: inventoryKeys.stableStatuses(stableTuning),
    queryFn: (): Promise<ItemStatusCount[]> => getItemRepository().applicableStatuses(stableTuning),
    enabled: active && stableCandidates.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  // A gated-off half has no data and never will, so it contributes an empty list rather than
  // holding the merged result at `undefined` — otherwise disabling every non-stock module (or
  // the Visual-Builder gate) would leave the chips permanently "unknown".
  const stockRows = stockCandidates.length === 0 ? EMPTY_STATUS_COUNTS : stock.data;
  const stableRows = stableCandidates.length === 0 ? EMPTY_STATUS_COUNTS : stable.data;

  // Merge only once *both* halves are known. Emitting a partial set would make a chip
  // momentarily vanish from the bar on first load, which is exactly the flicker the
  // `placeholderData` above exists to prevent. Re-sorted into canonical order so the merged
  // list matches what a single un-split query returned.
  const data = useMemo(() => {
    if (!stockRows || !stableRows) return undefined;
    const byStatus = new Map([...stockRows, ...stableRows].map((row) => [row.status, row]));
    return ITEM_STATUS_FILTERS.map((status) => byStatus.get(status)).filter(
      (row): row is ItemStatusCount => row !== undefined,
    );
  }, [stockRows, stableRows]);

  return { data };
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.item(id ?? ''),
    queryFn: () => getItemRepository().getById(id!),
    enabled: Boolean(id),
  });
}

/**
 * The active items already carrying a barcode (issue #513) — what the Barcode field's duplicate
 * advisory is judged from, and the read that lets the field say "another item has this" *before*
 * a scan of it turns into a question.
 *
 * A blank value disables the query rather than asking for every item with no barcode. The caller
 * decides *when* to ask: the field passes `''` mid-keystroke, so a half-typed GTIN never costs a
 * round-trip and the advisory appears at the same moment the check-digit one does.
 */
export function useBarcodeCarriers(barcode: string) {
  const value = barcode.trim();
  return useQuery({
    queryKey: inventoryKeys.barcodeCarriers(value),
    queryFn: () => getItemRepository().findByBarcode(value),
    enabled: value.length > 0,
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

/**
 * One page of an item's Activity Log, for the export's read-everything walk (issue #620).
 *
 * The export cannot serialise what the log is holding on screen — that is a trimmed
 * virtual window over a heavily-used item's ledger — so it re-reads from the start through
 * `exportEveryPage`, which pairs this with the `readAllPages` ceiling. Not a hook: it is
 * called from the export's `build` callback, outside React's render.
 */
export function readItemHistoryPage(id: string) {
  return (params: { limit: number; offset: number }) => getItemRepository().getHistory(id, params);
}

/**
 * One location's activity record, newest first (issue #691) — the editor's History tab.
 *
 * Paged like the item Activity Log rather than read whole: the record grows every time the
 * location is renamed, moved or archived, and a capped read presented as the whole set would be a
 * lie about an audit trail.
 */
export function useLocationHistory(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.locationHistory(id ?? ''),
    enabled: Boolean(id),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getLocationRepository().getHistory(id!, { limit: DEFAULT_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined),
    // Deliberately **no** `maxPages` window, unlike the item Activity Log. That log is a
    // virtualised, absolute-indexed list that can refetch a trimmed prefix as the user scrolls
    // back up; this is a plain list behind a "Load more" button, so trimming the front would make
    // entries the user is looking at disappear with no way to bring them back.
  });
}

/**
 * The full nested location hierarchy (powers the location sidebar/tree).
 *
 * Asks for the volume totals (issue #457) because each tree row renders a cube-utilisation fill
 * bar from them. That aggregate is opt-in precisely because it costs O(stock) — see
 * `LocationRepository.list` — so it is requested here and nowhere it isn't drawn.
 */
export function useLocationTree() {
  return useQuery({
    queryKey: inventoryKeys.locationTree(),
    queryFn: () => getLocationRepository().getTree({ withVolume: true }),
  });
}

/**
 * The flat location list (pickers, move targets, ancestry maths, the sidebar's filters).
 *
 * Deliberately **unpaginated** — see `LocationRepository.listAll`. This was capped at 100, which
 * silently gave wrong answers rather than short ones once someone had more locations than that: a
 * picker omitted them, an ancestry breadcrumb stopped early, and a sidebar search for one of them
 * found nothing. The location hierarchy is bounded physical structure, so it is read whole, exactly
 * like the tree it mirrors.
 *
 * The `Page` shape is kept (`.rows`) so every existing caller reads it unchanged.
 *
 * Deliberately **without** the volume totals (issue #525). Every caller here wants names,
 * parents and counts — pickers, move targets, ancestry maths, filters — and the totals cost a
 * walk of the `item_stock` ledger. The one row that does draw a fullness bar (the selected
 * location's summary card) is read from {@link useLocationTree} instead, which computes them
 * once for the screen.
 */
export function useLocations() {
  return useQuery({
    queryKey: inventoryKeys.locationList(),
    queryFn: async (): Promise<Page<LocationWithCount>> => {
      const rows = await getLocationRepository().listAll();
      return { rows, limit: rows.length, offset: 0, hasMore: false };
    },
  });
}

/**
 * How many locations exist — for a caller that wants the tally and not the rows (the Dashboard's
 * totals widget). Its own read rather than `useLocations().data.rows.length`: that materialises
 * every location row to discard all but its length (issue #525).
 */
export function useLocationCount() {
  return useQuery({
    queryKey: inventoryKeys.locationCount(),
    queryFn: () => getLocationRepository().count(),
  });
}

/**
 * One page of the location list, for the export's read-everything walk (issue #617, `N7`).
 *
 * Deliberately the paged `LocationRepository.list` rather than the `listAll` the sidebar
 * itself reads: the sidebar's copy is filtered before it is rendered — archived branches hidden,
 * a tag chip or a search narrowing the tree — and an export that serialised it would quietly
 * produce whatever the user happened to be looking at. Re-reading from the start through
 * `exportEveryPage` gives the whole list, and pairs it with the `readAllPages` ceiling so a set
 * that somehow outgrew it reports itself as short rather than pretending to be complete. Not a
 * hook: it is called from the export's `build` callback, outside React's render.
 */
export function readLocationsPage(params: { limit: number; offset: number }) {
  return getLocationRepository().list(params);
}
