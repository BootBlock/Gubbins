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
 * The local helpers do the arithmetic on the local *calendar* fields instead, so a day is always one
 * calendar day regardless of DST. Both are pure given the host time zone; callers that need a
 * fixed-duration span (converting an elapsed millisecond count *to* a number of days) still divide
 * by `MS_PER_DAY` — that is genuinely a duration, not a calendar step.
 *
 * ## Local vs UTC day-start
 *
 * {@link startOfLocalDay} answers a *wall-clock* question — "which calendar day is it for the user?"
 * — used for bucketing "today"/"this week" and for deadlines the borrower experiences locally.
 * {@link startOfUtcDay} answers a *storage* question: a day-grained value (a booking date, an expiry
 * date) is stored as the midnight-UTC instant of the calendar day the user picked, so it names the
 * same day everywhere rather than drifting a day across time zones (issue #320). Because a UTC day is
 * always exactly `MS_PER_DAY`, `startOfUtcDay(x) + MS_PER_DAY` is the next UTC midnight exactly — DST
 * never applies — so day-grained UTC values need no {@link addCalendarDays} equivalent.
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
 * Start of the **UTC** calendar day containing `ms` (midnight UTC, UNIX-ms) — the instant-based
 * sibling of `date-input`'s `fromDateInputValue` (which snaps a `yyyy-MM-dd` *string* to the same
 * instant). This is how every day-grained *stored* value is snapped: a booking date, like
 * `expiry_date`/`due_date` and the other day columns, records the midnight-UTC instant of the
 * calendar day the user picked, so it encodes the same day in every time zone rather than baking in
 * the author's offset (issue #320). Idempotent on a value already at midnight UTC.
 */
export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  d.setUTCHours(0, 0, 0, 0);
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
