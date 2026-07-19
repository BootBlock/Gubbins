/**
 * The single monetary-rounding seam (issue #288).
 *
 * Before this module, money was rounded in exactly two arbitrary places — a sale total and a
 * BOM extended cost — at two different scales, with an algorithm that was biased in practice.
 * Every other figure (valuation totals, insurance subtotals, purchase-order estimated value,
 * spend and sales buckets, budget roll-ups) was unrounded at every stage, so a stored amount
 * and any aggregate that recomputed it could disagree by a penny.
 *
 * This module owns the two rules that fix that, and nothing else — no React, no repository, no
 * SQL, no DOM — so both are exhaustively unit-testable in isolation (the same "logic out of
 * glue" seam as `valuation.ts` / `reorder-policy.ts`):
 *
 *  1. **One algorithm.** {@link roundMoney} is unbiased half-away-from-zero at a stated number
 *     of decimals. Nothing else in the codebase may hand-roll `Math.round(n * 100) / 100`.
 *  2. **Round at the boundary, not per step.** {@link sumMoney} adds the raw values and rounds
 *     the *total* once, so a total never disagrees with itself depending on which order the
 *     rounding and the addition happened in.
 *
 * **Where rounding belongs.** A figure is rounded when it is *published* — persisted to the
 * ledger, exported to a file, or handed to the UI as a headline/subtotal/bucket. Intermediate
 * arithmetic stays at full precision. That keeps the two sides of a derived figure (a sale's
 * proceeds and its cost of goods, say) on the same scale, which is what makes a margin add up.
 */

/** Decimal places a currency amount carries. Money is quantised to the minor unit (pence). */
export const MONEY_DECIMALS = 2;

/**
 * Round `value` to `decimals` places, **half away from zero**.
 *
 * Two things make this different from the `Math.round(n * 100) / 100` it replaces:
 *
 * - **The scaled value is corrected before the tie is broken.** `value * factor` is itself
 *   inexact — `1.005 * 100` is `100.49999999999999`, so a bare `Math.round` rounds *down* and
 *   loses a penny that half-up owes upward. Re-reading the scaled value at 15 significant
 *   digits (a float64 round-trips at 15) collapses that representation error back onto the
 *   decimal the user actually entered, so `1.005`, `8.165` and `2.675` all round up as a
 *   person expects rather than one-up-one-down at the mercy of binary drift.
 * - **Ties go away from zero, not toward +Infinity.** `Math.round(-1.005 * 100)` is `-100`
 *   (i.e. `-1.00`); currency convention wants `-1.01`, symmetric with the positive case, so a
 *   refund is not quietly rounded in the house's favour.
 *
 * Non-finite input passes through untouched — callers guard for `NaN`/`Infinity` themselves,
 * and silently turning one into a number would hide the bug rather than surface it.
 */
export function roundMoney(value: number, decimals: number = MONEY_DECIMALS): number {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  const corrected = Number((value * factor).toPrecision(15));
  const rounded = Math.sign(corrected) * Math.round(Math.abs(corrected));
  // `+ 0` normalises the `-0` that a small negative rounds to, so a zeroed total never renders
  // as "-£0.00".
  return rounded / factor + 0;
}

/**
 * Sum currency amounts and round the **total** once, at full precision throughout.
 *
 * This is the "split total" rule: three sales of 3 units at £0.10 must total `0.90`, not the
 * `0.8999999999999999` that summing pre-rounded lines produces. Rounding each addend first and
 * adding second gives a different answer from adding first and rounding second, and the second
 * is the one that matches what the amounts actually were. Non-finite addends are skipped so one
 * bad row cannot turn an entire report's total into `NaN`.
 */
export function sumMoney(values: Iterable<number>, decimals: number = MONEY_DECIMALS): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) total += value;
  }
  return roundMoney(total, decimals);
}
