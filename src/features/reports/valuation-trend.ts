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
import { inTimeWindowEndInclusive } from './window-membership';

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

/**
 * One recorded manual revaluation, as the `revaluations` log stores it (issue #481). Only the
 * instant is needed: the marks say *where* a value was manually reset, never what the line would
 * have been had it been re-priced (see {@link RevaluationMark}).
 */
export interface RevaluationEvent {
  /** UNIX-ms the revaluation was recorded for — day-grained (midnight UTC) when set from the UI. */
  readonly revaluedAt: number;
}

/**
 * One "a value was manually reset here" mark on the trend line (issue #481), aggregated to a
 * **calendar day** (midnight UTC — the grain `revaluations.revalued_at` is written at by the
 * revaluation editor, so a day is the finest resolution the stored instant honestly carries).
 *
 * A mark carries no value. It deliberately does **not** re-price the line: the trend stays
 * anchored to the "Inventory value" headline and every point stays priced at each item's value as
 * it stands today (issue #399 settled that promise, issue #289 the anchor). A mark adds the
 * missing "something changed here" context without moving a single point.
 */
export interface RevaluationMark {
  /** Midnight-UTC of the day one or more revaluations were recorded on. */
  readonly at: number;
  /** How many revaluations were recorded that day, across all valued items. */
  readonly count: number;
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
  /**
   * In-window manual revaluations, aggregated per calendar day and ordered oldest first (issue
   * #481). Empty when none were recorded — or when the only value changes were `unit_cost` edits,
   * which the schema keeps no log of and so can never be marked.
   */
  readonly revaluations: readonly RevaluationMark[];
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
 * **Window membership ({@link inTimeWindowEndInclusive} — the *complement* of the forward
 * bucketing rule).** Only events with `windowStart < createdAt <= windowEnd` can move an in-window
 * boundary: an event at or before `windowStart` is not strictly after any boundary `>= windowStart`,
 * and an event strictly after `windowEnd` is never "now or earlier" for any in-window boundary. Both
 * are therefore ignored. This end-inclusive rule is deliberately opposite to the start-inclusive
 * {@link inTimeWindow} the forward reports use, because this module reconstructs *backward* from the
 * present — see `window-membership.ts` for why the two conventions differ.
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
 * **Revaluation marks (issue #481).** Any `revaluations` passed in are folded into
 * {@link ValuationTrendReport.revaluations} — one {@link RevaluationMark} per calendar day, counted,
 * oldest first — using the *same* end-inclusive window rule as the ledger events, so a mark can
 * never sit outside the drawn line. They annotate the line and never alter it: no value here is
 * derived from a revaluation, which is what keeps the right-hand endpoint on the headline.
 *
 * @param currentValue The present total inventory value (the anchor the line is reconstructed from).
 * @param events       The value-tagged ledger entries; order is irrelevant (sorted internally).
 * @param windowStart  UNIX-ms of the first boundary (inclusive).
 * @param windowEnd    UNIX-ms of the last boundary (inclusive); treated as "now".
 * @param points       Requested number of boundaries; clamped to `>= 2`.
 * @param revaluations Recorded manual revaluations; order is irrelevant (aggregated internally).
 */
export function buildValuationTrend(
  currentValue: number,
  events: readonly ValuationEvent[],
  windowStart: number,
  windowEnd: number,
  points: number,
  revaluations: readonly RevaluationEvent[] = [],
): ValuationTrendReport {
  const count = Math.max(2, Math.floor(points));
  // Inclusive even spacing: with `count` boundaries there are `count − 1` gaps between the ends.
  const span = windowEnd - windowStart;
  const step = span / (count - 1);

  // Only in-window events (windowStart < createdAt <= windowEnd) can affect any boundary; drop the
  // rest up front, then sort ascending so the descending sweep below can accumulate the tail-sum.
  const inWindow = events
    .filter((event) => inTimeWindowEndInclusive(event.createdAt, windowStart, windowEnd))
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
    revaluations: aggregateRevaluations(revaluations, windowStart, windowEnd),
  };
}

/** Milliseconds in a calendar day — the grain revaluation marks are aggregated to. */
const DAY_MS = 86_400_000;

/**
 * Group in-window revaluations into one counted {@link RevaluationMark} per calendar day, oldest
 * first (issue #481).
 *
 * **Why a day.** The revaluation editor writes `revalued_at` at **midnight UTC** through the
 * `lib/date-input` seam, so the stored instant already carries no time of day; flooring to the
 * UTC day is therefore not a loss of precision but a statement of the precision that exists, and
 * it lands each mark on exactly the day `Formatters.calendarDate` will render for it. It also
 * bounds the marks by the window length rather than by how many items were revalued at once.
 *
 * **Why the same window rule as the events.** {@link inTimeWindowEndInclusive} is what decides
 * which ledger entries move the line, so reusing it is what guarantees a mark can only ever fall
 * on a span the line actually covers. A non-finite instant is dropped rather than bucketed to
 * `NaN`.
 */
function aggregateRevaluations(
  revaluations: readonly RevaluationEvent[],
  windowStart: number,
  windowEnd: number,
): RevaluationMark[] {
  const byDay = new Map<number, number>();
  for (const revaluation of revaluations) {
    const at = revaluation.revaluedAt;
    if (!Number.isFinite(at)) continue;
    if (!inTimeWindowEndInclusive(at, windowStart, windowEnd)) continue;
    const day = Math.floor(at / DAY_MS) * DAY_MS;
    byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([at, count]) => ({ at, count }));
}
