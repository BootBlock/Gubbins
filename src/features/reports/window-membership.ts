/**
 * The single definition of "does this ledger instant fall inside the report window?".
 *
 * Every time-windowed analytics seam (`bucketMovement`, `summariseConsumption`, `buildSalesReport`,
 * `buildSpendReport`, `buildValuationTrend`) folds events across a `[windowStart, windowEnd]` span
 * and has to decide what happens to an event that lands *exactly* on a boundary. Off-by-one drift
 * there is the classic silent-money bug: one report would count a boundary transaction and another
 * would not, so spend and valuation totals disagree for the same window with no way to tell which is
 * right. Keeping the rule in one pure, dependency-free place — rather than re-deriving `event.x <
 * windowStart || event.x >= windowEnd` in each module — is what guarantees they cannot drift apart.
 *
 * There are **two** boundary conventions here, and they are deliberately different rather than an
 * inconsistency to reconcile:
 *
 *  - **Forward bucketing** ({@link inTimeWindow}) is half-open `[start, end)` — start-inclusive,
 *    end-exclusive. This is the convention for every report that sorts events *into* the window
 *    (movement, consumption, spend, sales): with `windowEnd` treated as "now", an event stamped
 *    exactly at "now" belongs to the *next* window, not this one, and adjacent windows tile without
 *    double-counting the shared edge.
 *  - **Backward reconstruction** ({@link inTimeWindowEndInclusive}) is half-open `(start, end]` —
 *    start-exclusive, end-inclusive. The valuation trend runs the ledger in reverse from the present
 *    total, so its question is "which events lie strictly *after* a boundary and must be undone?".
 *    There an event exactly on `windowStart` must not move the start boundary (it is not after it),
 *    and an event exactly on `windowEnd` ("now") is the present and must be undone for every earlier
 *    boundary. That is precisely the complement of the forward rule.
 *
 * The two predicates are exact complements at the boundaries and identical strictly inside the
 * window; `window-membership.test.ts` feeds identical boundary timestamps through both and asserts
 * that relationship, so the pairing can never quietly drift.
 */

/**
 * Forward, half-open window membership: `windowStart <= instant < windowEnd`.
 *
 * The convention for every seam that sorts events *into* time buckets. An event exactly on
 * `windowStart` is included; one exactly on `windowEnd` is excluded (it belongs to the next window),
 * so adjacent windows tile without double-counting their shared edge.
 */
export function inTimeWindow(instant: number, windowStart: number, windowEnd: number): boolean {
  return instant >= windowStart && instant < windowEnd;
}

/**
 * Backward, half-open window membership: `windowStart < instant <= windowEnd` — the exact complement
 * of {@link inTimeWindow} at the boundaries.
 *
 * The convention for the valuation trend's reverse reconstruction, where the question is which
 * events lie strictly *after* a given boundary. An event exactly on `windowStart` is excluded (it is
 * not after the start boundary); one exactly on `windowEnd` ("now") is included.
 */
export function inTimeWindowEndInclusive(instant: number, windowStart: number, windowEnd: number): boolean {
  return instant > windowStart && instant <= windowEnd;
}
