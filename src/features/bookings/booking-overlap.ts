/**
 * Asset-booking double-booking maths (Phase 78, fourth feature-gap audit — Wave 2 #2).
 *
 * Pure date-range arithmetic for the asset-booking calendar: deciding whether two
 * whole-day reservations of the same asset clash. A booking occupies an **inclusive**
 * range of whole local days — a booking from day 3 to day 5 occupies days 3, 4 and 5 —
 * and two bookings clash whenever those day-ranges intersect (the same single day in
 * both is already a clash). All functions are pure (no DB, no React, no DOM; clock-free
 * — every instant is a caller-supplied UNIX-ms), so the snapping and the overlap test are
 * exhaustively unit-testable in isolation, exactly like `agenda.ts`, `alerts.ts` and
 * `expiry.ts`.
 *
 * **Distinct from project reservations.** This is calendar *time* exclusivity — one asset,
 * one booker, for a span of days — not the §4 project *quantity* reservations
 * (`reserveStock`/`planReceipt`), which commit a number of units rather than blocking a
 * date range. The two never share maths.
 *
 * **Whole-day, inclusive, local.** Both ends snap to local midnight via
 * {@link startOfLocalDay} (mirroring the same-named helper in `agenda.ts`, defined here
 * independently so this seam stays self-contained), so partial-day clock times never cause
 * a same-day booking to be judged free. Adjacent days do **not** overlap: a booking ending
 * on day 3 and another starting on day 4 leave no shared day, so the asset is free.
 */

// ---------------------------------------------------------------------------
// Day snapping
// ---------------------------------------------------------------------------

/**
 * Local midnight (00:00:00.000) of the day containing `ms`, as a UNIX-ms instant.
 *
 * Mirrors the same-named helper in `agenda.ts`; defined independently here so this seam
 * carries no cross-feature import. Snapping to the *local* day (not UTC) means a booking is
 * judged against the user's calendar, so a clock time anywhere within a day collapses to the
 * one canonical day-start instant.
 */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Day ranges
// ---------------------------------------------------------------------------

/**
 * A whole-day reservation span. Both `start` and `end` are local day-start UNIX-ms
 * instants (as produced by {@link startOfLocalDay}) and the range is **inclusive of both
 * days** — `start === end` is a legal single-day booking. Invariant: `end >= start`.
 */
export interface DayRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Snap an arbitrary start/end pair to a canonical {@link DayRange}: both ends are pushed to
 * their local day-start via {@link startOfLocalDay}, and if the snapped end falls before the
 * snapped start the two are swapped so the result always satisfies `end >= start`. This lets
 * a caller pass the two dates in either order.
 *
 * @throws RangeError if either input is not a finite number (NaN / ±Infinity).
 */
export function normaliseDayRange(startMs: number, endMs: number): DayRange {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new RangeError('A booking needs valid start and end dates.');
  }
  const a = startOfLocalDay(startMs);
  const b = startOfLocalDay(endMs);
  return b < a ? { start: b, end: a } : { start: a, end: b };
}

// ---------------------------------------------------------------------------
// Overlap test
// ---------------------------------------------------------------------------

/**
 * Inclusive whole-day overlap test for two day-start ranges. Returns `true` when the ranges
 * share at least one whole day. Both ranges are assumed already snapped to day-start
 * instants (so this is the classic `aStart <= bEnd && bStart <= aEnd` interval intersection).
 *
 * Because the ranges are *inclusive*, two bookings that share a single day clash (a ends day
 * 4, b starts day 4 → `true`), while two that merely abut on adjacent days do not (a ends day
 * 3, b starts day 4 → `false`).
 */
export function rangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * An existing booking to test a candidate against. `start`/`end` are day-start UNIX-ms
 * instants (an already-normalised {@link DayRange}); `id` identifies the clashing booking so
 * the caller can surface or link to it.
 */
export interface OverlapCandidate {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Return the **first** existing booking (in input order) whose day-range overlaps
 * `candidate` per {@link rangesOverlap}, or `null` when none clash. Input order is preserved,
 * so a caller wanting the earliest-created clash simply passes `existing` in creation order.
 */
export function findFirstOverlap(
  candidate: DayRange,
  existing: readonly OverlapCandidate[],
): OverlapCandidate | null {
  for (const booking of existing) {
    if (rangesOverlap(candidate.start, candidate.end, booking.start, booking.end)) {
      return booking;
    }
  }
  return null;
}
