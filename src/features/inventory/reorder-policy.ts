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
 *
 * **Low-stock is opt-in — an effective floor of 0 (or less) means "off".** We can't guess
 * a sensible "low" level for an arbitrary item, so with the global default off (0) a
 * brand-new item never nags on the dashboard until the user gives it its own positive
 * `reorderPoint`. Setting an item's own `reorderPoint` to 0 while the global blanket is on
 * is the per-item opt-*out*. This mirrors the `listLowStock` SQL, which excludes any row
 * whose effective floor is not strictly positive.
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
  | 'trackingMode'
  | 'quantity'
  | 'gauge'
  | 'reorderPoint'
  | 'reorderGaugePercent'
  | 'reorderQty'
  | 'isUnlimited'
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
 * - Opt-in — an effective floor of 0 (or less) means "off"; the item is never flagged
 *   (the friction-free default, until the user sets a positive reorder point).
 * - DISCRETE — low when on-hand `quantity` is at/below the effective quantity floor.
 * - CONSUMABLE_GAUGE — low when the gauge's percentage remaining is at/below the
 *   effective gauge floor (a gauge with no usable capacity is never "low").
 * - SERIALISED — a single asset is never "low bulk stock", matching the feed exclusion.
 * - UNTRACKED — presence-only items have no quantity to run low, matching the feed
 *   exclusion (its permanent quantity of 0 would otherwise always flag).
 * - Unlimited supply (Phase 82) — an effectively infinite source never runs low, whatever
 *   its stored quantity, so it is never flagged and never joins the shopping list.
 */
export function isLow(item: ReorderItem, defaults: ReorderDefaults): boolean {
  if (item.isUnlimited) return false;
  if (item.trackingMode === 'CONSUMABLE_GAUGE') {
    if (!item.gauge || item.gauge.grossCapacity <= 0) return false;
    const floor = effectiveGaugePercent(item, defaults);
    if (floor <= 0) return false; // opt-in: an off (0) gauge floor never flags
    return item.gauge.percentageRemaining <= floor;
  }
  if (item.trackingMode === 'SERIALISED' || item.trackingMode === 'UNTRACKED') return false;
  const floor = effectiveQtyThreshold(item, defaults);
  if (floor <= 0) return false; // opt-in: an off (0) quantity floor never flags
  return item.quantity <= floor;
}

/**
 * Coarse stock-health band for a plain DISCRETE item, for the Visual card's hero (spec §3):
 * - `out` — nothing on hand (`quantity <= 0`).
 * - `low` — on hand but at/below the effective reorder point ({@link isLow}).
 * - `healthy` — comfortably in stock.
 *
 * Unlimited-supply items are always `healthy` (an infinite source never runs low). Only
 * meaningful for DISCRETE items — the card only consults it on that branch.
 */
export type StockLevel = 'out' | 'low' | 'healthy';

export function discreteStockLevel(item: ReorderItem, defaults: ReorderDefaults): StockLevel {
  if (item.isUnlimited) return 'healthy';
  if (item.quantity <= 0) return 'out';
  return isLow(item, defaults) ? 'low' : 'healthy';
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
