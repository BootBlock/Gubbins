/**
 * Cost-precedence resolution (spec §4 valuation; Inventory-depth Phase 60).
 *
 * An item can be valued two ways now there are supplier parts: the user's **manual**
 * `items.unitCost` (the explicit override), or the **preferred** supplier part's `unit_cost`.
 * The precedence is fixed and deliberately simple so it can never surprise:
 *
 *   1. a manual `items.unitCost` always wins (the user said so explicitly);
 *   2. else the preferred supplier part's `unitCost` (if one is marked and priced);
 *   3. else `null` (genuinely unpriced).
 *
 * Pure and dependency-free so it is exhaustively unit-tested and reused by Phase 61's
 * reporting/valuation. It takes only the fields it needs (not whole repository rows) so it
 * has no DB/clock coupling.
 *
 * When an **order quantity** is known (issue #37 — price breaks in the Order process), the
 * quantity-aware variants below refine the flat cost with the preferred supplier's tiered
 * price-breaks: a break's `unitCost` applies at its `qty` and above, mirroring how
 * distributors publish per-part quantity pricing.
 */
import type { PriceBreak } from '@/db/repositories';

/** The minimal item shape this helper reads. */
export interface CostItemLike {
  /** The user's manual unit cost override, or null if unset. */
  readonly unitCost: number | null;
}

/** The minimal supplier-part shape this helper reads. */
export interface CostSupplierPartLike {
  readonly unitCost: number | null;
  readonly isPreferred: boolean;
}

/** The minimal priced shape {@link unitCostForQty} reads: a flat cost plus its tiers. */
export interface QtyPricedLike {
  readonly unitCost: number | null;
  /** Quantity price-breaks, ascending by `qty`; empty when none recorded. */
  readonly priceBreaks: readonly PriceBreak[];
}

/** A preferred-flagged supplier-part shape carrying its tiered price-breaks. */
export interface PricedSupplierPartLike extends CostSupplierPartLike, QtyPricedLike {}

/** A non-negative finite number is a usable price; anything else is treated as unset. */
function usablePrice(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * The preferred supplier part among a list, or undefined. There is at most one (the
 * repository enforces the single-winner invariant), but this tolerates a malformed input
 * by taking the first preferred row it finds.
 */
export function preferredSupplierPart<T extends CostSupplierPartLike>(
  supplierParts: readonly T[],
): T | undefined {
  return supplierParts.find((p) => p.isPreferred);
}

/**
 * The effective per-unit cost for an item under the fixed precedence: a manual
 * `items.unitCost` wins, else the preferred supplier part's `unitCost`, else null.
 */
export function effectiveUnitCost(
  item: CostItemLike,
  supplierParts: readonly CostSupplierPartLike[],
): number | null {
  if (usablePrice(item.unitCost)) return item.unitCost;
  const preferred = preferredSupplierPart(supplierParts);
  if (preferred && usablePrice(preferred.unitCost)) return preferred.unitCost;
  return null;
}

/**
 * The supplier part's per-unit cost for an order of `orderedQty` units (issue #37). Starts
 * from the flat `unitCost` (the qty-1 list price) and applies the **highest** price-break
 * whose threshold `qty` is at or below `orderedQty` — the deeper the quantity, the lower the
 * unit cost. Breaks must be ascending by `qty` (the repository and mapper both guarantee
 * this); an empty list leaves the flat cost unchanged. Returns null when neither the flat
 * cost nor any qualifying break is a usable price.
 *
 * A non-integer or non-positive `orderedQty` qualifies no break, so the flat cost stands —
 * the caller validates the quantity separately.
 */
export function unitCostForQty(part: QtyPricedLike, orderedQty: number): number | null {
  let resolved: number | null = usablePrice(part.unitCost) ? part.unitCost : null;
  for (const b of part.priceBreaks) {
    // Ascending order: once a break's threshold exceeds the quantity, none after it qualify.
    if (b.qty > orderedQty) break;
    if (usablePrice(b.unitCost)) resolved = b.unitCost;
  }
  return resolved;
}

/**
 * The effective per-unit cost for an item ordering `orderedQty` units, under the same fixed
 * precedence as {@link effectiveUnitCost} but quantity-aware: a manual `items.unitCost` still
 * wins outright (an explicit valuation override, independent of quantity); otherwise the
 * preferred supplier part's {@link unitCostForQty tiered cost} for that quantity; else null.
 */
export function effectiveUnitCostForQty(
  item: CostItemLike,
  supplierParts: readonly PricedSupplierPartLike[],
  orderedQty: number,
): number | null {
  if (usablePrice(item.unitCost)) return item.unitCost;
  const preferred = preferredSupplierPart(supplierParts);
  if (preferred) return unitCostForQty(preferred, orderedQty);
  return null;
}
