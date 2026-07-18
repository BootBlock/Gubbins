/**
 * Tier-1 hooks for freeform tags (spec §2.1, §4, §5). The dictionary is paginated
 * (it can grow large); a single item's tags and prefix suggestions are bounded.
 * Assigning tags auto-creates unknown ones (low-friction, §4), so writes refresh
 * both the item's tags and the global dictionary.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getTagRepository } from '@/db/repositories';
import { inventoryKeys } from './queries';
import { invalidateItems } from './invalidate';

/**
 * One page of the tag dictionary with live item + location counts (issue #84).
 *
 * Paged **server-side**: the dictionary can outgrow a single read, and the management screen
 * must be able to reach every tag, so the page is fetched by offset rather than sliced out of
 * one capped result (which would silently hide everything past the first page).
 */
export function useTagDictionary(page = 1, pageSize = 100) {
  const offset = Math.max(0, (page - 1) * pageSize);
  return useQuery({
    queryKey: inventoryKeys.tagList(offset, pageSize),
    queryFn: () => getTagRepository().list({ limit: pageSize, offset }),
    // Keep the previous page on screen while the next one loads, so paging doesn't flash
    // the empty/loading state.
    placeholderData: (previous) => previous,
  });
}

/** Total number of tags — the denominator for the Tags screen's pagination (issue #84). */
export function useTagCount() {
  return useQuery({
    queryKey: inventoryKeys.tagCount(),
    queryFn: () => getTagRepository().count(),
  });
}

/**
 * The tag dictionary without usage counts — the tag-entry combobox's "what already exists"
 * list (issue #84). Separate from {@link useTagDictionary} so the picker doesn't pay for the
 * per-tag item/location COUNT subqueries it never displays.
 */
export function useTagNames() {
  return useQuery({
    queryKey: inventoryKeys.tagNames(),
    queryFn: () => getTagRepository().listNames({ limit: 100 }),
  });
}

export function useItemTags(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemTags(itemId ?? ''),
    queryFn: () => getTagRepository().getForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * Tags for a window of on-screen items (issue #84 — the item-card Tags field), grouped into
 * itemId → tag names. Only runs when the Tags field is visible (`enabled`), mirroring the
 * custom-field-values batch, so cards that don't show tags never pay for the fetch.
 */
export function useItemsTags(itemIds: readonly string[], enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.itemsTags(itemIds),
    queryFn: async () => {
      const rows = await getTagRepository().listForItems(itemIds);
      const map = new Map<string, string[]>();
      for (const { itemId, name } of rows) {
        const list = map.get(itemId);
        if (list) list.push(name);
        else map.set(itemId, [name]);
      }
      return map as ReadonlyMap<string, readonly string[]>;
    },
    enabled: enabled && itemIds.length > 0,
  });
}

/** Prefix autocomplete; disabled until the user has typed something. */
export function useTagSuggestions(prefix: string) {
  const term = prefix.trim();
  return useQuery({
    queryKey: [...inventoryKeys.tags(), 'suggest', term] as const,
    queryFn: () => getTagRepository().suggest(term),
    enabled: term.length > 0,
  });
}

export function useSetItemTags(itemId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (names: string[]) => getTagRepository().setForItem(itemId, names),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemTags(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.tags() });
    },
  });
}

/** A tag in the location-filter chip bar: its id and display name. */
export interface LocationFilterTag {
  readonly id: string;
  readonly name: string;
}

/** The indexed location→tags data behind the sidebar tag filter (issue #84). */
export interface LocationTagIndex {
  /** locationId → the set of tag ids on it. */
  readonly byLocation: ReadonlyMap<string, ReadonlySet<string>>;
  /** The distinct tags used on ≥1 location, sorted by name — the filter's chip set. */
  readonly tags: readonly LocationFilterTag[];
}

/**
 * The location→tags index for the sidebar tag filter (issue #84). One bounded read of the whole
 * `location_tags` join, indexed by location (for matching) and reduced to the distinct tag set
 * (for the filter chips).
 */
export function useLocationTagIndex() {
  return useQuery({
    queryKey: inventoryKeys.locationTagIndex(),
    queryFn: async (): Promise<LocationTagIndex> => {
      const edges = await getTagRepository().listLocationTagEdges();
      const byLocation = new Map<string, Set<string>>();
      const tagNames = new Map<string, string>();
      for (const { locationId, tagId, tagName } of edges) {
        tagNames.set(tagId, tagName);
        const set = byLocation.get(locationId);
        if (set) set.add(tagId);
        else byLocation.set(locationId, new Set([tagId]));
      }
      const tags = [...tagNames]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { byLocation, tags };
    },
  });
}

/** A location's assigned tags (issue #84). */
export function useLocationTags(locationId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.locationTags(locationId ?? ''),
    queryFn: () => getTagRepository().getForLocation(locationId!),
    enabled: Boolean(locationId),
  });
}

export function useSetLocationTags(locationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (names: string[]) => getTagRepository().setForLocation(locationId, names),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.locationTags(locationId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.tags() });
      void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
    },
  });
}

/**
 * Dictionary-management mutations (issue #84): rename / delete / merge a tag. Any of these
 * changes what carries the tag, so they invalidate the whole tag + item + location surface.
 */
export function useTagManagement() {
  const client = useQueryClient();
  const invalidateAll = () => {
    void client.invalidateQueries({ queryKey: inventoryKeys.tags() });
    invalidateItems(client);
    void client.invalidateQueries({ queryKey: inventoryKeys.locations() });
  };
  const create = useMutation({
    mutationFn: (name: string) => getTagRepository().create(name),
    onSettled: invalidateAll,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => getTagRepository().rename(id, name),
    onSettled: invalidateAll,
  });
  const remove = useMutation({
    mutationFn: (id: string) => getTagRepository().remove(id),
    onSettled: invalidateAll,
  });
  const merge = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      getTagRepository().merge(sourceId, targetId),
    onSettled: invalidateAll,
  });
  return { create, rename, remove, merge };
}
