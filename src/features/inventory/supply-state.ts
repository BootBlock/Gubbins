/**
 * Per-item **supply state** (issue #88) — the procurement answer to "does this item need me
 * to do anything?", derived rather than stored.
 *
 * Gubbins already knows both halves of this independently: whether an item has fallen to its
 * reorder point ({@link isLow} / on-hand zero) and how much is inbound on an open purchase
 * order ({@link PurchaseOrderRepository.onOrderQtyForItem}). What it lacked was a *name* for
 * the combination, so each surface re-derived its own ad-hoc version — the Low Stock widget's
 * "covered" dimming, the reorder editor's "N on order" note, the reorder-shortfall report's
 * netting. This seam is that name, and the SSOT those surfaces can converge on.
 *
 * **Deliberately not a stored column.** The two inputs are already authoritative elsewhere, so
 * a persisted `items.supply_state` would be a second source of truth for a fact the database
 * can already answer — free to drift the moment a PO is received or a reorder point edited.
 * Deriving it keeps one truth. (It also keeps the word "status" out of a vocabulary that
 * already spends it four ways: the inventory {@link ItemStatusFilter} chips, `items.condition`,
 * `projects.status` and `purchase_orders.status`.)
 *
 * Pure — no DB, no clock, no React — so the precedence rules below are exhaustively testable.
 */
import type { ReorderDefaults, ReorderItem } from './reorder-policy';
import { isLow, isOutOfStock, shortfall } from './reorder-policy';

/**
 * What an item's supply needs from the user right now:
 * - `on-order` — stock is already inbound on an open purchase order. Nothing to do; it is
 *   coming. Takes precedence over `needs-ordering` because "already ordered" is the answer to
 *   "should I order this?", even while on-hand stock is still low or zero.
 * - `needs-ordering` — at or below its reorder point (or out of stock entirely) with nothing
 *   inbound. The one state that asks for action.
 * - `stocked` — comfortably in stock, or not watched at all. The quiet default.
 */
export type SupplyState = 'on-order' | 'needs-ordering' | 'stocked';

/** The inputs one item's supply state is derived from. */
export interface SupplyInputs {
  /** The reorder-relevant slice of the item. */
  readonly item: ReorderItem;
  /** Global fallback reorder thresholds (the user-tunable Settings defaults). */
  readonly defaults: ReorderDefaults;
  /**
   * Units already inbound on an open (ORDERED / PARTIAL) purchase order — never negative.
   * Callers without purchase-order data (the capability is off, or the read is still pending)
   * pass 0, which simply means "nothing known to be inbound".
   */
  readonly onOrderQty: number;
}

/**
 * A resolved supply state plus the numbers the UI needs to say something specific about it —
 * so a caller can render "On order (×12)" or "Needs ordering (×4)" without re-deriving either.
 */
export interface ResolvedSupply {
  readonly state: SupplyState;
  /** Units inbound on an open purchase order; 0 unless `state` is `on-order`. */
  readonly onOrderQty: number;
  /**
   * Suggested top-up quantity — the item's own `reorderQty` when set, else the shortfall back
   * up to its effective reorder point ({@link shortfall}). 0 when nothing is suggested, which
   * includes every gauge item (a continuous measure has no countable top-up) and every item
   * that is not low.
   */
  readonly suggestedQty: number;
  /**
   * Whether enough is already inbound to clear {@link suggestedQty} — "handled, stop nagging".
   * The Low Stock widget de-emphasises a covered row, and the reorder plan nets the same
   * figure off what it suggests ordering. False whenever nothing is suggested (there is no
   * shortfall to cover) or nothing is inbound.
   */
  readonly covered: boolean;
}

/**
 * Resolve one item's supply state.
 *
 * Precedence is `on-order` → `needs-ordering` → `stocked`: anything genuinely inbound answers
 * the question first, so a low item with a live purchase order reads as handled rather than
 * nagging a second time for an order that already exists. Note the low-stock *alert* itself
 * deliberately stays on-hand-based (an inbound order does not put stock on the shelf), so a
 * covered item still appears in the Low Stock feed — this seam is the procurement view of the
 * same facts, not a replacement for them.
 */
export function resolveSupplyState({ item, defaults, onOrderQty }: SupplyInputs): ResolvedSupply {
  const inbound = Number.isFinite(onOrderQty) && onOrderQty > 0 ? onOrderQty : 0;
  const suggestedQty = shortfall(item, defaults);
  if (inbound > 0) {
    const covered = suggestedQty > 0 && inbound >= suggestedQty;
    return { state: 'on-order', onOrderQty: inbound, suggestedQty, covered };
  }
  if (isLow(item, defaults) || isOutOfStock(item)) {
    return { state: 'needs-ordering', onOrderQty: 0, suggestedQty, covered: false };
  }
  return { state: 'stocked', onOrderQty: 0, suggestedQty: 0, covered: false };
}
