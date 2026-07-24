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

/**
 * The date-input convention for a **loan due date** — a different rule from the midnight-UTC
 * pair above, and deliberately so.
 *
 * A due date is a *deadline in the user's own day*: a loan due "20 July" should read as due on
 * the 20th and only count as overdue once the 20th has ended where the borrower lives. So the
 * two rules here are local, not UTC:
 *
 * - {@link fromDueDateInputValue} anchors the picked day at **local end-of-day** (23:59:59), so
 *   the `due_date < now` overdue test stays false until the local day is actually over.
 * - {@link toDueDateInputValue} reads that instant back as the **local** calendar day, so it is
 *   the exact inverse — reopening the renew editor shows the day that was saved.
 *
 * A due date is deliberately the odd one out: a *deadline* is anchored to the borrower's own day,
 * unlike the midnight-UTC convention every other day-grained value uses (see `startOfUtcDay` in
 * `@/lib/calendar-days` — bookings included, issue #320). Do not route due dates through
 * {@link fromDateInputValue}/{@link toDateInputValue}: midnight UTC would both flag a loan overdue a
 * day early in the Americas and render its due date a day early.
 */
export function fromDueDateInputValue(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = new Date(`${trimmed}T23:59:59`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Read a due-date instant back as the `yyyy-MM-dd` local calendar day it falls on, or `''`. */
export function toDueDateInputValue(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
