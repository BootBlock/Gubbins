/**
 * The one rule for "what is this item's on-hand stock worth?" as the **card surfaces** ask it —
 * the item card's `value` field, its corner badge, and the Visual-card hero metric.
 *
 * All three used to state the rule themselves, and each stated it slightly differently. That was
 * survivable while the answer was always `unitCost × quantity`, and stopped being survivable when
 * a gauge gained a second axis (issue #683): the field would print a spool's £10.00 while the
 * badge beside it on the same card printed nothing. One function, three callers, no third
 * variation.
 *
 * It differs from the reports' `stockValue` seam (`@/features/reports/reports`) in exactly one
 * way, deliberately: a report **totals** many items, so an unpriced one contributes 0 and the
 * count of unpriced items is surfaced separately. A card shows **one** item, where "£0.00" and
 * "no price recorded" are different statements and printing the first for the second is the
 * misreading this whole issue is about. So this returns `null` — "nothing meaningful to show",
 * which every caller renders as an em-dash — rather than zero.
 */
import type { Item } from '@/db/repositories';

/**
 * The item's total on-hand value, or `null` when there is no meaningful figure.
 *
 * `null` covers three distinct cases:
 *  - **Unlimited supply** (Phase 82) — the quantity is ∞-ignored, so `cost × count` is undefined
 *    for an infinite source, exactly as the valuation reads exclude it (`notUnlimited`).
 *  - **An unpriced item** — no usable `unitCost`, or for a gauge no `costPerUnitOfMeasure`.
 *  - **A gauge with no gauge state** — a malformed row that cannot be valued either way.
 *
 * A gauge is valued from its **contents**, never from `unitCost`: that prices one *countable*
 * unit, and a gauge holds a measure, so reading it per gram would be wrong by whatever the
 * container's capacity happens to be. Its count is always 0, which is why the ordinary product
 * used to render a full cylinder as £0.00.
 */
export function itemTotalValue(item: Item): number | null {
  if (item.isUnlimited) return null;
  if (item.trackingMode === 'CONSUMABLE_GAUGE') {
    const perUnit = item.gauge?.costPerUnitOfMeasure;
    if (item.gauge == null || perUnit == null || !Number.isFinite(perUnit)) return null;
    return Math.max(0, item.gauge.currentNetValue) * perUnit;
  }
  if (item.unitCost == null || !Number.isFinite(item.unitCost)) return null;
  return item.unitCost * item.quantity;
}
