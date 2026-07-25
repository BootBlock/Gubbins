/**
 * Write-side hooks for the supplier dictionary (issue #384).
 *
 * Deliberately separate from `./queries` (the read seam): component tests replace that module
 * wholesale with a `vi.mock` factory listing only the hooks they render, so a mutation living
 * beside the reads would resolve to `undefined` inside any test that drives a write.
 *
 * **Invalidation is the interesting part.** A supplier is referenced by `supplier_parts`
 * (inventory) and `purchase_orders` (purchasing), so a merge silently re-points rows that other
 * caches already hold — the supplier list refreshing on its own would leave a stale supplier name
 * on every item's parts panel and every order in the list. Every write therefore fans out to the
 * consumers as well as to {@link supplierKeys}; {@link invalidateSupplierConsumers} is the one
 * place that fan-out is written down, so no call site can forget half of it.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getSupplierRepository, type CreateSupplierInput, type UpdateSupplierInput } from '@/db/repositories';
import { invalidateItems } from '@/features/inventory/invalidate';
import { invalidateOnOrder, purchaseOrderKeys, reorderKeys } from '@/features/purchasing/queries';
import { supplierKeys } from './queries';

/**
 * Refresh everything a supplier write can reshape.
 *
 * - **Supplier parts** hang off the inventory `items()` prefix (`inventoryKeys.itemSupplierParts`
 *   and friends), so `invalidateItems` covers them — and carries the reports prefix with it,
 *   which matters because spend analytics groups by supplier.
 * - **Purchase orders** are keyed independently and read the supplier name directly.
 * - **The reorder plan** groups shortfall items by their preferred supplier, so a rename or a
 *   merge changes its grouping even though no stock moved.
 * - **On-order quantities** are derived per supplier part, so a merge that folds two suppliers
 *   together folds their outstanding lines together too — swept through `invalidateOnOrder`,
 *   which carries the "Upcoming" agenda's reorder lane with it (issue #374).
 */
function invalidateSupplierConsumers(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: supplierKeys.all });
  invalidateItems(client);
  void client.invalidateQueries({ queryKey: purchaseOrderKeys.all });
  void client.invalidateQueries({ queryKey: reorderKeys.all });
  invalidateOnOrder(client);
}

/** Add a supplier to the dictionary. */
export function useCreateSupplier() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSupplierInput) => getSupplierRepository().create(input),
    onSuccess: () => invalidateSupplierConsumers(client),
  });
}

/**
 * Edit a supplier's name, URL, currency or note.
 *
 * A rename that collides with another supplier is **rejected** by the repository rather than
 * quietly folded — merging is destructive of one of the two rows, so it has to be asked for
 * explicitly. The caller surfaces that rejection and points at the merge flow.
 */
export function useUpdateSupplier() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateSupplierInput }) =>
      getSupplierRepository().update(id, input),
    onSuccess: () => invalidateSupplierConsumers(client),
  });
}

/**
 * Fold one supplier into another: every supplier part and purchase order is re-pointed at the
 * target and the source row is deleted, in a single transaction.
 */
export function useMergeSuppliers() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
      getSupplierRepository().merge(sourceId, targetId),
    onSuccess: () => invalidateSupplierConsumers(client),
  });
}

/**
 * Delete a supplier. Its supplier parts cascade away with it; its purchase orders do not — they
 * are ON DELETE SET NULL, so spend history survives list tidying and simply stops naming a
 * supplier. Merging is the alternative when the supplier was a duplicate rather than surplus.
 */
export function useDeleteSupplier() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getSupplierRepository().delete(id),
    onSuccess: () => invalidateSupplierConsumers(client),
  });
}
