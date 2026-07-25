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
 * **These rules are stated twice — here and in SQL — so they are tested against each other.**
 * `attention-sql.ts` holds the database half (`lowStockPredicateSql` /
 * `outOfStockPredicateSql`), and `stock-attention-parity.test.ts` seeds one deliberately
 * awkward inventory and asserts the two halves return the *same set* of items. That parity is
 * why every exclusion below has a counterpart there and vice versa; the abstract-variant-parent
 * exclusion was missing here for exactly as long as nothing compared them (issue #156).
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

/**
 * The reorder-relevant slice of an item — kept minimal so callers can pass any shape.
 *
 * `hasVariants` is part of that slice, not an optional extra: an abstract variant parent holds
 * no stock of its own and is excluded by every SQL attention predicate, so the pure seam needs
 * the same signal to reach the same answer. Requiring it means a caller that assembles its own
 * shape has to say which it is, rather than silently defaulting to "not a parent" — which is
 * how the two definitions drifted apart in the first place (issue #156).
 */
export type ReorderItem = Pick<
  Item,
  | 'trackingMode'
  | 'quantity'
  | 'gauge'
  | 'reorderPoint'
  | 'reorderGaugePercent'
  | 'reorderQty'
  | 'isUnlimited'
  | 'hasVariants'
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
 * - Abstract variant parent (issue #156) — an item with children holds no stock of its own,
 *   so its own `quantity` is not a stock level to run low. `setParent` attaches an existing
 *   item to a parent without clearing the parent's quantity or reorder point, so a
 *   once-ordinary item that is later made a parent keeps values that would otherwise flag.
 *   This is the exclusion `lowStockPredicateSql` applies with `notAVariantParentSql`.
 */
export function isLow(item: ReorderItem, defaults: ReorderDefaults): boolean {
  if (item.isUnlimited || item.hasVariants) return false;
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
 * Whether an item is **out of bulk stock** — fully depleted.
 *
 * Unlike {@link isLow} this is deliberately **not opt-in**: an item that has run to zero is out
 * whether or not a reorder point was ever configured, so it must never be gated behind `isLow`.
 * Mirrors `outOfStockPredicateSql` exactly — an unlimited-supply item is never out (its on-hand
 * count is ignored), an abstract variant parent is never out (it holds no stock of its own — its
 * variants do), a CONSUMABLE_GAUGE is out only once it has real capacity and has emptied, and
 * SERIALISED / UNTRACKED items have no bulk stock level to deplete so neither ever qualifies.
 */
export function isOutOfStock(item: ReorderItem): boolean {
  if (item.isUnlimited || item.hasVariants) return false;
  if (item.trackingMode === 'CONSUMABLE_GAUGE') {
    return item.gauge != null && item.gauge.grossCapacity > 0 && item.gauge.percentageRemaining <= 0;
  }
  if (item.trackingMode === 'SERIALISED' || item.trackingMode === 'UNTRACKED') return false;
  return item.quantity <= 0;
}

/**
 * Coarse stock-health band for a plain DISCRETE item, for the Visual card's hero (spec §3):
 * - `out` — nothing on hand (`quantity <= 0`).
 * - `low` — on hand but at/below the effective reorder point ({@link isLow}).
 * - `healthy` — comfortably in stock.
 *
 * Unlimited-supply items are always `healthy` (an infinite source never runs low), as are
 * abstract variant parents — a parent's own `quantity` is not a stock level, so badging its card
 * "Out of stock" while the dashboard and the reports omit it entirely is the disagreement issue
 * #156 is about. Only meaningful for DISCRETE items — the card only consults it on that branch.
 */
export type StockLevel = 'out' | 'low' | 'healthy';

export function discreteStockLevel(item: ReorderItem, defaults: ReorderDefaults): StockLevel {
  if (item.isUnlimited || item.hasVariants) return 'healthy';
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
