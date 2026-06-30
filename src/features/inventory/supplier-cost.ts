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
 */

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
