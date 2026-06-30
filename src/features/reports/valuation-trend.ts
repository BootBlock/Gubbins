/**
 * Pure reconstruction of total inventory value over time (advanced analytics, Phase 74).
 * Like its sibling {@link bucketMovement} in `src/features/reports/reports.ts`, this module is
 * kept free of React, repositories, SQL, the DOM and the clock so the maths is unit-tested in
 * isolation (Protocol Beta); `ReportRepository` pulls the minimal raw rows from SQLite and hands
 * them to this helper, and the UI shapes the resulting DTO with `useFormatters`.
 *
 * **Why reconstruct backward.** The app stores no historical value snapshots, only the *current*
 * total value and a value-tagged ledger. To draw "what was the inventory worth at time `t`?" we
 * therefore run the ledger in reverse: starting from the present total, we undo every value change
 * that happened *after* `t`. Each ledger event carries a pre-computed signed `valueDelta`
 * (`quantity_delta × effectiveUnitCost`), so this module needs no cost seam of its own — the cost
 * precedence has already been resolved upstream when the delta was recorded.
 */

/**
 * One value-tagged ledger entry. `valueDelta` is the signed change in total inventory value at
 * `createdAt` (positive = value rose, e.g. stock received; negative = value fell, e.g. stock
 * consumed), pre-computed by the repository as `quantity_delta × effectiveUnitCost` so this module
 * stays self-contained.
 */
export interface ValuationEvent {
  /** UNIX-ms of the ledger entry. */
  readonly createdAt: number;
  /** Signed value change at that instant (`quantity_delta × effectiveUnitCost`), pre-computed. */
  readonly valueDelta: number;
}

/** One reconstructed sample on the valuation trend line. */
export interface ValuationPoint {
  /** UNIX-ms of this sample boundary. */
  readonly at: number;
  /** Reconstructed total inventory value at `at`, clamped to `>= 0`. */
  readonly value: number;
}

/** The valuation-trend report: an evenly-spaced reconstructed line plus its headline deltas. */
export interface ValuationTrendReport {
  /** Start of the window (UNIX-ms) — `points[0].at`. */
  readonly windowStart: number;
  /** End of the window (UNIX-ms, "now") — `points[last].at`. */
  readonly windowEnd: number;
  /** The reconstructed samples, chronological `windowStart..windowEnd` inclusive; length = `points`. */
  readonly points: readonly ValuationPoint[];
  /** Value at the first boundary (`points[0].value`). */
  readonly startValue: number;
  /** Value at the last boundary (`points[last].value`), which equals the clamped `currentValue`. */
  readonly endValue: number;
  /** Net change across the window (`endValue − startValue`). */
  readonly changeValue: number;
}

/**
 * Reconstruct total inventory value across `[windowStart, windowEnd]` by reversing the value-tagged
 * ledger from the present `currentValue` backward.
 *
 * **Sampling.** Exactly `points` evenly-spaced boundaries are emitted, *inclusive* of both ends, so
 * `points[0].at === windowStart` and `points[last].at === windowEnd`. `points` is clamped to `>= 2`
 * (`Math.max(2, Math.floor(points))`) so there is always a start and an end to draw a line between.
 *
 * **Reconstruction.** For a boundary at instant `t`,
 * `value(t) = currentValue − Σ valueDelta for events where createdAt > t`. The comparison is
 * *strict*: an event exactly *on* a boundary `t` is not "after" `t`, so it does not reduce
 * `value(t)` — but it does reduce every *earlier* boundary. Consequently the final boundary
 * (`windowEnd`, treated as "now") reconstructs to `currentValue` (nothing in-window lies strictly
 * after it), and the first boundary reconstructs the window-start value.
 *
 * **Window membership (mirrors {@link bucketMovement}'s half-open rigour).** Only events with
 * `windowStart < createdAt <= windowEnd` can move an in-window boundary: an event at or before
 * `windowStart` is not strictly after any boundary `>= windowStart`, and an event strictly after
 * `windowEnd` is never "now or earlier" for any in-window boundary. Both are therefore ignored.
 *
 * **Clamping.** Each emitted `value` is clamped to `>= 0`. Imperfect or partial cost data could
 * otherwise let a reversed delta drive a reconstructed total negative, which is never a meaningful
 * valuation; the floor keeps the line readable without masking the underlying deltas (the
 * unclamped sum is purely internal).
 *
 * **Degenerate window.** When `windowEnd <= windowStart` the boundaries collapse onto a single
 * instant; the function still emits `points` boundaries (a sensible flat line) and never throws or
 * yields `NaN`.
 *
 * Runs in `O(points + events log events)`: events are sorted once by `createdAt`, then a single
 * descending sweep accumulates the tail-sum subtracted at each boundary.
 *
 * @param currentValue The present total inventory value (the anchor the line is reconstructed from).
 * @param events       The value-tagged ledger entries; order is irrelevant (sorted internally).
 * @param windowStart  UNIX-ms of the first boundary (inclusive).
 * @param windowEnd    UNIX-ms of the last boundary (inclusive); treated as "now".
 * @param points       Requested number of boundaries; clamped to `>= 2`.
 */
export function buildValuationTrend(
  currentValue: number,
  events: readonly ValuationEvent[],
  windowStart: number,
  windowEnd: number,
  points: number,
): ValuationTrendReport {
  const count = Math.max(2, Math.floor(points));
  // Inclusive even spacing: with `count` boundaries there are `count − 1` gaps between the ends.
  const span = windowEnd - windowStart;
  const step = span / (count - 1);

  // Only in-window events (windowStart < createdAt <= windowEnd) can affect any boundary; drop the
  // rest up front, then sort ascending so the descending sweep below can accumulate the tail-sum.
  const inWindow = events
    .filter((event) => event.createdAt > windowStart && event.createdAt <= windowEnd)
    .sort((a, b) => a.createdAt - b.createdAt);

  const boundaries: number[] = [];
  for (let i = 0; i < count; i += 1) {
    // The last boundary is pinned exactly to windowEnd to avoid any floating-point drift off "now".
    boundaries.push(i === count - 1 ? windowEnd : Math.round(windowStart + i * step));
  }

  // Sweep boundaries from latest to earliest, growing the "events strictly after this boundary"
  // tail-sum as the boundary moves back in time past each event. `value(t) = currentValue − tail`.
  const values = new Array<number>(count);
  let tailSum = 0;
  let eventIdx = inWindow.length - 1;
  for (let i = count - 1; i >= 0; i -= 1) {
    const at = boundaries[i] ?? windowEnd;
    // Fold in every event that lies strictly after this boundary (createdAt > at).
    while (eventIdx >= 0 && (inWindow[eventIdx]?.createdAt ?? -Infinity) > at) {
      tailSum += inWindow[eventIdx]?.valueDelta ?? 0;
      eventIdx -= 1;
    }
    // Clamp to >= 0: imperfect cost data could otherwise reverse a delta below zero.
    values[i] = Math.max(0, currentValue - tailSum);
  }

  const pointsOut: ValuationPoint[] = boundaries.map((at, i) => ({ at, value: values[i] ?? 0 }));
  const startValue = pointsOut[0]?.value ?? Math.max(0, currentValue);
  const endValue = pointsOut[pointsOut.length - 1]?.value ?? Math.max(0, currentValue);

  return {
    windowStart,
    windowEnd,
    points: pointsOut,
    startValue,
    endValue,
    changeValue: endValue - startValue,
  };
}
