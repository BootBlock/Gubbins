/**
 * DST-safe calendar-day arithmetic — the single home for "add N calendar days" and "start of the
 * local calendar day", so every window, interval and cutoff in the app measures a day the same way
 * (issue #325).
 *
 * ## Why not `+ N * 86_400_000`
 *
 * A day is not always 86,400,000 ms. In any time zone that observes daylight saving, two days a
 * year are 23 or 25 hours long, so adding a fixed `MS_PER_DAY` drifts by the DST offset whenever a
 * transition falls inside the span:
 *
 *  - anchored at a local midnight (`startOfLocalDay(x) + MS_PER_DAY`), the result lands at 23:00 or
 *    01:00 rather than the *next* local midnight — so a booking whose last day ends as the clocks go
 *    back reads "overdue" an hour before its final day is out;
 *  - anchored at an arbitrary instant (a 30-day maintenance interval), the due instant slips an hour
 *    earlier or later in local terms at each crossing, and over years of re-servicing that drifts
 *    across a whole day boundary.
 *
 * These helpers do the arithmetic on the local *calendar* fields instead, so a day is always one
 * calendar day regardless of DST. Both are pure given the host time zone; callers that need a
 * fixed-duration span (converting an elapsed millisecond count *to* a number of days) still divide
 * by `MS_PER_DAY` — that is genuinely a duration, not a calendar step.
 */

/**
 * Start of the local calendar day containing `ms` (local midnight, UNIX-ms). The canonical
 * definition — the day-window seams (`agenda.ts`, `booking-overlap.ts`) re-export this one rather
 * than each keeping their own copy, so "which midnight" can never drift between them.
 */
export function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * `ms` shifted by `days` whole calendar days, preserving the local wall-clock time of day across
 * any DST transition in the span (issue #325). `days` may be negative to step backwards.
 *
 * Operates on the local date field (`setDate`), which rolls month and year boundaries over
 * correctly and re-derives the UTC offset for the target day — so `addCalendarDays(localMidnight,
 * 1)` is always the *next* local midnight, never 23:00 the evening before, and a 30-day interval
 * lands at the same wall-clock time 30 calendar days on rather than an hour adrift.
 *
 * `days` is truncated to a whole number: a "calendar day" is a discrete unit here, and a fractional
 * offset would reintroduce exactly the fixed-duration arithmetic this exists to avoid.
 */
export function addCalendarDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + Math.trunc(days));
  return d.getTime();
}
