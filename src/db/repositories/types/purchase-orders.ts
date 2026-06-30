/**
 * Purchase-order row + DTO types (spec §4 procurement; Inventory-depth Phase 62).
 *
 * A supplier-keyed PO document with multiple lines that receive into the existing
 * per-location / per-batch stock machinery. The persisted `status` carries any of the five
 * values for sync fidelity, but for an active order it is a derived snapshot (received vs
 * ordered) recomputed by `po-status.ts`; only DRAFT and CANCELLED are user-set authoritative
 * states.
 */

/** The five persisted PO statuses. Only DRAFT / CANCELLED are user-set; the rest are derived. */
export type PurchaseOrderStatus = 'DRAFT' | 'ORDERED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED';

export interface PurchaseOrderRow {
  readonly id: string;
  readonly supplier_name: string;
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
  readonly supplierName: string;
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

/** Fields accepted when creating a PO. Status starts DRAFT; lines are added separately. */
export interface CreatePurchaseOrderInput {
  readonly supplierName: string;
  readonly reference?: string | null;
  readonly currency?: string | null;
}

/** Partial PO header update; an omitted key is left unchanged. */
export interface UpdatePurchaseOrderInput {
  readonly supplierName?: string;
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
