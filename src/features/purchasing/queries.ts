/**
 * TanStack Query hooks + write mutations for the Formal Purchase Orders screen
 * (inventory-depth Phase 62) and the Reorder / Shopping-list tab (Phase 65).
 *
 * Every read/write funnels through `PurchaseOrderRepository` / `ReportRepository`
 * (never raw SQL in a component). Mutations invalidate the PO caches; a receive also
 * invalidates the item caches so on-hand stock and history refresh.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getPurchaseOrderRepository,
  getReportRepository,
  type CreatePurchaseOrderInput,
  type CreatePurchaseOrderLineInput,
  type LowStockThresholds,
  type UpdatePurchaseOrderLineInput,
} from '@/db/repositories';
import type { BatchIdentity } from '@/features/inventory/batches';
import { inventoryKeys } from '@/features/inventory/queries';
import type { ReorderPlanGroup } from './reorder-plan';

export const purchaseOrderKeys = {
  all: ['purchase-orders'] as const,
  list: () => [...purchaseOrderKeys.all, 'list'] as const,
  detail: (id: string) => [...purchaseOrderKeys.all, 'detail', id] as const,
};

/** Every purchase order (with lines + effective status), newest first. */
export function usePurchaseOrders() {
  return useQuery({
    queryKey: purchaseOrderKeys.list(),
    queryFn: () => getPurchaseOrderRepository().list({ limit: 100 }),
  });
}

/** One purchase order with its lines and effective (derived) status. */
export function usePurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: purchaseOrderKeys.detail(id ?? ''),
    queryFn: () => getPurchaseOrderRepository().getWithLines(id!),
    enabled: Boolean(id),
  });
}

export function useCreatePurchaseOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePurchaseOrderInput) => getPurchaseOrderRepository().create(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
    },
  });
}

export function useSetPurchaseOrderStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'DRAFT' | 'ORDERED' | 'CANCELLED' }) =>
      getPurchaseOrderRepository().setStatus(id, status),
    onSuccess: (_data, { id }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(id) });
    },
  });
}

export function useDeletePurchaseOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => getPurchaseOrderRepository().delete(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
    },
  });
}

export function useAddPurchaseOrderLine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ poId, input }: { poId: string; input: CreatePurchaseOrderLineInput }) =>
      getPurchaseOrderRepository().addLine(poId, input),
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
    },
  });
}

export function useUpdatePurchaseOrderLine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      lineId,
      input,
    }: {
      poId: string;
      lineId: string;
      input: UpdatePurchaseOrderLineInput;
    }) => getPurchaseOrderRepository().updateLine(lineId, input),
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
    },
  });
}

export function useRemovePurchaseOrderLine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId }: { poId: string; lineId: string }) =>
      getPurchaseOrderRepository().removeLine(lineId),
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
    },
  });
}

export interface ReceiveLineVars {
  readonly poId: string;
  readonly lineId: string;
  readonly itemId: string | null;
  readonly locationId?: string;
  readonly quantity?: number;
  readonly batch?: BatchIdentity;
}

export function useReceivePurchaseOrderLine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, locationId, quantity, batch }: ReceiveLineVars) =>
      getPurchaseOrderRepository().receiveLine(lineId, { locationId, quantity, batch }),
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      // A receipt moved stock — refresh the item caches so on-hand + history reflect it.
      // Invalidating the `items()` prefix covers the detail, history, stock and list slices
      // (they all hang off it), so a per-item key is unnecessary.
      void client.invalidateQueries({ queryKey: inventoryKeys.items() });
    },
  });
}

// --- Phase 65: Reorder / Shopping-list ----------------------------------------

export const reorderKeys = {
  all: ['reorder'] as const,
  plan: (thresholds?: LowStockThresholds) => [...reorderKeys.all, 'plan', thresholds ?? {}] as const,
};

/** The full grouped reorder plan — shortfall items grouped by preferred supplier. */
export function useReorderPlan(thresholds?: LowStockThresholds) {
  return useQuery({
    queryKey: reorderKeys.plan(thresholds),
    queryFn: () => getReportRepository().reorderPlan(thresholds),
  });
}

/**
 * Create one DRAFT PO per named supplier group in the plan. Invalidates the PO list so
 * the new orders appear immediately in the Orders tab.
 */
export function useCreateDraftFromReorderPlan() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (groups: readonly ReorderPlanGroup[]) =>
      getPurchaseOrderRepository().createDraftFromReorderPlan(groups),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
    },
  });
}
