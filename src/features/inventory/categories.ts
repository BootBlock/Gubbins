/**
 * Tier-1 hooks for categories, their custom-field definitions, and per-item field
 * values (spec §2.1, §4). Categories form a bounded set (not the 100k+ item list),
 * so these reads fetch the whole set rather than paginating into a virtualised view;
 * the strict-pagination mandate (§2.1) targets the item lists. Writes use targeted
 * invalidation — schema edits are low-frequency and reshape derived counts.
 */
import { useMemo } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  getCategoryRepository,
  getItemRepository,
  type CardFieldStoredValue,
  type CategoryWithFieldCount,
  type CreateCategoryFieldInput,
  type CreateCategoryInput,
  type Page,
  type SetLocationFieldValueInput,
  type UpdateCategoryFieldInput,
  type UpdateCategoryInput,
} from '@/db/repositories';
import { useReportWriteFailure } from '@/features/errors';
import { bucketIds, mergeBucketMaps } from './id-buckets';
import { inventoryKeys } from './queries';
import { invalidateFieldDueDates, invalidateItems } from './invalidate';

/**
 * The whole category set — the lookup table behind the category facet, the create/edit/bulk-edit
 * pickers, the manager dialog, and every place an item's `categoryId` is resolved to a name.
 *
 * Deliberately **unpaginated** — see `CategoryRepository.listAll`. This was capped at 100, which
 * silently gave wrong answers rather than short ones once a catalogue held more categories than
 * that (issue #148): an item in the 101st category rendered with no category name, and no picker
 * could offer it as a choice. Nothing here scrolls; it is all resolution, so it is read whole,
 * exactly like the flat location list (`useLocations`) it sits beside.
 *
 * The `Page` shape is kept (`.rows`) so every existing caller reads it unchanged.
 */
export function useCategories() {
  return useQuery({
    queryKey: inventoryKeys.categoryList(),
    queryFn: async (): Promise<Page<CategoryWithFieldCount>> => {
      const rows = await getCategoryRepository().listAll();
      return { rows, limit: rows.length, offset: 0, hasMore: false };
    },
  });
}

/**
 * Category id → name, for the places that hold an id and need to show a name — the Activity Log's
 * before/after values, which record `categoryId` because that is what the immutable ledger stores
 * (issue #486).
 *
 * Reads the same bounded whole-set query as {@link useCategories}, so a screen using both pays for
 * one fetch, and rebuilds the map only when that set actually changes. A missing id is a category
 * deleted since the entry was written; the caller decides what to show for it rather than getting
 * a blank.
 */
export function useCategoryNames(): ReadonlyMap<string, string> {
  const { data } = useCategories();
  return useMemo(() => new Map((data?.rows ?? []).map((c) => [c.id, c.name])), [data]);
}

/**
 * The category ids that at least one active item currently uses, scoped to `locationId`
 * (null = the whole inventory) — the set the Category facet offers so it only lists
 * categories in use, not every category ever defined (issue #76). Deliberately split from
 * {@link useCategories}: names come from that (kept live by category CRUD), while this
 * item-scoped membership query keys under `inventoryKeys.items()`, so any item edit — moving
 * or removing the last item of a category — refreshes which categories the facet offers.
 * `keepPreviousData` holds the last set on screen while a location change reloads it.
 */
export function useCategoriesInUse(locationId: string | null) {
  return useQuery({
    queryKey: inventoryKeys.categoriesInUse(locationId),
    queryFn: () => getItemRepository().categoriesInUse(locationId),
    placeholderData: keepPreviousData,
  });
}

export function useCategoryFields(categoryId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.categoryFields(categoryId ?? ''),
    queryFn: () => getCategoryRepository().listFields(categoryId!),
    enabled: Boolean(categoryId),
  });
}

/** An item's category fields resolved with lenient defaulting (§4). */
export function useItemFields(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemFields(itemId ?? ''),
    queryFn: () => getCategoryRepository().resolveItemFields(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * Every custom-field definition across all categories — the catalog the item-card field
 * picker offers and the card renderer resolves chosen custom fields against (backlog E1).
 * A bounded whole-set read, like {@link useCategories}.
 */
export function useAllCategoryFields() {
  return useQuery({
    queryKey: inventoryKeys.allCategoryFields(),
    queryFn: () => getCategoryRepository().listAllFields(),
  });
}

/**
 * Stored custom-field values for a set of on-screen items, so the item cards can render
 * chosen custom fields without an async fetch per card (backlog E1). `fieldIds` names the
 * custom fields the cards will actually draw (`useCardFieldsConfig().visibleCustomFieldIds`);
 * an empty list — the default configuration, where no custom field is shown — skips the read
 * entirely, so the common case still costs nothing.
 *
 * Passing the fields rather than a bare "any custom field is shown" flag is what keeps the
 * read proportional to what is on screen (issue #560): the repository restricts the query to
 * those fields instead of returning each item's whole stored set, which for a resident window
 * of up to `MAX_LIST_PAGES × DEFAULT_PAGE_SIZE` items meant every unshown `LONG_TEXT` — and
 * every unshown `IMAGE` field's base64 payload — crossing the worker boundary to render a
 * card that never referred to them.
 *
 * The ids are **sorted** before they reach the key so the identity is the *set* of fields, not
 * the order they happen to be drawn in — reordering the card fields renders differently but
 * fetches the same values, and re-keying there would throw the whole window's cache away.
 *
 * The window is read one fixed-size id bucket at a time rather than as a single whole-window
 * query, so a scrolling list reads each item's values exactly once instead of re-reading
 * every resident id on every page (issue #169 — see {@link bucketIds}).
 */
export function useItemFieldValues(itemIds: readonly string[], fieldIds: readonly string[]) {
  const buckets = useMemo(() => bucketIds(itemIds), [itemIds]);
  const fields = useMemo(() => [...fieldIds].sort(), [fieldIds]);
  return useQueries({
    queries: buckets.map((bucket) => ({
      queryKey: inventoryKeys.itemFieldValues(bucket, fields),
      queryFn: () => getCategoryRepository().getItemFieldValues(bucket, fields),
      enabled: fields.length > 0,
      // Only the partly-filled tail bucket ever re-keys; hold its last values in place while
      // it reloads so those cards don't flicker.
      placeholderData: (prev: Map<string, Map<string, CardFieldStoredValue>> | undefined) => prev,
    })),
    combine: (results) => ({ data: mergeBucketMaps(results.map((r) => r.data)) }),
  });
}

export function useCreateCategory() {
  const client = useQueryClient();
  // No hook-level `onError` reporter: the preset importer (`CategoryPresetPicker`) already catches
  // this write's failure and shows its own inline alert, so a hook toast would double-report there.
  // The two fire-and-forget call sites (`CategoryManagerDialog`, `CreateCategoryDialog`) report at
  // the call site instead (#389) — mirroring `useUpdateLocation`.
  return useMutation({
    mutationFn: (input: CreateCategoryInput) => getCategoryRepository().create(input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

export function useUpdateCategory() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.categoryUpdate',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCategoryInput }) =>
      getCategoryRepository().update(id, input),
    // The manager auto-saves edits with no error surface (#389).
    onError: reportFailure,
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

export function useDeleteCategory() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.categoryDelete',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (id: string) => getCategoryRepository().delete(id),
    // Fired from the manager with no error surface (#389).
    onError: reportFailure,
    onSettled: () => {
      // Deleting a category nulls its items' category_id, so refresh items too.
      void client.invalidateQueries({ queryKey: inventoryKeys.categories() });
      invalidateItems(client);
    },
  });
}

export function useAddCategoryField() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ categoryId, input }: { categoryId: string; input: CreateCategoryFieldInput }) =>
      getCategoryRepository().addField(categoryId, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.categories() });
      // A field added as a due date (W1a) can put existing items into the alert/agenda lanes
      // straight away, since their values may already be stored against the shared definition.
      invalidateFieldDueDates(client);
    },
  });
}

export function useUpdateCategoryField() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ fieldId, input }: { fieldId: string; input: UpdateCategoryFieldInput }) =>
      getCategoryRepository().updateField(fieldId, input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.categories() });
      // Turning the due-date opt-in on or off (W1a), or renaming the field the alert names.
      invalidateFieldDueDates(client);
    },
  });
}

export function useDeleteCategoryField() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.categoryFieldDelete',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (fieldId: string) => getCategoryRepository().deleteField(fieldId),
    // Fired from the manager with no error surface (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.categories() });
      // Dropping the field clears this category's items' values, so their due dates go with it.
      invalidateFieldDueDates(client);
    },
  });
}

/**
 * Upsert/clear an item's custom-field values, then refresh its resolved fields.
 *
 * `originDeviceId` (W1g) is per *call*, not baked into the hook, precisely because the two
 * callers differ: the editor is a person authoring a value on this device and says so, while
 * the lookup panel is copying a string out of an external catalogue and makes no claim about
 * where it would resolve. A hook-level `getDeviceId()` would silently give both the first
 * answer.
 */
export function useSetItemFieldValues(itemId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure('inventory.writeError.heading.fields', 'common.writeFailed');
  return useMutation({
    mutationFn: (vars: { values: Record<string, string | null>; originDeviceId?: string | null }) =>
      getCategoryRepository().setItemFieldValues(itemId, vars.values, vars.originDeviceId ?? null),
    // The editor validates before it saves, but the write can still be rejected by the
    // repository (a value it re-checks, the storage hard stop) after the "Save" click — which
    // `CustomFieldsEditor` fires fire-and-forget — so surface that reason rather than swallow it
    // and leave the button reading "Saved" (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemFields(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(itemId) });
      // Refresh the on-card custom-field values (E1) — each resident window keys its read on
      // its own item ids, so the shared prefix is what reaches all of them at once.
      void client.invalidateQueries({ queryKey: inventoryKeys.itemFieldValuesAll() });
      // A stored DATE value is what the due-date lanes read (W1a).
      invalidateFieldDueDates(client);
    },
  });
}

// --- location field values (issue #97) -------------------------------------------

/** The global custom-field dictionary — every definition a location may set a value for. */
export function useFieldDefs() {
  return useQuery({
    queryKey: inventoryKeys.fieldDefs(),
    queryFn: () => getCategoryRepository().listFieldDefs(),
  });
}

/**
 * The dictionary definitions nothing references any more — the removable leftovers a
 * category dropping its last use of a field leaves behind.
 */
export function useUnusedFieldDefs() {
  return useQuery({
    queryKey: inventoryKeys.unusedFieldDefs(),
    queryFn: () => getCategoryRepository().listUnusedFieldDefs(),
  });
}

/**
 * Remove an unused dictionary definition.
 *
 * One invalidation covers everything: `fieldDefs()` is a *child* of `categories()`, so
 * dropping the categories key by prefix also refreshes the dictionary and the unused list
 * that hangs off it — which is why the neighbouring field mutations name `categories()` alone.
 */
export function useDeleteUnusedFieldDef() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.fieldDefDelete',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (defId: string) => getCategoryRepository().deleteUnusedFieldDef(defId),
    // Fired from the dictionary cleanup with no error surface (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.categories() });
      invalidateFieldDueDates(client);
    },
  });
}

/** One location's custom-field values (inheritable or not). */
export function useLocationFieldValues(locationId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.locationFields(locationId ?? ''),
    queryFn: () => getCategoryRepository().listLocationFieldValues(locationId!),
    enabled: Boolean(locationId),
  });
}

/**
 * Every location's field values as one searchable text blob each, so the sidebar's search can
 * find a place by something recorded *about* it (issue #617, `N2`).
 *
 * Gated by `enabled` — the sidebar passes "the user has typed something" — so a screen where
 * nobody searches never pays for the read at all. Once fetched it is cached under the shared
 * locations prefix, so subsequent keystrokes match against it synchronously.
 */
export function useLocationFieldSearchText(enabled: boolean) {
  return useQuery({
    queryKey: inventoryKeys.locationFieldSearchText(),
    queryFn: () => getCategoryRepository().listLocationFieldSearchText(),
    enabled,
  });
}

/**
 * Set (or clear) a location's value for a definition, then refresh everything that could
 * be *inheriting* it (issue #97).
 *
 * The invalidation is deliberately broad: changing what a location offers can change the
 * resolved value of any item beneath it, at any depth, and the item→location relationship
 * lives in the DB rather than in the cache, so there is no cheap way to name just the
 * affected items. Dropping the whole item field cache keeps the "live updated" guarantee
 * the feature promises; these queries are small and re-fetch on demand.
 */
export function useSetLocationFieldValue(locationId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.locationFieldSet',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: SetLocationFieldValueInput) =>
      getCategoryRepository().setLocationFieldValue(locationId, input),
    // The location-fields editor saves without an error surface (#389).
    onError: reportFailure,
    onSettled: () => invalidateInheritance(client, locationId),
  });
}

/** Drop a location's value for a definition, then refresh anything that inherited it. */
export function useRemoveLocationFieldValue(locationId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.locationFieldRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (defId: string) => getCategoryRepository().removeLocationFieldValue(locationId, defId),
    // Fired from the ✕ on a location-field row with no error surface (#389).
    onError: reportFailure,
    onSettled: () => invalidateInheritance(client, locationId),
  });
}

/** Shared invalidation for any change to what a location offers (issue #97). */
function invalidateInheritance(client: QueryClient, locationId: string): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.locationFields(locationId) });
  void client.invalidateQueries({ queryKey: inventoryKeys.fieldDefs() });
  // The sidebar's searchable text is built from these very rows, and this write touches no
  // `locations` row — so nothing else sweeps it (issue #617, `N2`).
  void client.invalidateQueries({ queryKey: inventoryKeys.locationFieldSearchText() });
  // Every item's resolved fields, and every on-card value: an inheritable change can
  // reach any descendant item at any depth. Matched by predicate rather than prefix because
  // the `'fields'` segment sits *after* the item id — the prefix is taken from the factory
  // rather than re-typed, so a renamed segment can't silently stop this matching (issue #379).
  const itemsPrefix = inventoryKeys.items();
  void client.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey as readonly unknown[];
      return itemsPrefix.every((segment, i) => key[i] === segment) && key.includes('fields');
    },
  });
  void client.invalidateQueries({ queryKey: inventoryKeys.itemFieldValuesAll() });
  // An inheritable date reaches every item beneath the location, so it moves the lanes too.
  invalidateFieldDueDates(client);
}
