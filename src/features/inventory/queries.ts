/**
 * Tier-1 read hooks for the inventory domain (spec §2.1).
 *
 * Every database read goes through TanStack Query here, never directly from a
 * component. Item lists use `useInfiniteQuery` with strict offset pagination
 * (LIMIT/OFFSET ≤ 100) so pages feed incrementally into the virtualised list,
 * keeping the worker bridge and the DOM light with 100,000+ records.
 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  DEFAULT_PAGE_SIZE,
  getItemRepository,
  getLocationRepository,
  type ItemListFilters,
} from '@/db/repositories';

/** Stable filter slice used both as a query-key segment and the repository arg. */
export type ItemQueryFilters = Pick<
  ItemListFilters,
  'locationId' | 'categoryId' | 'search' | 'includeInactive'
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
} as const;

/** Paginated, virtualisation-ready item list. */
export function useInventoryItems(filters: ItemQueryFilters = {}, pageSize = DEFAULT_PAGE_SIZE) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.itemList(filters),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getItemRepository().list({ ...filters, limit: pageSize, offset: pageParam }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined,
  });
}

/** Live count of items matching a filter (for headers / dashboard widgets). */
export function useItemCount(filters: ItemQueryFilters = {}) {
  return useQuery({
    queryKey: [...inventoryKeys.itemList(filters), 'count'],
    queryFn: () => getItemRepository().count(filters),
  });
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.item(id ?? ''),
    queryFn: () => getItemRepository().getById(id!),
    enabled: Boolean(id),
  });
}

export function useItemHistory(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: inventoryKeys.itemHistory(id ?? ''),
    enabled: Boolean(id),
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      getItemRepository().getHistory(id!, { limit: DEFAULT_PAGE_SIZE, offset: pageParam }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.offset + lastPage.limit : undefined,
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
