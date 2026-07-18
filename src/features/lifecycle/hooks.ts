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
  getLocationRepository,
  getMaintenanceRepository,
  getProjectRepository,
  type CreateItemInput,
  type CreateMaintenanceInput,
  type LowStockThresholds,
  type ReconciliationAdjustment,
  type SerialisedReconciliation,
} from '@/db/repositories';
import { inventoryKeys } from '@/features/inventory/queries';
import { nowMs } from '@/lib/clock';

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

// --- Kits / bundles (Kits v1 — definition + availability) ----------------------

/** One kit item's component definition, each joined to its name + current on-hand stock. */
export function useItemKit(kitId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemKit(kitId ?? ''),
    queryFn: () => getItemRepository().listKitComponents(kitId!),
    enabled: Boolean(kitId),
  });
}

/**
 * A kit's nested-kit **roll-up** availability (Kits v3) — how many whole kits are assemblable
 * once sub-kits are built on demand, the deepest limiting leaves, and how many direct components
 * are themselves sub-kits. Keyed under the same `itemKit` namespace so an assemble/disassemble (or
 * a component edit) refreshes it by prefix. Cheap for a flat kit; only surfaced when it nests.
 */
export function useKitAvailability(kitId: string | undefined) {
  return useQuery({
    queryKey: [...inventoryKeys.itemKit(kitId ?? ''), 'rollup'],
    queryFn: () => getItemRepository().rollUpAvailability(kitId!),
    enabled: Boolean(kitId),
  });
}

export function useAddKitComponent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      kitId,
      componentItemId,
      quantity,
    }: {
      kitId: string;
      componentItemId: string;
      quantity: number;
    }) => getItemRepository().addKitComponent(kitId, componentItemId, quantity),
    onSettled: (_d, _e, { kitId }) =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemKit(kitId) }),
  });
}

export function useUpdateKitComponentQty() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, quantity }: { id: string; kitId: string; quantity: number }) =>
      getItemRepository().updateKitComponentQty(id, quantity),
    onSettled: (_d, _e, { kitId }) =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemKit(kitId) }),
  });
}

export function useRemoveKitComponent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; kitId: string }) => getItemRepository().removeKitComponent(id),
    onSettled: (_d, _e, { kitId }) =>
      void client.invalidateQueries({ queryKey: inventoryKeys.itemKit(kitId) }),
  });
}

/**
 * Assemble `count` whole kits from their components (Kits v2) — atomically consuming each
 * component's stock and producing the kit item. Invalidating `items()` refreshes the kit and
 * every component by prefix (their list rows, detail, per-location stock, Activity Log and the
 * kit's buildable count); the kit's own `itemHistory` is invalidated explicitly to mirror the
 * `transferStock` precedent.
 */
export function useAssembleKit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      kitId,
      count,
      destinationLocationId,
      cascade,
    }: {
      kitId: string;
      count: number;
      /** Where to place the produced kit; defaults to the kit's home location (Kits v3). */
      destinationLocationId?: string;
      /** Transitively assemble any missing sub-kit in the same transaction (Kits v3). */
      cascade?: boolean;
    }) => getItemRepository().assemble(kitId, count, { destinationLocationId, cascade }),
    onSettled: (_d, _e, { kitId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(kitId) });
    },
  });
}

/** Break `count` whole kits back down into their components (Kits v2) — the inverse of assemble. */
export function useDisassembleKit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kitId, count }: { kitId: string; count: number }) =>
      getItemRepository().disassemble(kitId, count),
    onSettled: (_d, _e, { kitId }) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(kitId) });
    },
  });
}

// --- Perishables & In Transit (spec §4, §3 widgets) ----------------------------

/**
 * Active perishables expiring within the window (default 30 days), soonest first.
 *
 * `options.enabled` lets a caller behind a feature flag (e.g. the alert centre when the
 * Expiry-tracking capability is off) skip the fetch entirely rather than fetch-then-discard.
 * Defaults to enabled so existing callers are unaffected.
 */
export function useExpiringItems(
  withinDays: number = EXPIRY_SOON_WINDOW_DAYS,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: [...inventoryKeys.expiring(), withinDays],
    queryFn: () => getItemRepository().listExpiringWithin(withinDays, nowMs(), { limit: 100 }),
    enabled: options?.enabled ?? true,
  });
}

/**
 * Active items running low on stock (§3 "Low Stock Alerts" widget) — low discrete
 * quantities and low consumable-gauge percentages interleaved by urgency. Thresholds
 * default to the repository constants; passing them as a key segment keeps the cache
 * correct if a caller ever overrides them.
 */
export function useLowStockItems(thresholds?: LowStockThresholds) {
  return useQuery({
    queryKey: [...inventoryKeys.lowStock(), thresholds ?? null],
    queryFn: () => getItemRepository().listLowStock(thresholds, { limit: 100 }),
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

/**
 * One item's distinct **incoming** quantity (Phase 20, §4 liminal procurement) —
 * the sum of its In-Transit BOM lines, derived from the SSOT so it can never drift.
 * Surfaced on the item detail beside on-hand stock, which it deliberately never
 * overloads. Defaults to 0 while loading so callers can read it unconditionally.
 */
export function useInTransitQty(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemInTransit(itemId ?? ''),
    queryFn: () => getProjectRepository().inTransitQtyForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

// --- Per-location stock ledger (spec §4, Phase 25) -----------------------------

/**
 * One item's per-location stock breakdown — busiest location first, empty placements
 * filtered out (the `items.quantity` total is the sum of these). Surfaced on the item
 * detail so the same item can hold stock in more than one place at once.
 */
export function useItemStock(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemStock(itemId ?? ''),
    queryFn: () => getItemRepository().listStock(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * One item's batch/lot breakdown (Phase 28, §4 perishables) — one row per
 * `(location, batch)` holding stock, FEFO-ordered within each location (soonest expiry
 * first, the untracked remainder last). A non-perishable item yields one untracked row
 * per placement, so the UI can show batch detail only where lots are actually tracked.
 */
export function useItemBatches(itemId: string | undefined) {
  return useQuery({
    queryKey: inventoryKeys.itemBatches(itemId ?? ''),
    queryFn: () => getItemRepository().listItemBatches(itemId!),
    enabled: Boolean(itemId),
  });
}

/** Transfer part of a DISCRETE item's stock between two locations (§4 per-location ledger). */
export function useTransferStock() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId,
      fromLocationId,
      toLocationId,
      quantity,
      batchKey,
    }: {
      itemId: string;
      fromLocationId: string;
      toLocationId: string;
      quantity: number;
      /** Move only this specific lot rather than FEFO (Phase 29); omit for FEFO. */
      batchKey?: string;
    }) => getItemRepository().transferStock(itemId, fromLocationId, toLocationId, quantity, batchKey),
    onSettled: (_d, _e, { itemId }) => {
      // `items()` is a prefix of `itemStock`/`item` (the detail), so this refreshes both.
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(itemId) });
    },
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
      updated?.forEach(
        (item) => void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(item.id) }),
      );
    },
  });
}

/** Authorise a serialised audit: soft-delete the instances flagged missing (§4.4). */
export function useReconcileSerialised() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (adjustments: readonly SerialisedReconciliation[]) =>
      getItemRepository().reconcileSerialised(adjustments),
    onSettled: (updated) => {
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
      updated?.forEach(
        (item) => void client.invalidateQueries({ queryKey: inventoryKeys.itemHistory(item.id) }),
      );
    },
  });
}

/**
 * Stamp a location's durable "last counted" timestamp (stock-take backlog G1) — called
 * once a per-location count completes, clean or reconciled, so `LocationInfoCard` and the
 * audit-day scope picker can show how long it's been since a location was verified.
 */
export function useMarkLocationCounted() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (locationId: string) => getLocationRepository().markCounted(locationId),
    onSettled: () => void client.invalidateQueries({ queryKey: inventoryKeys.locations() }),
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

/**
 * Currently due/overdue maintenance schedules across all active items (dashboard).
 *
 * `options.enabled` lets a caller behind a feature flag (e.g. the alert centre when the
 * Maintenance capability is off) skip the fetch. Defaults to enabled.
 */
export function useDueMaintenance(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: inventoryKeys.maintenanceDue(),
    queryFn: () => getMaintenanceRepository().listDue(nowMs(), { limit: 100 }),
    enabled: options?.enabled ?? true,
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
