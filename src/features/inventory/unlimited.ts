/**
 * Unlimited-supply pure seam (Phase 82).
 *
 * The single source of truth for the "infinite source" rules — an item whose supply is
 * effectively unlimited (tap water, mains air, a bulk sand pile). Modelled as a boolean
 * `isUnlimited` modifier on a DISCRETE item (never a fifth tracking mode); see the schema
 * CHECK in `v1-initial.ts`. Pure, no DB, no clock — so the UI, repositories and reports all
 * reuse one implementation of "is it infinite?" / "does consuming it move the ledger?"
 * rather than each hand-writing the check.
 */
import type { Item } from '@/db/repositories';

/** The glyph a quantity of "infinite supply" renders as, everywhere. Kept out of JSX literals. */
export const UNLIMITED_GLYPH = '∞';

/**
 * Narrow predicate: is this an unlimited-supply item? The stored `quantity` is meaningless
 * for such an item (its supply is infinite regardless), so callers gate on this, not on a
 * number.
 */
export function isUnlimited(item: Pick<Item, 'isUnlimited'>): boolean {
  return item.isUnlimited === true;
}

/**
 * Can this item supply `qty` units? Always `true` for an unlimited source (it can never run
 * short); otherwise the finite on-hand `quantity` must cover the request. Callers use this
 * instead of hand-writing the "is there enough?" comparison so the unlimited short-circuit
 * lives in one place.
 */
export function canSupply(item: Pick<Item, 'isUnlimited' | 'quantity'>, qty: number): boolean {
  if (isUnlimited(item)) return true;
  return item.quantity >= qty;
}

/**
 * The signed stock movement consuming `qty` units should apply to the `item_stock` /
 * `stock_batches` ledger. For an unlimited source this is **0** — there is nothing to
 * decrement, so consumption never trips the `quantity >= 0` CHECK or the FEFO
 * batch-exhaustion path (the `CONSUMED` activity-log entry is still written by the caller).
 * For a finite item it is the usual `-qty`. The one place the "don't decrement infinity"
 * rule lives.
 */
export function consumptionLedgerDelta(item: Pick<Item, 'isUnlimited'>, qty: number): number {
  return isUnlimited(item) ? 0 : -qty;
}

/** The minimal quantity formatter shape {@link formatQuantityDisplay} needs (a `useFormatters` subset). */
export interface QuantityFormatter {
  quantity(value: number): string;
}

/**
 * How an item's on-hand quantity should read: the {@link UNLIMITED_GLYPH} for an unlimited
 * source (the stored integer is ignored), else the formatted `quantity`. Keeps the ∞ glyph
 * out of component JSX so the display rule stays testable and consistent.
 */
export function formatQuantityDisplay(
  item: Pick<Item, 'isUnlimited' | 'quantity'>,
  fmt: QuantityFormatter,
): string {
  return isUnlimited(item) ? UNLIMITED_GLYPH : fmt.quantity(item.quantity);
}
