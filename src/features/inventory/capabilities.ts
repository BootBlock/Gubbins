/**
 * Tier-1 hooks for weighted capabilities (spec §2.1, §4 Weighted Capabilities).
 *
 * A single item's capabilities are a small, bounded set, so reads are a plain
 * query and writes invalidate (rather than optimistically patch) the item's
 * capability list — they also touch the search surface, so the broad search keys
 * are invalidated too. New capabilities grow storage, so the repository gates them
 * on the Hard Stop (§7.6.1).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getItemRepository, type SetCapabilityInput } from '@/db/repositories';
import { useReportWriteFailure } from '@/features/errors';
import { inventoryKeys } from './queries';

export function useItemCapabilities(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemCapabilities(itemId ?? ''),
    queryFn: () => getItemRepository().listCapabilities(itemId!),
    enabled: Boolean(itemId),
  });
}

export function useSetCapability(itemId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.capabilitySet',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: SetCapabilityInput) => getItemRepository().setCapability(itemId, input),
    // The editor fires "Add capability" fire-and-forget and clears its inputs immediately, so a
    // rejected write — the Hard Stop that gates new capabilities (§7.6.1), a constraint — would
    // otherwise vanish with the typed values (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemCapabilities(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.search() });
    },
  });
}

export function useRemoveCapability(itemId: string) {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'inventory.writeError.heading.capabilityRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (key: string) => getItemRepository().removeCapability(itemId, key),
    // Removal is fired straight from the ✕ on the capability chip with no error surface (#389).
    onError: reportFailure,
    onSettled: () => {
      void client.invalidateQueries({ queryKey: inventoryKeys.itemCapabilities(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemSectionPresence(itemId) });
      void client.invalidateQueries({ queryKey: inventoryKeys.search() });
    },
  });
}
