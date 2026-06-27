/**
 * Tier-1 read + write hooks for the Phase 9 lifecycle domain (spec §4, §4.3, §4.4).
 *
 * Reads go through TanStack Query (paginated ≤100); writes invalidate the affected
 * slices. The variant/expiry/maintenance reads reuse the `inventoryKeys` namespace
 * so an item edit (which can change expiry, condition or parentage) cleanly
 * invalidates them by prefix. `now`-dependent reads inject `Date.now()` once per
 * mount, keeping the pure scheduling maths deterministic and testable elsewhere.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EXPIRY_SOON_WINDOW_DAYS,
  getItemRepository,
  getMaintenanceRepository,
  getProjectRepository,
  type CreateItemInput,
  type CreateMaintenanceInput,
  type ReconciliationAdjustment,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';

// --- Variants (spec §4 Variant/SKU) --------------------------------------------

export function useItemVariants(parentId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemVariants(parentId ?? ''),
    queryFn: () => getItemRepository().listVariants(parentId!),
    enabled: Boolean(parentId),
  });
}

export function useCreateVariant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ parentId, input }: { parentId: string; input: CreateItemInput }) =>
      getItemRepository().createVariant(parentId, input),
    onSettled: (_d, _e, { parentId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemVariants(parentId) });
    },
  });
}

export function useSetParent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ childId, parentId }: { childId: string; parentId: string | null }) =>
      getItemRepository().setParent(childId, parentId),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.items() }),
  });
}

// --- Perishables & In Transit (spec §4, §3 widgets) ----------------------------

/** Active perishables expiring within the window (default 30 days), soonest first. */
export function useExpiringItems(withinDays: number = EXPIRY_SOON_WINDOW_DAYS) {
  return useQuery({
    queryKey: [...inventoryKeys.expiring(), withinDays],
    queryFn: () => getItemRepository().listExpiringWithin(withinDays, Date.now(), { limit: 100 }),
  });
}

/**
 * BOM lines currently In Transit across all projects (§4 procurement) — the
 * "arriving soon" feed. Phase 4 models In Transit as a BOM-line procurement status
 * (logging `PROCURED`), so this is the faithful source, distinguishing parts
 * arriving from parts simply missing.
 */
export function useInTransitLines() {
  return useQuery({
    queryKey: inventoryKeys.inTransit(),
    queryFn: () => getProjectRepository().listInTransit({ limit: 100 }),
  });
}

// --- Cycle counting & reconciliation (spec §4.4) -------------------------------

export function useReconcile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (adjustments: readonly ReconciliationAdjustment[]) =>
      getItemRepository().reconcile(adjustments),
    onSettled: (updated) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      updated?.forEach((item) =>
        client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(item.id) }),
      );
    },
  });
}

// --- Tool maintenance (spec §4.3) ----------------------------------------------

export function useItemMaintenance(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemMaintenance(itemId ?? ''),
    queryFn: () => getMaintenanceRepository().listForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

/** Currently due/overdue maintenance schedules across all active items (dashboard). */
export function useDueMaintenance() {
  return useQuery({
    queryKey: inventoryKeys.maintenanceDue(),
    queryFn: () => getMaintenanceRepository().listDue(Date.now(), { limit: 100 }),
  });
}

function invalidateMaintenance(client: ReturnType<typeof useQueryClient>, itemId: string): void {
  void client.invalidateQueries({ queryKey: inventoryKeys.itemMaintenance(itemId) });
  void client.invalidateQueries({ queryKey: inventoryKeys.maintenance() });
  void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(itemId) });
}

export function useCreateMaintenance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMaintenanceInput) => getMaintenanceRepository().create(input),
    onSettled: (_d, _e, input) => invalidateMaintenance(client, input.itemId),
  });
}

export function useLogMaintenance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: string; itemId: string; note: string }) =>
      getMaintenanceRepository().logPerformed(id, Date.now(), note),
    onSettled: (_d, _e, { itemId }) => invalidateMaintenance(client, itemId),
  });
}

export function useAddMaintenanceUsage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, amount }: { id: string; itemId: string; amount: number }) =>
      getMaintenanceRepository().addUsage(id, amount),
    onSettled: (_d, _e, { itemId }) => invalidateMaintenance(client, itemId),
  });
}

export function useRemoveMaintenance() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; itemId: string }) => getMaintenanceRepository().remove(id),
    onSettled: (_d, _e, { itemId }) => invalidateMaintenance(client, itemId),
  });
}
