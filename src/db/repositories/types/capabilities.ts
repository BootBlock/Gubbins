/**
 * Weighted parametric capability row + DTO types (spec §4 "Weighted Capabilities",
 * Phase 5).
 */

export interface CapabilityRow {
  readonly id: string;
  readonly item_id: string;
  readonly key: string;
  readonly value_num: number | null;
  readonly value_text: string | null;
  readonly weight: number;
  readonly updated_at: number;
}

/**
 * A weighted parametric capability of an item (spec §4). Exactly one of
 * `valueNum`/`valueText` is populated: numeric values back the AST's
 * GREATER_THAN/LESS_THAN comparisons; text values back EQUALS/categorical matches.
 * `weight` (default 1.0) expresses how salient this spec is for relevance ranking.
 */
export interface Capability {
  readonly id: string;
  readonly itemId: string;
  readonly key: string;
  readonly valueNum: number | null;
  readonly valueText: string | null;
  readonly weight: number;
  readonly updatedAt: number;
}

export interface SetCapabilityInput {
  readonly key: string;
  /** Raw value; classified into a numeric magnitude or a text value by the repo. */
  readonly value: string;
  /** Relevance weight (≥ 0); defaults to {@link DEFAULT_CAPABILITY_WEIGHT}. */
  readonly weight?: number;
}

/**
 * One distinct capability *key* across the active inventory, with how many items
 * carry it and whether those values are numeric and/or textual — i.e. the queryable
 * `cap:<key>` vocabulary. Backs a "browse capabilities" view (and the read-only bridge
 * API); a numeric key supports `cap:key>n` comparisons, a textual key `cap:key=value`.
 */
export interface CapabilityKeySummary {
  readonly key: string;
  /** Number of distinct active items that carry this capability key. */
  readonly itemCount: number;
  /** True when at least one item stores this key as a numeric magnitude. */
  readonly hasNumericValues: boolean;
  /** True when at least one item stores this key as a text value. */
  readonly hasTextValues: boolean;
}
