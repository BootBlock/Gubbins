/**
 * Tier-1 hooks for categories, their custom-field definitions, and per-item field
 * values (spec §2.1, §4). Categories form a bounded set (not the 100k+ item list),
 * so these reads fetch the whole set rather than paginating into a virtualised view;
 * the strict-pagination mandate (§2.1) targets the item lists. Writes use targeted
 * invalidation — schema edits are low-frequency and reshape derived counts.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getCategoryRepository,
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
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.itemFields(itemId) }),
  });
}
