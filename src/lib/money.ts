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

/**
 * Decimal places assumed when the currency is unknown — the majority case (GBP, USD, EUR) and
 * the safe default for a figure whose currency could not be resolved. Prefer
 * {@link moneyDecimals}, which reports what the *actual* base currency uses.
 */
export const MONEY_DECIMALS = 2;

/** Memoised per code — `Intl.NumberFormat` construction is heavyweight and this runs in loops. */
const decimalsByCode = new Map<string, number>();

/**
 * How many decimal places `currency` is actually written in — its **minor unit** (issue #292).
 *
 * Not every currency has hundredths. The yen has none (`¥302`, never `¥301.5`) and the Bahraini
 * dinar has three (1000 fils). Quantising to a flat 2dp therefore invents precision a JPY amount
 * cannot hold — a sale of 3 × ¥100.5 booked `301.5`, half a yen, which then displayed as `¥302`
 * and disagreed with itself — and destroys precision a BHD amount genuinely has.
 *
 * The digits come from live `Intl` currency data, so there is no hand-maintained table to drift
 * (and it is the same source `Formatters.currencyFractionDigits` reads, which is what keeps a
 * rounded figure and its rendered form on the same scale). An unknown, malformed or absent code
 * falls back to {@link MONEY_DECIMALS} rather than throwing — a report with no resolved currency
 * still totals, it just totals the way it always did.
 */
export function moneyDecimals(currency: string | null | undefined): number {
  const code = currency?.trim().toUpperCase();
  // Only three ASCII letters can be an ISO-4217 code; checking the shape first means a malformed
  // value costs nothing and never reaches the cache, which stays bounded by the ISO-4217 space.
  if (!code || !/^[A-Z]{3}$/.test(code)) return MONEY_DECIMALS;
  const cached = decimalsByCode.get(code);
  if (cached !== undefined) return cached;
  // A well-formed but unassigned code (`XBT`) is accepted by `Intl` and reports the generic 2.
  const digits =
    new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions()
      .maximumFractionDigits ?? MONEY_DECIMALS;
  decimalsByCode.set(code, digits);
  return digits;
}

/**
 * How far two currency figures may differ and still count as the same amount.
 *
 * Comparisons deliberately read *raw*, unrounded figures (see the module note above), which
 * leaves them exposed to the drift a float SUM accumulates: `56.20 + 71.90 + 71.90` is exactly
 * £200.00 in decimal but `200.00000000000003` as a double, so a bare `spent > budget` reports a
 * project that spent its budget to the penny as **over** it (issue #287).
 *
 * A nanopenny is the right floor for that tolerance from both directions: many orders of
 * magnitude above the drift a realistic chain of currency arithmetic accumulates, and many
 * orders below the smallest difference that is real money. Comparing rounded figures instead
 * would fix the drift but reintroduce the error #288 avoided — a spend of 199.996 quantises to
 * 200.00 and would cross a threshold it has not actually reached.
 */
export const MONEY_EPSILON = 1e-9;

/**
 * The floor is not enough on its own, because drift scales with magnitude: one step of a
 * double near £10,000,000 is already about 1.9e-9, so a large budget could accumulate past a
 * fixed nanopenny. Widening the tolerance in proportion keeps it ahead of the representation
 * while staying far under a penny for any amount this app will hold (at £10,000,000 it is a
 * hundredth of a penny).
 */
const RELATIVE_TOLERANCE = 1e-12;

/** How far either figure may drift, given the magnitude being compared against. */
function tolerance(limit: number): number {
  return Math.max(MONEY_EPSILON, Math.abs(limit) * RELATIVE_TOLERANCE);
}

/** Whether `value` is meaningfully greater than `limit` — drift alone never qualifies. */
export function moneyExceeds(value: number, limit: number): boolean {
  return value > limit + tolerance(limit);
}

/** Whether `value` has reached `limit` — a figure short of it by drift alone still counts. */
export function moneyReaches(value: number, limit: number): boolean {
  return value >= limit - tolerance(limit);
}

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

/**
 * Apportion `parts` to `decimals` places so the rounded rows sum **exactly** to `target`.
 *
 * Rounding each row on its own and rounding the whole are two different questions with two
 * different answers: a column of independently-rounded figures need not re-add to the headline
 * rounded from the raw total. At 2dp the gap is at most half a minor unit per row and effectively
 * theoretical; under a 0-decimal currency (issue #292) that same tolerance is half a *whole unit*
 * per row, so a twelve-row breakdown can visibly sum to ¥301 beside a ¥304 headline — a
 * discrepancy a reader can see and cannot reconcile (issue #400).
 *
 * This is the largest-remainder (Hamilton) apportionment that the insurance schedule's
 * single-partition "sum the rung below as printed" rule cannot express when the same money is split
 * several ways at once (by time *and* by category *and* by supplier): there is no one column to
 * total the headline from, so the construction runs the other way. The headline stays the accurate
 * figure, each row floors to its minor unit, and the remainder between the headline and the floored
 * rows is handed out one minor unit at a time to the rows with the largest fractional part — the
 * very rows a naive round would have carried up. When the independently-rounded rows already sum to
 * the target — the common case, and every set of 2dp figures that divides cleanly — the result is
 * byte-identical to rounding each row on its own, so nothing shifts needlessly.
 *
 * Intended for a set of **non-negative** parts that partition `target` (a breakdown of a total). A
 * non-finite part counts as 0; an empty `parts` yields an empty result whatever `target` is.
 */
export function apportionMoney(
  parts: readonly number[],
  target: number,
  decimals: number = MONEY_DECIMALS,
): number[] {
  const n = parts.length;
  if (n === 0) return [];
  const factor = 10 ** decimals;
  // Each row in minor units, corrected for binary drift exactly as roundMoney does before it
  // breaks a tie, so 1.005 and its kin land where a person reads them rather than one unit below.
  const scaled = parts.map((p) => (Number.isFinite(p) ? Number((p * factor).toPrecision(15)) : 0));
  const floors = scaled.map((s) => Math.floor(s));
  const sumFloor = floors.reduce((a, b) => a + b, 0);
  const targetMinor = Number.isFinite(target)
    ? Math.round(Number((target * factor).toPrecision(15)))
    : sumFloor;
  // Rows that must round up rather than down for the column to hit the target. Clamped to [0, n]:
  // with non-negative parts that partition the target this is already in range, and the clamp keeps
  // a stray float discrepancy between the target and the parts' own sum from handing out more +1s
  // than there are rows to receive them.
  const carriesUp = Math.min(n, Math.max(0, targetMinor - sumFloor));
  // Largest fractional remainder takes the +1 first; ties break by original index so the result is
  // deterministic and independent of any display sort the caller applies afterwards.
  const order = scaled
    .map((s, i) => ({ i, frac: s - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const rounded = floors.slice();
  for (let k = 0; k < carriesUp; k += 1) {
    const idx = order[k]!.i;
    rounded[idx] = (rounded[idx] ?? 0) + 1;
  }
  // `+ 0` normalises the `-0` a floored value can carry so a zeroed row never renders "-0".
  return rounded.map((r) => r / factor + 0);
}

/**
 * The fixed storage scale for monetary columns (issue #286): every money value is persisted as an
 * INTEGER number of **micro-units** — millionths of a major currency unit — rather than a binary
 * `REAL`. Six is the count of decimal places that scale preserves.
 *
 * **Why a fixed scale and not each currency's own minor unit (pence, cents, fils).** The base
 * currency is a mutable preference and a stored amount is a currency-agnostic *magnitude*,
 * reinterpreted under whatever currency is active — so literal minor units would corrupt every
 * value the instant the base currency changed (£1.50 persisted as `150` pence would read back as
 * ¥150). A single fixed scale sidesteps that entirely, sits above every real currency's minor unit
 * (the Bahraini dinar's three places included), and exactly holds the deliberate six-place
 * sub-penny precision that BOM part costs already use (`BOM_LINE_COST_DECIMALS`).
 *
 * **Why integer at all.** A `REAL` column cannot represent most decimal amounts exactly, so a
 * column summed £0.07 across 5,000 rows to `349.9999999999724`, not `350`, and the same six
 * amounts added in two orders were not `===`-equal. Integer micro-units are exact, and their SQL
 * `SUM` is exact and order-independent. Storage and arithmetic stay well inside the `2^53`
 * safe-integer range — a ceiling of ~9 billion major units, far beyond anything a home inventory
 * holds.
 *
 * The rest of the app works in major units on both sides of the repository boundary; only the
 * on-disk column and the SQL that aggregates it are in micro-units, converted here.
 */
export const MONEY_STORAGE_DECIMALS = 6;

/** The integer factor between a major unit and its stored micro-units (`1_000_000`). */
export const MONEY_STORAGE_SCALE = 10 ** MONEY_STORAGE_DECIMALS;

export function toStoredMoney(value: number): number;
export function toStoredMoney(value: number | null | undefined): number | null;
/**
 * Convert a major-unit amount — what the app works in everywhere above the repository boundary —
 * into the integer micro-units persisted to a money column. `null` / `undefined` / non-finite map
 * to `null` so an absent price stays absent and a stray `NaN` never becomes a spurious `0`.
 *
 * Rounding to the nearest micro-unit uses the same 15-significant-digit correction and
 * away-from-zero tie-break as {@link roundMoney}, so an amount a user typed lands on the integer
 * they meant rather than one-below at the mercy of binary drift.
 */
export function toStoredMoney(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const scaled = Number((value * MONEY_STORAGE_SCALE).toPrecision(15));
  // Away-from-zero, matching roundMoney: a negative amount (a refund, a budget over-run) rounds
  // symmetrically rather than toward +Infinity.
  return Math.sign(scaled) * Math.round(Math.abs(scaled));
}

export function fromStoredMoney(stored: number): number;
export function fromStoredMoney(stored: number | null | undefined): number | null;
/**
 * Convert the integer micro-units read from a money column back into the major-unit amount the
 * rest of the app expects — the exact inverse of {@link toStoredMoney} at the repository read
 * boundary. `null` / `undefined` / non-finite pass through as `null`.
 *
 * The single-argument `number` overload is for `NOT NULL` columns, whose stored integer is always
 * present, so a caller mapping into a non-nullable DTO field does not have to launder the type.
 */
export function fromStoredMoney(stored: number | null | undefined): number | null {
  if (stored == null || !Number.isFinite(stored)) return null;
  return stored / MONEY_STORAGE_SCALE;
}
