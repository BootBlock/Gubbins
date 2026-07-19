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
  type CreateCategoryFieldInput,
  type CreateCategoryInput,
  type SetLocationFieldValueInput,
  type UpdateCategoryFieldInput,
  type UpdateCategoryInput,
} from '@/db/repositories';
import { bucketIds, mergeBucketMaps } from './id-buckets';
import { inventoryKeys } from './queries';
import { invalidateItems } from './invalidate';

export function useCategories() {
  return useQuery({
    queryKey: inventoryKeys.categoryList(),
    queryFn: () => getCategoryRepository().list({ limit: 100 }),
  });
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
 * chosen custom fields without an async fetch per card (backlog E1). Pass `enabled: false`
 * (no custom field is shown) to skip the read entirely — zero cost for the common case.
 *
 * The window is read one fixed-size id bucket at a time rather than as a single whole-window
 * query, so a scrolling list reads each item's values exactly once instead of re-reading
 * every resident id on every page (issue #169 — see {@link bucketIds}).
 */
export function useItemFieldValues(itemIds: readonly string[], enabled = true) {
  const buckets = useMemo(() => bucketIds(itemIds), [itemIds]);
  return useQueries({
    queries: buckets.map((bucket) => ({
      queryKey: inventoryKeys.itemFieldValues(bucket),
      queryFn: () => getCategoryRepository().getItemFieldValues(bucket),
      enabled,
      // Only the partly-filled tail bucket ever re-keys; hold its last values in place while
      // it reloads so those cards don't flicker.
      placeholderData: (prev: Map<string, Map<string, string>> | undefined) => prev,
    })),
    combine: (results) => ({ data: mergeBucketMaps(results.map((r) => r.data)) }),
  });
}

export function useCreateCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) => getCategoryRepository().create(input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

export function useUpdateCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCategoryInput }) =>
      getCategoryRepository().update(id, input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

export function useDeleteCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getCategoryRepository().delete(id),
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
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

export function useUpdateCategoryField() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ fieldId, input }: { fieldId: string; input: UpdateCategoryFieldInput }) =>
      getCategoryRepository().updateField(fieldId, input),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

export function useDeleteCategoryField() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (fieldId: string) => getCategoryRepository().deleteField(fieldId),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
  });
}

/** Upsert/clear an item's custom-field values, then refresh its resolved fields. */
export function useSetItemFieldValues(itemId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, string | null>) =>
      getCategoryRepository().setItemFieldValues(itemId, values),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemFields(itemId) });
      // Refresh the on-card custom-field values (E1) — their key is `[...items(),
      // 'fieldValues', ids]`, so the prefix matches every resident-window query.
      void client.invalidateQueries({ queryKey: [...inventoryKeys.items(), 'fieldValues'] });
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
    queryKey: [...inventoryKeys.fieldDefs(), 'unused'],
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
  return useMutation({
    mutationFn: (defId: string) => getCategoryRepository().deleteUnusedFieldDef(defId),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.categories() }),
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
  return useMutation({
    mutationFn: (input: SetLocationFieldValueInput) =>
      getCategoryRepository().setLocationFieldValue(locationId, input),
    onSettled: () => invalidateInheritance(client, locationId),
  });
}

/** Drop a location's value for a definition, then refresh anything that inherited it. */
export function useRemoveLocationFieldValue(locationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (defId: string) => getCategoryRepository().removeLocationFieldValue(locationId, defId),
    onSettled: () => invalidateInheritance(client, locationId),
  });
}

/** Shared invalidation for any change to what a location offers (issue #97). */
function invalidateInheritance(client: QueryClient, locationId: string): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.locationFields(locationId) });
  void client.invalidateQueries({ queryKey: inventoryKeys.fieldDefs() });
  // Every item's resolved fields, and every on-card value: an inheritable change can
  // reach any descendant item at any depth.
  void client.invalidateQueries({
    predicate: (q) => {
      const key = q.queryKey as readonly unknown[];
      return key[0] === 'inventory' && key[1] === 'items' && key.includes('fields');
    },
  });
  void client.invalidateQueries({ queryKey: [...inventoryKeys.items(), 'fieldValues'] });
}
