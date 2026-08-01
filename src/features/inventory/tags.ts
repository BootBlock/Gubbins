/**
 * Tier-1 hooks for freeform tags (spec §2.1, §4, §5). The dictionary is paginated
 * (it can grow large); a single item's tags and prefix suggestions are bounded.
 * Assigning tags auto-creates unknown ones (low-friction, §4), so writes refresh
 * both the item's tags and the global dictionary.
 */
import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getTagRepository } from '@/db/repositories';
import { isUnknownWriteOutcome, useReportWriteFailure, type WriteFailureHeadingKey } from '@/features/errors';
import type { Tag } from '@/db/repositories/types/tags';
import { bucketIds, mergeBucketMaps } from './id-buckets';
import { inventoryKeys, type TagBrowse } from './queries';
import { invalidateItems } from './invalidate';
import { projectTagSet } from './tag-set';

/**
 * One page of the tag dictionary with live item + location counts, optionally narrowed and
 * re-ordered (issues #84, #137).
 *
 * Paged **server-side**: the dictionary can outgrow a single read, and the management screen
 * must be able to reach every tag, so the page is fetched by offset rather than sliced out of
 * one capped result (which would silently hide everything past the first page). The filter is
 * resolved the same way, so it reaches tags that sort past the page on screen rather than
 * narrowing the page in hand. Pair with {@link useTagCount} given the same filter.
 */
export function useTagDictionary(page = 1, pageSize = 100, browse: TagBrowse = {}) {
  const offset = Math.max(0, (page - 1) * pageSize);
  return useQuery({
    queryKey: inventoryKeys.tagList(offset, pageSize, browse),
    queryFn: () => getTagRepository().list({ ...browse, limit: pageSize, offset }),
    // Keep the previous page on screen while the next one loads (or the filter changes), so
    // paging and typing don't flash the empty/loading state.
    placeholderData: (previous) => previous,
  });
}

/**
 * One page of the tag dictionary under a given filter/sort, for the export's read-everything walk
 * (issue #132). The screen holds a single page, so serialising the rows in hand would export that
 * page rather than the dictionary; the export re-reads from the start through `exportEveryPage`.
 *
 * It takes the screen's `browse` (issue #137) so the file matches the list the user is looking at:
 * exporting the whole dictionary from under a filter would hand back rows they had just narrowed
 * away. Not a hook — it is called from the export's `build` callback, outside React's render.
 */
export function readTagDictionaryPage(browse: TagBrowse = {}) {
  return (params: { limit: number; offset: number }) => getTagRepository().list({ ...browse, ...params });
}

/**
 * How many tags match `search` — the denominator for the Tags screen's pagination (issue #84)
 * and the figure the filtered list announces (issue #137). Held through a filter change so the
 * page strip doesn't flicker between counts as the box is typed into.
 */
export function useTagCount(search = '') {
  return useQuery({
    queryKey: inventoryKeys.tagCount(search),
    queryFn: () => getTagRepository().count({ search }),
    placeholderData: (previous) => previous,
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
 *
 * Read one fixed-size id bucket at a time rather than one query for the whole window, so a
 * scrolling list reads each item's tags exactly once instead of re-reading every resident id
 * on every page (issue #169 — see {@link bucketIds}).
 */
export function useItemsTags(itemIds: readonly string[], enabled = true) {
  const buckets = useMemo(() => bucketIds(itemIds), [itemIds]);
  return useQueries({
    queries: buckets.map((bucket) => ({
      queryKey: inventoryKeys.itemsTags(bucket),
      queryFn: async () => {
        const rows = await getTagRepository().listForItems(bucket);
        const map = new Map<string, string[]>();
        for (const { itemId, name } of rows) {
          const list = map.get(itemId);
          if (list) list.push(name);
          else map.set(itemId, [name]);
        }
        return map as ReadonlyMap<string, readonly string[]>;
      },
      enabled,
      // Only the partly-filled tail bucket ever re-keys; hold its last tags in place while
      // it reloads so those cards don't flicker empty.
      placeholderData: (prev: ReadonlyMap<string, readonly string[]> | undefined) => prev,
    })),
    combine: (results) => ({ data: mergeBucketMaps(results.map((r) => r.data)) }),
  });
}

/** Prefix autocomplete; disabled until the user has typed something. */
export function useTagSuggestions(prefix: string) {
  const term = prefix.trim();
  return useQuery({
    queryKey: inventoryKeys.tagSuggest(term),
    queryFn: () => getTagRepository().suggest(term),
    enabled: term.length > 0,
  });
}

/**
 * Shared machinery behind {@link useSetItemTags} / {@link useSetLocationTags} (issue #293).
 *
 * `setFor*` replaces the owner's *whole* tag set, and the editor builds that set from this
 * query's data — so two quick edits must not both build on the same pre-edit snapshot. Adding
 * "fragile" then "heavy" inside the refetch window used to submit `[…, 'heavy']` without
 * "fragile"; removing two chips as quickly used to resurrect the first. Three things close it:
 *
 * - **`onMutate` patches the cache** to the set just submitted, so the next keystroke already
 *   builds on it rather than on the last server read. (An optimistic patch rather than a
 *   pending-guard: the editor stays responsive, which is the point of a freeform tag field.)
 * - **`scope`** serialises the writes for one owner, so two whole-set replaces can never land
 *   out of order and let the older, smaller set win.
 * - **the refetch waits for the last write** — invalidating between queued writes would
 *   briefly serve the database's older set and visibly undo the patch.
 */
function useSetTagsFor({
  scopeId,
  tagsKey,
  headingKey,
  write,
  invalidateExtra,
}: {
  /** Serialises writes for one owner, and identifies this owner's queue for `isMutating`. */
  readonly scopeId: string;
  /** The query holding this owner's assigned tags — the one patched and refetched. */
  readonly tagsKey: readonly unknown[];
  /** The toast heading shown if the optimistic write is rolled back (#389). */
  readonly headingKey: WriteFailureHeadingKey;
  readonly write: (names: string[]) => Promise<void>;
  /** Anything else the owner's tags feed into (a location's tags reach the locations list). */
  readonly invalidateExtra?: (client: QueryClient) => void;
}) {
  const client = useQueryClient();
  // Default fallback copy ("…has been undone"): this write patches optimistically and reverts on
  // error exactly like the item hooks (#307), so the rollback is what the user needs explaining.
  const reportFailure = useReportWriteFailure(headingKey);
  const mutationKey = [scopeId] as const;
  return useMutation({
    mutationKey,
    scope: { id: scopeId },
    mutationFn: write,
    onMutate: async (names: string[]) => {
      // Cancel first, so a read that is already on its way can't land on top of the patch.
      await client.cancelQueries({ queryKey: tagsKey });
      const previous = client.getQueryData<Tag[]>(tagsKey);
      client.setQueryData<Tag[]>(tagsKey, projectTagSet(previous, names));
      return { previous };
    },
    onError: (error, _names, context) => {
      // Only roll back to a snapshot we actually took. With no snapshot (the query had not
      // loaded when the write started) there is nothing to restore, and `onSettled`'s refetch
      // is what clears the patch. A timeout is likewise not restored: it does not establish that
      // the write failed, and reverting would assert a tag set the next read may contradict
      // (issue #554) — the same refetch settles it either way.
      if (context?.previous && !isUnknownWriteOutcome(error)) {
        client.setQueryData(tagsKey, context.previous);
      }
      // The revert used to be the whole story, so a rejected tag edit read as a UI glitch (#389).
      reportFailure(error);
    },
    onSettled: () => {
      // `isMutating` still counts this one, so >1 means another write is queued behind it —
      // let that one do the refetch, once the set on screen is the set in the database.
      if (client.isMutating({ mutationKey }) > 1) return;
      void client.invalidateQueries({ queryKey: tagsKey });
      void client.invalidateQueries({ queryKey: inventoryKeys.tags() });
      invalidateExtra?.(client);
    },
  });
}

export function useSetItemTags(itemId: string) {
  return useSetTagsFor({
    scopeId: `item-tags:${itemId}`,
    tagsKey: inventoryKeys.itemTags(itemId),
    headingKey: 'inventory.writeError.heading.tagsItem',
    write: (names) => getTagRepository().setForItem(itemId, names),
    // Gaining a first tag must un-hide the Tags section for a category that hides it (issue
    // #618); the presence probe is a deeper key than `itemTags`, so no prefix sweep reaches it.
    invalidateExtra: (client) =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(itemId) }),
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
  return useSetTagsFor({
    scopeId: `location-tags:${locationId}`,
    tagsKey: inventoryKeys.locationTags(locationId),
    headingKey: 'inventory.writeError.heading.tagsLocation',
    write: (names) => getTagRepository().setForLocation(locationId, names),
    invalidateExtra: (client) => {
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
  // `create`/`rename` already surface their errors at the call site; `remove`/`merge` were fired
  // with only an `onSuccess`, so their failures were swallowed (#389).
  const reportRemove = useReportWriteFailure('inventory.writeError.heading.tagDelete', 'common.writeFailed');
  const reportMerge = useReportWriteFailure('inventory.writeError.heading.tagMerge', 'common.writeFailed');
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
    onError: reportRemove,
    onSettled: invalidateAll,
  });
  const merge = useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      getTagRepository().merge(sourceId, targetId),
    onError: reportMerge,
    onSettled: invalidateAll,
  });
  return { create, rename, remove, merge };
}
