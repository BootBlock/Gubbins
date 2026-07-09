/**
 * Tier-1 hooks for the Sales & disposals capability.
 *
 * Selling and writing off both draw stock permanently out of inventory and append a `SOLD` /
 * `WRITTEN_OFF` entry to the Activity Ledger (with a sale price / cost snapshot for the sales
 * report), so — like checkout — they invalidate the inventory views alongside the reports.
 * Invalidation-based rather than optimistically patched: a single confirmation tap is
 * low-frequency, and the ledger row / cost snapshot are computed server-side.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getItemRepository, type SellItemInput, type WriteOffItemInput } from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';

/** Invalidate every view a sale / write-off reshapes (stock, the item's history, the reports). */
function invalidateSale(client: ReturnType<typeof useQueryClient>): void {
  // `items()` is the prefix of the item detail, its history, per-location stock and batches, so
  // one invalidation refreshes them all.
  void client.invalidateQueries({ queryKey: inventoryKeys.items() });
  // The sales & margin report (and the movement/valuation reports) read the ledger this writes.
  void client.invalidateQueries({ queryKey: ['reports'] });
}

export function useSellItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SellItemInput) => getItemRepository().sell(input),
    onSettled: () => invalidateSale(client),
  });
}

export function useWriteOffItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: WriteOffItemInput) => getItemRepository().writeOff(input),
    onSettled: () => invalidateSale(client),
  });
}
