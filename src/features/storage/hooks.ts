/**
 * Tier-1 hooks for the Storage Triage Dashboard (spec §7.6.2, §7.6.3).
 *
 * Reads (the per-table breakdown and the workflow candidate counts) go through
 * TanStack Query; the two recovery workflows are mutations that, on success, refresh
 * the live OPFS telemetry (`useStorageStore.refresh`) and invalidate the breakdown so
 * the dashboard reflects the reclaimed space immediately.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getStorageRepository } from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { useStorageStore } from '@/state/stores/useStorageStore';
import { imagesBytesOnDisk } from '@/features/images/opfs-images';
import { archiveAndPruneHistory, downgradeImagesBefore } from './triage-actions';
import { estimateTableBytes } from './triage';

export const storageKeys = {
  all: ['storage'] as const,
  breakdown: () => [...storageKeys.all, 'breakdown'] as const,
  pruneCount: (cutoff: number) => [...storageKeys.all, 'prune-count', cutoff] as const,
  downgradeCount: (cutoff: number) => [...storageKeys.all, 'downgrade-count', cutoff] as const,
};

/**
 * Estimated OPFS consumption broken down by table (§7.6.2). The image figure prefers
 * the *measured* on-disk size of the full-resolution OPFS files (summed via
 * `imagesBytesOnDisk()`) for accuracy, falling back to the per-row heuristic where
 * OPFS cannot be measured; `imagesMeasured` tells the UI which was used.
 */
export function useStorageBreakdown() {
  return useQuery({
    queryKey: storageKeys.breakdown(),
    queryFn: async () => {
      const [counts, itemImagesBytes] = await Promise.all([
        getStorageRepository().rowCounts(),
        imagesBytesOnDisk(),
      ]);
      return {
        counts,
        bytes: estimateTableBytes(counts, { itemImagesBytes }),
        imagesMeasured: itemImagesBytes !== null,
      };
    },
  });
}

/** How many history rows a prune at `cutoff` would archive + remove (§7.6.3 A). */
export function usePruneCandidateCount(cutoff: number) {
  return useQuery({
    queryKey: storageKeys.pruneCount(cutoff),
    queryFn: () => getStorageRepository().countHistoryBefore(cutoff),
  });
}

/** How many images a downgrade at `cutoff` would affect (§7.6.3 B). */
export function useDowngradeCandidateCount(cutoff: number) {
  return useQuery({
    queryKey: storageKeys.downgradeCount(cutoff),
    queryFn: () => getStorageRepository().countDowngradableBefore(cutoff),
  });
}

/** Invalidate every triage read + refresh the live OPFS telemetry after a reclaim. */
function refreshAfterReclaim(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: storageKeys.all });
  void client.invalidateQueries({ queryKey: inventoryKeys.items() });
  void useStorageStore.getState().refresh();
}

/**
 * `now` is supplied by the caller (the dialog captures it once at mount) so the
 * executed prune/downgrade uses the *same* reference instant as the previewed
 * candidate counts — no drift between "12 entries affected" and what is removed.
 */
export function useArchiveAndPruneHistory(now: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (months: number) => archiveAndPruneHistory(months, now),
    onSettled: () => refreshAfterReclaim(client),
  });
}

export function useDowngradeImages(now: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (months: number) => downgradeImagesBefore(months, now),
    onSettled: () => refreshAfterReclaim(client),
  });
}
