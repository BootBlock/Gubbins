/**
 * Per-item reorder policy (spec §4 low-stock alerts; Phase 59).
 *
 * Pure decision logic — no DB, no clock — split out of the repository glue so the
 * "is this item low?" / "how much to re-order?" rules are exhaustively unit-testable in
 * isolation (mirroring the `cycle-count.ts` / `list-window.ts` extract-the-logic seam).
 * The repository's `listLowStock` SQL applies the *same* `COALESCE(per-item, default)`
 * rule in the database for the paginated feed; this module is the single source of truth
 * the UI (e.g. a per-item "reorder N" badge) reuses without a round-trip.
 *
 * An item carries its own optional `reorderPoint` (a DISCRETE quantity floor) and
 * `reorderGaugePercent` (a CONSUMABLE_GAUGE percentage floor); either NULL means "use the
 * global default" — so an item with no override behaves exactly as it did before Phase 59
 * (never a regression). `reorderQty` is an optional explicit top-up suggestion; when
 * absent the shortfall to the effective floor is used instead.
 */
import type { Item } from '@/db/repositories';

/** The global fallback thresholds (the user-tunable Settings defaults). */
export interface ReorderDefaults {
  /** Global DISCRETE quantity floor (e.g. {@link LOW_STOCK_QTY_THRESHOLD}). */
  readonly qtyThreshold: number;
  /** Global CONSUMABLE_GAUGE percentage floor (e.g. {@link LOW_STOCK_GAUGE_PERCENT}). */
  readonly gaugePercent: number;
}

/** The reorder-relevant slice of an item — kept minimal so callers can pass any shape. */
export type ReorderItem = Pick<
  Item,
  'trackingMode' | 'quantity' | 'gauge' | 'reorderPoint' | 'reorderGaugePercent' | 'reorderQty'
>;

/** The effective DISCRETE quantity floor for an item: its own override, else the default. */
export function effectiveQtyThreshold(item: ReorderItem, defaults: ReorderDefaults): number {
  return item.reorderPoint ?? defaults.qtyThreshold;
}

/** The effective gauge percentage floor for an item: its own override, else the default. */
export function effectiveGaugePercent(item: ReorderItem, defaults: ReorderDefaults): number {
  return item.reorderGaugePercent ?? defaults.gaugePercent;
}

/**
 * Whether an item is below its reorder point and should be flagged as low stock.
 *
 * - DISCRETE — low when on-hand `quantity` is at/below the effective quantity floor.
 * - CONSUMABLE_GAUGE — low when the gauge's percentage remaining is at/below the
 *   effective gauge floor (a gauge with no usable capacity is never "low").
 * - SERIALISED — a single asset is never "low bulk stock", matching the feed exclusion.
 */
export function isLow(item: ReorderItem, defaults: ReorderDefaults): boolean {
  if (item.trackingMode === 'CONSUMABLE_GAUGE') {
    if (!item.gauge || item.gauge.grossCapacity <= 0) return false;
    return item.gauge.percentageRemaining <= effectiveGaugePercent(item, defaults);
  }
  if (item.trackingMode === 'SERIALISED') return false;
  return item.quantity <= effectiveQtyThreshold(item, defaults);
}

/**
 * How many units to re-order to bring a low DISCRETE item back to (at least) its reorder
 * point — the shopping-list suggestion. Returns 0 when the item is not low (nothing to
 * buy). A per-item `reorderQty` (an explicit top-up amount) takes precedence when set;
 * otherwise it is the shortfall from on-hand `quantity` up to the effective floor.
 *
 * Gauge items measure material continuously rather than in countable units, so a
 * discrete top-up suggestion doesn't apply — they always return 0 (the gauge UI surfaces
 * "refill" separately).
 */
export function shortfall(item: ReorderItem, defaults: ReorderDefaults): number {
  if (!isLow(item, defaults)) return 0;
  if (item.trackingMode !== 'DISCRETE') return 0;
  if (item.reorderQty != null && item.reorderQty > 0) return item.reorderQty;
  const floor = effectiveQtyThreshold(item, defaults);
  return Math.max(0, floor - item.quantity);
}
