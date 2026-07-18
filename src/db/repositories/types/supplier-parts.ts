/**
 * Supplier-part row + DTO types (spec §4 supplier facet; Inventory-depth Phase 60).
 *
 * Models N suppliers per item — each an order code, optional unit cost / pack / MOQ and
 * quantity price-breaks, with at most one marked preferred. `price_breaks` is stored as a
 * JSON TEXT column in SQLite and surfaced as a structured array on the domain object.
 */
import type { PriceHistorySource } from './supplier-part-price-history';
import type { SupplierRef } from './suppliers';

/** One quantity price-break: `unitCost` applies at `qty` and above. */
export interface PriceBreak {
  readonly qty: number;
  readonly unitCost: number;
}

export interface SupplierPartRow {
  readonly id: string;
  readonly item_id: string;
  readonly supplier_id: string;
  /**
   * Joined from `suppliers.name` — not a column on this table. Present on every row the
   * repository reads, because essentially every consumer wants the name rather than the id.
   */
  readonly supplier_name: string;
  readonly order_code: string | null;
  readonly unit_cost: number | null;
  readonly currency: string | null;
  readonly pack_qty: number | null;
  readonly min_order_qty: number | null;
  /** JSON-encoded `PriceBreak[]`, or null. */
  readonly price_breaks: string | null;
  readonly url: string | null;
  readonly is_preferred: number;
  /** 1 when this supplier is the item's pinned price source (at most one per item). */
  readonly is_price_source: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SupplierPart {
  readonly id: string;
  readonly itemId: string;
  readonly supplierId: string;
  /**
   * The supplier's canonical name, joined from `suppliers`. Read-only here — changing it
   * renames the supplier everywhere, which goes through `SupplierRepository.rename`, never
   * through a supplier part.
   */
  readonly supplierName: string;
  readonly orderCode: string | null;
  readonly unitCost: number | null;
  /** ISO currency code; null ⇒ the base currency (the spec locks a single base currency). */
  readonly currency: string | null;
  readonly packQty: number | null;
  readonly minOrderQty: number | null;
  /** Quantity price-breaks, ascending by `qty`; empty when none recorded. */
  readonly priceBreaks: readonly PriceBreak[];
  readonly url: string | null;
  readonly isPreferred: boolean;
  /**
   * Whether this supplier is the item's pinned **price source** — the single supplier a price
   * refresh fetches when set (issue #28). At most one per item; independent of `isPreferred`
   * (which drives valuation). When none is pinned, a refresh fetches every supplier and reports
   * the cheapest. Toggled via {@link SupplierPartRepository.setPriceSource} / `clearPriceSource`.
   */
  readonly isPriceSource: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Fields accepted when creating a supplier part. `itemId` is supplied separately. */
export interface CreateSupplierPartInput {
  /** Existing supplier by id, or a typed name to resolve-or-create. */
  readonly supplier: SupplierRef;
  readonly orderCode?: string | null;
  readonly unitCost?: number | null;
  readonly currency?: string | null;
  readonly packQty?: number | null;
  readonly minOrderQty?: number | null;
  readonly priceBreaks?: readonly PriceBreak[] | null;
  readonly url?: string | null;
  readonly isPreferred?: boolean;
  /** Where this cost came from, for the Phase-81 price-history row. Defaults to `'MANUAL'`. */
  readonly source?: PriceHistorySource;
}

/** Partial update; an omitted key is left unchanged, an explicit `null` clears it. */
export interface UpdateSupplierPartInput {
  /** Re-point this part at a different supplier; omit to leave it where it is. */
  readonly supplier?: SupplierRef;
  readonly orderCode?: string | null;
  readonly unitCost?: number | null;
  readonly currency?: string | null;
  readonly packQty?: number | null;
  readonly minOrderQty?: number | null;
  readonly priceBreaks?: readonly PriceBreak[] | null;
  readonly url?: string | null;
  readonly isPreferred?: boolean;
  /** Where a changed cost came from, for the Phase-81 price-history row. Defaults to `'MANUAL'`. */
  readonly source?: PriceHistorySource;
}
