/**
 * Revaluation row + DTO (feature-gap G9 — manual current / market value).
 *
 * An append-only point recording an item's manual per-unit `value` at the moment it was
 * set, so an appreciating asset's value history (up or down, independent of the
 * straight-line depreciation curve) is charted rather than overwritten and lost. Mirrors
 * the shipped `supplier_part_price_history` shape: a real synced LWW row (carries
 * `updated_at`), insert-only in practice, sitting beside the live `items.current_value`
 * column the newest point set.
 */

export interface RevaluationRow {
  readonly id: string;
  readonly item_id: string;
  readonly value: number;
  /** Effective date of the valuation (UNIX-ms). */
  readonly revalued_at: number;
  readonly note: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface Revaluation {
  readonly id: string;
  readonly itemId: string;
  /** Recorded manual value **per unit**, in the base currency (≥ 0). */
  readonly value: number;
  /** Effective date of the valuation (UNIX-ms). */
  readonly revaluedAt: number;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Parameters for recording a revaluation point (feature-gap G9). */
export interface RecordRevaluationInput {
  /** New manual per-unit value; must be finite and ≥ 0. */
  readonly value: number;
  /** Effective date (UNIX-ms); defaults to "now" when omitted. */
  readonly revaluedAt?: number;
  /** Optional free-text note (e.g. "post-restoration appraisal"). */
  readonly note?: string | null;
}
