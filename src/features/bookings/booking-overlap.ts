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
 * **Whole-day, inclusive, midnight UTC.** Both ends snap to midnight UTC via the shared
 * {@link startOfUtcDay} helper (`@/lib/calendar-days`), so partial-day clock times never cause a
 * same-day booking to be judged free, and — critically — a booking encodes the *same* calendar day
 * everywhere, matching every other day-grained column in the schema (`expiry_date`, `due_date`, …).
 * Snapping to the local day instead (as this seam once did) baked the author's time zone into the
 * stored instant, so a booking made in one zone silently shifted a day when re-read in another
 * (issue #320). Adjacent days do **not** overlap: a booking ending on day 3 and another starting on
 * day 4 leave no shared day, so the asset is free.
 */
import { startOfUtcDay } from '@/lib/calendar-days';

// ---------------------------------------------------------------------------
// Day ranges
// ---------------------------------------------------------------------------

/**
 * A whole-day reservation span. Both `start` and `end` are midnight-UTC day-start UNIX-ms
 * instants (as produced by {@link startOfUtcDay}) and the range is **inclusive of both
 * days** — `start === end` is a legal single-day booking. Invariant: `end >= start`.
 */
export interface DayRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Snap an arbitrary start/end pair to a canonical {@link DayRange}: both ends are pushed to
 * their midnight-UTC day-start via {@link startOfUtcDay}, and if the snapped end falls before the
 * snapped start the two are swapped so the result always satisfies `end >= start`. This lets
 * a caller pass the two dates in either order.
 *
 * @throws RangeError if either input is not a finite number (NaN / ±Infinity).
 */
export function normaliseDayRange(startMs: number, endMs: number): DayRange {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new RangeError('A booking needs valid start and end dates.');
  }
  const a = startOfUtcDay(startMs);
  const b = startOfUtcDay(endMs);
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
export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
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

// ---------------------------------------------------------------------------
// Post-merge conflict resolution (issue #194)
// ---------------------------------------------------------------------------

/**
 * One active booking to rank when resolving a post-merge double-booking (issue #194). `start`
 * and `end` are day-start UNIX-ms instants (a normalised {@link DayRange}); `createdAt` is the
 * booking's creation instant and `id` its UUID — together the deterministic priority key.
 */
export interface BookingWindow {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly createdAt: number;
}

/** A booking cancelled by {@link resolveBookingConflicts}, and the kept booking it clashed with. */
export interface BookingCancellation {
  readonly id: string;
  /** The earlier-reserved booking whose slot this one overlapped. */
  readonly clashesWith: string;
}

/** The outcome of resolving one asset's overlapping bookings into a conflict-free set. */
export interface BookingConflictResolution {
  /** Ids kept — an earliest-first set with no two overlapping. */
  readonly kept: readonly string[];
  /** Ids cancelled, each paired with the kept booking it clashed with. */
  readonly cancelled: readonly BookingCancellation[];
}

/**
 * Deterministic booking priority: the **earlier-created** booking has the legitimate claim, ties
 * broken by the lexicographically smaller id so every device reaches the identical verdict without
 * reference to which side is "local". `createdAt` is safe to compare because it is never clock-frame
 * shifted on the wire (see `shiftSnapshotTimestamps`), so it is byte-identical everywhere.
 */
function compareBookingPriority(a: BookingWindow, b: BookingWindow): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * Reduce one asset's active bookings to a conflict-free set by cancelling the minimum needed
 * (issue #194). The read-then-write overlap guard in `AssetBookingRepository.create` holds only
 * within one device's database, so two devices booking the same asset for overlapping dates each
 * pass their local check and the id-keyed sync union keeps both — leaving the same unit reserved
 * twice over the same days. This is the deterministic post-merge repair.
 *
 * Bookings are ranked by {@link compareBookingPriority} (earliest-created first), then walked in
 * order: a booking is **kept** if it overlaps none already kept, else **cancelled** and paired with
 * the earlier booking it clashed with. Because overlap is not transitive (a Mon–Wed and a Fri–Sat
 * booking can both survive alongside a cancelled Wed–Fri one), this greedy keeps every booking that
 * does not actually clash with a surviving earlier one rather than blindly collapsing to a single
 * winner. Both devices run this same pure rule over the same union of rows and agree.
 */
export function resolveBookingConflicts(bookings: readonly BookingWindow[]): BookingConflictResolution {
  const ranked = [...bookings].sort(compareBookingPriority);
  const kept: BookingWindow[] = [];
  const cancelled: BookingCancellation[] = [];
  for (const booking of ranked) {
    const clash = kept.find((k) => rangesOverlap(booking.start, booking.end, k.start, k.end));
    if (clash) cancelled.push({ id: booking.id, clashesWith: clash.id });
    else kept.push(booking);
  }
  return { kept: kept.map((k) => k.id), cancelled };
}
