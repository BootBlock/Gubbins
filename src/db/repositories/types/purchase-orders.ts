/**
 * Purchase-order row + DTO types (spec §4 procurement; Inventory-depth Phase 62).
 *
 * A supplier-keyed PO document with multiple lines that receive into the existing
 * per-location / per-batch stock machinery. The persisted `status` carries any of the five
 * values for sync fidelity, but for an active order it is a derived snapshot (received vs
 * ordered) recomputed by `po-status.ts`; only DRAFT and CANCELLED are user-set authoritative
 * states.
 */

import type { BatchIdentity } from '@/features/inventory/batches';
import type { PurchaseOrderStatus } from '../constants';
import type { SupplierRef } from './suppliers';

/**
 * The five persisted PO statuses. Only DRAFT / CANCELLED are user-set; the rest are derived.
 *
 * Declared beside its `PURCHASE_ORDER_STATUSES` vocabulary in `../constants`, which
 * `purchase_orders.status`'s CHECK is built from, and re-exported here so it still reads from
 * the module that owns the row it sits on.
 */
export type { PurchaseOrderStatus };

export interface PurchaseOrderRow {
  readonly id: string;
  /** NULL once the supplier has been deleted (ON DELETE SET NULL) — the order survives. */
  readonly supplier_id: string | null;
  /**
   * Joined from `suppliers.name` — not a column on this table. NULL exactly when
   * {@link supplier_id} is, i.e. the supplier this order was placed with no longer exists.
   */
  readonly supplier_name: string | null;
  readonly reference: string | null;
  readonly status: PurchaseOrderStatus;
  readonly currency: string | null;
  readonly created_at: number;
  readonly ordered_at: number | null;
  readonly updated_at: number;
}

export interface PurchaseOrderLineRow {
  readonly id: string;
  readonly po_id: string;
  readonly item_id: string | null;
  readonly supplier_part_id: string | null;
  readonly description: string | null;
  readonly ordered_qty: number;
  readonly received_qty: number;
  readonly unit_cost: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface PurchaseOrder {
  readonly id: string;
  /**
   * The supplier this order was placed with, or NULL once that supplier has been deleted
   * (ON DELETE SET NULL). The order outlives the supplier: it is a record of money spent.
   */
  readonly supplierId: string | null;
  /**
   * The supplier's canonical name, joined from `suppliers`; NULL exactly when
   * {@link supplierId} is, which the UI renders as an unknown supplier. Read-only here —
   * changing it renames the supplier everywhere, which goes through `SupplierRepository`,
   * never through a purchase order.
   */
  readonly supplierName: string | null;
  readonly reference: string | null;
  /** The persisted status snapshot (DRAFT/CANCELLED are authoritative; others are derived). */
  readonly status: PurchaseOrderStatus;
  /** ISO currency code; null ⇒ the base currency (the spec locks a single base currency). */
  readonly currency: string | null;
  readonly createdAt: number;
  readonly orderedAt: number | null;
  readonly updatedAt: number;
}

export interface PurchaseOrderLine {
  readonly id: string;
  readonly poId: string;
  readonly itemId: string | null;
  readonly supplierPartId: string | null;
  readonly description: string | null;
  readonly orderedQty: number;
  readonly receivedQty: number;
  readonly unitCost: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A PO together with its lines and effective (derived) status — the detail-view shape. */
export interface PurchaseOrderWithLines extends PurchaseOrder {
  readonly lines: readonly PurchaseOrderLine[];
  /** The effective status derived from the lines (see `po-status.ts`). */
  readonly effectiveStatus: PurchaseOrderStatus;
}

/**
 * What narrows a purchase-order **count** (issue #573).
 *
 * `open` restricts the count to orders still outstanding — everything whose effective status is
 * neither RECEIVED nor CANCELLED. It exists because an order's effective status is derived from
 * its lines rather than stored, so "how many are still open?" cannot be asked as a plain
 * `status = ?` and had to be answered by filtering a page of rows in JavaScript instead.
 */
export interface PurchaseOrderCountFilter {
  readonly open?: boolean;
}

/** Fields accepted when creating a PO. Status starts DRAFT; lines are added separately. */
export interface CreatePurchaseOrderInput {
  /** Existing supplier by id, or a typed name to resolve-or-create. */
  readonly supplier: SupplierRef;
  readonly reference?: string | null;
  /**
   * ISO currency code for the order. **Omitted** and **null** differ here: omitting the key
   * defaults the order to the supplier's own `suppliers.currency` (the only place the intended
   * denomination is already recorded), while an explicit `null` states the base currency and is
   * not overridden. See `PurchaseOrderRepository.create` (issue #569).
   */
  readonly currency?: string | null;
}

/** Partial PO header update; an omitted key is left unchanged. */
export interface UpdatePurchaseOrderInput {
  /** Re-point this order at a different supplier; omit to leave it where it is. */
  readonly supplier?: SupplierRef;
  readonly reference?: string | null;
  readonly currency?: string | null;
}

/** Fields accepted when adding a line to a PO. `poId` is supplied separately. */
export interface CreatePurchaseOrderLineInput {
  readonly itemId?: string | null;
  readonly supplierPartId?: string | null;
  readonly description?: string | null;
  readonly orderedQty: number;
  readonly unitCost?: number | null;
}

/** Partial line update; an omitted key is left unchanged. `receivedQty` is not user-settable. */
export interface UpdatePurchaseOrderLineInput {
  readonly itemId?: string | null;
  readonly supplierPartId?: string | null;
  readonly description?: string | null;
  readonly orderedQty?: number;
  readonly unitCost?: number | null;
}

/**
 * One line's share of a delivery, for `PurchaseOrderRepository.receiveLines` (issue #589).
 *
 * The fields are exactly the arguments a single `receiveLine` call takes, named per line so a
 * whole delivery is described in one value: the same destination and batch may be repeated
 * across every entry, or varied where a split delivery went to two places.
 */
export interface PurchaseOrderLineReceipt {
  readonly lineId: string;
  /** Units accepted on this line; omit to receive its whole outstanding remainder. */
  readonly quantity?: number;
  /** Where the units land; omit for the linked item's own home location. */
  readonly locationId?: string;
  /** The batch/lot the units arrived tagged with, where the delivery carried one. */
  readonly batch?: BatchIdentity;
}
