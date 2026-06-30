/**
 * Supplier-part price-history row + DTO (spec §4 supplier facet; Phase 81).
 *
 * An append-only point recording a supplier part's `unit_cost` at the moment it changed,
 * so a part's price movement over time can be charted rather than overwritten and lost.
 * A real synced LWW row (carries `updated_at`); insert-only in practice.
 */

/** How a recorded price point came to be — a manual edit or a supplier scrape. */
export type PriceHistorySource = 'MANUAL' | 'SCRAPE';

export interface SupplierPartPriceHistoryRow {
  readonly id: string;
  readonly supplier_part_id: string;
  readonly unit_cost: number;
  readonly currency: string | null;
  readonly source: PriceHistorySource;
  readonly recorded_at: number;
  readonly updated_at: number;
}

export interface SupplierPartPriceHistoryEntry {
  readonly id: string;
  readonly supplierPartId: string;
  readonly unitCost: number;
  /** ISO currency code; null ⇒ the base currency. */
  readonly currency: string | null;
  readonly source: PriceHistorySource;
  readonly recordedAt: number;
  readonly updatedAt: number;
}
