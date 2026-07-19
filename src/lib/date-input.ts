/**
 * The app-wide convention for `<input type="date">` values.
 *
 * A date input speaks calendar days (`yyyy-MM-dd`) while the database stores UNIX-ms instants,
 * so every date field needs a rule for *which* instant a bare calendar day means. Gubbins picks
 * **midnight UTC**, and this module is the single place that rule lives:
 *
 * - It round-trips exactly — {@link toDateInputValue} is the inverse of {@link fromDateInputValue},
 *   so reopening an editor always shows back the day that was saved, in every timezone.
 * - It matches how date-only TEXT columns (`items.acquired_at`, `warranty_expires_at`) are already
 *   read back, since `Date.parse` treats a timezone-less ISO date as UTC.
 *
 * The consequence that matters: two costs a user records against the same day carry the *same*
 * instant no matter which screen recorded them, so the spend and valuation-trend reports bucket
 * them together. Never re-derive these helpers locally — a private copy using local midnight
 * silently drifts by up to a day against every other date field in the app.
 */

/** Convert a UNIX-ms instant to the `yyyy-MM-dd` string an `<input type="date">` wants. */
export function toDateInputValue(ms: number | null): string {
  if (ms === null) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parse a `yyyy-MM-dd` date-input value to a UNIX-ms instant (midnight UTC), or null. */
export function fromDateInputValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The day it is *for the user*, as a date-input value — the default a "when did this happen?"
 * field should start on.
 *
 * Deliberately local, unlike the two above: which instant a day means is a storage question
 * (UTC), but which day it currently is, is a calendar question, and the calendar on the wall is
 * the local one. Passing `Date.now()` through {@link toDateInputValue} answers the wrong one of
 * those and offers a user east of UTC yesterday's date all morning.
 */
export function todayDateInputValue(now: number = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
