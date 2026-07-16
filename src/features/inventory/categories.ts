/**
 * Tier-1 hooks for categories, their custom-field definitions, and per-item field
 * values (spec §2.1, §4). Categories form a bounded set (not the 100k+ item list),
 * so these reads fetch the whole set rather than paginating into a virtualised view;
 * the strict-pagination mandate (§2.1) targets the item lists. Writes use targeted
 * invalidation — schema edits are low-frequency and reshape derived counts.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCategoryRepository,
  getItemRepository,
  type CreateCategoryFieldInput,
  type CreateCategoryInput,
  type UpdateCategoryFieldInput,
  type UpdateCategoryInput,
} from '@/db/repositories';
import { inventoryKeys } from './queries';

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
 * chosen custom fields without an async fetch per card (backlog E1). One indexed `IN (…)`
 * read; `keepPreviousData` holds the last values in place while the resident window shifts
 * as the virtualised list scrolls, so a card never flickers. Pass `enabled: false` (no
 * custom field is shown) to skip the query entirely — zero cost for the common case.
 */
export function useItemFieldValues(itemIds: readonly string[], enabled = true) {
  return useQuery({
    queryKey: inventoryKeys.itemFieldValues(itemIds),
    queryFn: () => getCategoryRepository().getItemFieldValues(itemIds),
    enabled: enabled && itemIds.length > 0,
    placeholderData: (prev) => prev,
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
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
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
