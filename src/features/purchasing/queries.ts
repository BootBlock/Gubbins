/**
 * TanStack Query hooks + write mutations for the Formal Purchase Orders screen
 * (inventory-depth Phase 62) and the Reorder / Shopping-list tab (Phase 65).
 *
 * Every read/write funnels through `PurchaseOrderRepository` / `ReportRepository`
 * (never raw SQL in a component). Mutations invalidate the PO caches; a receive also
 * invalidates the item caches so on-hand stock and history refresh.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getPurchaseOrderRepository,
  getReportRepository,
  MAX_PAGE_SIZE,
  type CreatePurchaseOrderInput,
  type CreatePurchaseOrderLineInput,
  type LowStockThresholds,
  type PurchaseOrderCountFilter,
  type UpdatePurchaseOrderLineInput,
} from '@/db/repositories';
import { agendaKeys } from '@/features/calendar/keys';
import { useReportWriteFailure } from '@/features/errors';
import type { BatchIdentity } from '@/features/inventory/batches';
import { invalidateItems } from '@/features/inventory/invalidate';
import { reportKeys } from '@/features/reports/keys';
import type { ReorderPlanGroup } from './reorder-plan';

export const purchaseOrderKeys = {
  all: ['purchase-orders'] as const,
  list: () => [...purchaseOrderKeys.all, 'list'] as const,
  /**
   * One page of the order list. Nested **under** {@link purchaseOrderKeys.list} so every
   * existing `invalidateQueries` against the list still refreshes every page and the count —
   * no write has to learn about pagination.
   */
  page: (offset: number, limit: number) => [...purchaseOrderKeys.list(), { offset, limit }] as const,
  count: (filter: PurchaseOrderCountFilter = {}) => [...purchaseOrderKeys.list(), 'count', filter] as const,
  detail: (id: string) => [...purchaseOrderKeys.all, 'detail', id] as const,
};

/**
 * Cache keys for the derived "still on order" quantities (open ORDERED/PARTIAL POs). Every
 * PO write that can change an item's outstanding quantity — receiving, status changes, and
 * line edits — invalidates {@link onOrderKeys.all} so the low-stock surfaces re-read it.
 */
export const onOrderKeys = {
  all: ['on-order'] as const,
  item: (itemId: string) => [...onOrderKeys.all, 'item', itemId] as const,
  items: (itemIds: readonly string[]) => [...onOrderKeys.all, 'items', itemIds] as const,
};

/**
 * Sweep the outstanding-quantity caches after a write that moves them, **and the agenda**.
 *
 * The "Upcoming" reorder lane nets stock already on order off the shortfall it reports
 * (`listReorderShortfall`), so raising, cancelling, deleting or re-lining a purchase order
 * restates how far below the reorder point an item is — "5 units below the reorder point" becomes
 * "at or below the reorder point" once the incoming stock covers it — without any item row moving.
 * (Lane *membership* is on-hand quantity against the reorder point, so a PO never adds or removes
 * a row; it is the figure on the row that goes stale.) Binding the two prefixes into one helper is
 * what stops them drifting apart again (issue #374), so every write goes through here rather than
 * naming `onOrderKeys.all` itself; a guard test in `calendar/agenda-invalidation.test.tsx` holds
 * that line.
 */
export function invalidateOnOrder(client: QueryClient): void {
  void client.invalidateQueries({ queryKey: onOrderKeys.all });
  void client.invalidateQueries({ queryKey: agendaKeys.all });
}

/**
 * The still-**on-order** quantity for one item (open ORDERED/PARTIAL POs) — surfaced beside
 * its reorder point on the item detail so a covered shortage reads as "handled". Defaults to
 * 0 while loading so callers can read it unconditionally.
 */
export function useOnOrderQty(itemId: string | undefined) {
  return useQuery({
    queryKey: onOrderKeys.item(itemId ?? ''),
    queryFn: () => getPurchaseOrderRepository().onOrderQtyForItem(itemId!),
    enabled: Boolean(itemId),
  });
}

/**
 * The on-order quantities for a whole set of items in a single round-trip (the batch companion
 * to {@link useOnOrderQty}) — the Low Stock widget reads its visible rows' incoming stock once
 * rather than N+1 times. The item ids are sorted into the cache key so a re-ordered but
 * otherwise-identical set hits the same cache entry. Resolves to a `Map` keyed by item id
 * (missing key = 0 on order); disabled (never queried) for an empty set.
 */
export function useOnOrderQtys(itemIds: readonly string[]) {
  const sortedIds = [...itemIds].sort();
  return useQuery({
    queryKey: onOrderKeys.items(sortedIds),
    queryFn: () => getPurchaseOrderRepository().onOrderQtyForItems(sortedIds),
    enabled: sortedIds.length > 0,
  });
}

/**
 * One page of purchase orders (with lines + effective status), newest first (issue #149).
 *
 * Defaults to the first full page — what every caller read before — so only the Orders tab,
 * which passes a page, changes behaviour. Orders accumulate for as long as the inventory is
 * used, so that list pages rather than pretending the first hundred are all of them.
 */
export function usePurchaseOrders(page = 1, pageSize = MAX_PAGE_SIZE) {
  const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize)));
  const offset = Math.max(0, (Math.max(1, Math.floor(page)) - 1) * limit);
  return useQuery({
    queryKey: purchaseOrderKeys.page(offset, limit),
    queryFn: () => getPurchaseOrderRepository().list({ limit, offset }),
    // Hold the previous page on screen while the next one loads, so paging doesn't flash the
    // empty state (the Tags screen's behaviour).
    placeholderData: (previous) => previous,
  });
}

/**
 * One page of the order list, for the export's read-everything walk (issue #132). The Orders tab
 * holds a single page, so serialising the rows in hand would export that page rather than the
 * order book; the export re-reads from the start through `exportEveryPage`. Not a hook — it is
 * called from the export's `build` callback, outside React's render.
 */
export function readPurchaseOrdersPage(params: { limit: number; offset: number }) {
  return getPurchaseOrderRepository().list(params);
}

/**
 * How many purchase orders match `filter` — the denominator for the Orders tab's pager with no
 * filter, and the Dashboard tile's figure with `{ open: true }` (issue #573).
 *
 * The open count is resolved by the database rather than by filtering the page in hand: the list
 * reads newest-first, so a user whose most recent hundred orders were all received saw "0 open
 * orders" while a hundred older open ones sat past the page boundary. Pass `{ enabled: false }` to
 * mount without fetching.
 */
export function usePurchaseOrderCount(
  filter: PurchaseOrderCountFilter = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: purchaseOrderKeys.count(filter),
    queryFn: () => getPurchaseOrderRepository().count(filter),
    enabled: options.enabled ?? true,
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
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderCreate',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (input: CreatePurchaseOrderInput) => getPurchaseOrderRepository().create(input),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
    },
  });
}

export function useSetPurchaseOrderStatus() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderStatus',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'DRAFT' | 'ORDERED' | 'CANCELLED' }) =>
      getPurchaseOrderRepository().setStatus(id, status),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: (_data, { id }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(id) });
      // ORDERED ⇄ DRAFT/CANCELLED flips whether this PO's lines count as on order.
      invalidateOnOrder(client);
    },
  });
}

export function useDeletePurchaseOrder() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderDelete',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: (id: string) => getPurchaseOrderRepository().delete(id),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      // A deleted PO removes its outstanding lines from the on-order totals.
      invalidateOnOrder(client);
    },
  });
}

export function useAddPurchaseOrderLine() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderLineAdd',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ poId, input }: { poId: string; input: CreatePurchaseOrderLineInput }) =>
      getPurchaseOrderRepository().addLine(poId, input),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      invalidateOnOrder(client);
    },
  });
}

export function useUpdatePurchaseOrderLine() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, input }: { poId: string; lineId: string; input: UpdatePurchaseOrderLineInput }) =>
      getPurchaseOrderRepository().updateLine(lineId, input),
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      // Editing an ordered/received quantity shifts the item's outstanding total.
      invalidateOnOrder(client);
      // The spend report totals `received_qty * unit_cost`, so correcting either on an
      // already-received line re-prices history even though no item row moves.
      void client.invalidateQueries({ queryKey: reportKeys.all });
    },
  });
}

export function useRemovePurchaseOrderLine() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderLineRemove',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ lineId }: { poId: string; lineId: string }) =>
      getPurchaseOrderRepository().removeLine(lineId),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      invalidateOnOrder(client);
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
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderLineReceive',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ lineId, locationId, quantity, batch }: ReceiveLineVars) =>
      getPurchaseOrderRepository().receiveLine(lineId, { locationId, quantity, batch }),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      // A receipt moved stock — refresh the item caches so on-hand + history reflect it.
      // Invalidating the `items()` prefix covers the detail, history, stock and list slices
      // (they all hang off it), so a per-item key is unnecessary.
      invalidateItems(client);
      // Receiving reduces the outstanding quantity (and may fully clear it).
      invalidateOnOrder(client);
    },
  });
}

export interface ReturnLineVars {
  readonly poId: string;
  readonly lineId: string;
  readonly locationId?: string;
  readonly quantity?: number;
}

/**
 * Return (refund) a received PO line back to the supplier — the inverse of a receipt. Decrements
 * stock, reduces the line's received quantity and re-derives the PO status, so it invalidates the
 * same PO + item caches a receipt does, plus the reports (a return moves stock).
 */
export function useReturnPurchaseOrderLine() {
  const client = useQueryClient();
  const reportFailure = useReportWriteFailure(
    'purchasing.writeError.heading.orderLineReturn',
    'common.writeFailed',
  );
  return useMutation({
    mutationFn: ({ lineId, locationId, quantity }: ReturnLineVars) =>
      getPurchaseOrderRepository().returnLine(lineId, { locationId, quantity }),
    // A rejected write would otherwise fail silently, so surface it to the user (#389).
    onError: reportFailure,
    onSuccess: (_data, { poId }) => {
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.detail(poId) });
      void client.invalidateQueries({ queryKey: purchaseOrderKeys.list() });
      invalidateItems(client);
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
