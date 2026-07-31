/**
 * Custom-field **due date** maths (W1a), kept pure and isolated — the sibling of `expiry.ts`
 * and `maintenance.ts`, and shared by exactly the same kinds of caller: the alert-centre lane,
 * the Upcoming agenda lane and their tests.
 *
 * ## What this is for
 *
 * A custom `DATE` field used to be inert: readable on the item form, on cards, in search, in
 * exports and over the bridge, but incapable of raising anything. So a user-defined "Renewal
 * date", "Inspection due" or "Substrate decay" recorded a deadline that nothing ever acted on.
 *
 * The opt-in is `field_defs.due_lead_days` — see {@link FIELD_DUE_LEAD_DAYS_MIN}. It lives on
 * the **definition** rather than the value because not every date is a deadline ("Date
 * acquired" is not), and deadline-ness is a property of what the field *means*, which in this
 * schema is its name.
 *
 * ## Day-grained, local-calendar comparisons
 *
 * A `DATE` field's value is a canonical `YYYY-MM-DD` string, so it names a **calendar day**,
 * not an instant; the storage convention snaps it to midnight UTC like every other day-grained
 * value (issue #320). Both comparisons here therefore re-anchor the stored day onto the local
 * calendar with `utcDayToLocalDay` (issue #323) before comparing whole days — so a date of
 * "20 July" reads as due all through 20 July wherever the user is, and never flips overdue on
 * the evening of the 19th. The forward edge steps with `addCalendarDays` rather than a fixed
 * 24-hour multiple, so a lead time spanning a clock change stays on the right day (issue #325).
 *
 * The SQL pre-filter (`ItemRepository.listFieldDueDates`) expresses the same window as
 * `value <= date(:today, '+N days')` over the stored `YYYY-MM-DD` strings — literally "the due
 * day is within N calendar days of today". The two must keep agreeing: SQL narrows the read,
 * this classifies what comes back, and a disagreement would show a row with no status or drop
 * one that has one.
 */
import { FIELD_DUE_LEAD_DAYS_MAX, FIELD_DUE_LEAD_DAYS_MIN } from '@/db/repositories/constants';
import { addCalendarDays, startOfLocalDay, utcDayToLocalDay } from '@/lib/calendar-days';

/**
 * How a custom-field due date stands relative to now:
 * - `NONE` — no date recorded (nothing to say).
 * - `SCHEDULED` — beyond the field's lead time; known about, not yet worth raising.
 * - `DUE_SOON` — within the lead time, up to and including the day itself.
 * - `OVERDUE` — the day has passed in the viewer's local calendar.
 */
export type FieldDueStatus = 'NONE' | 'SCHEDULED' | 'DUE_SOON' | 'OVERDUE';

/**
 * Clamp a lead time to the range the schema's CHECK enforces, rounding a fractional input to a
 * whole number of days first. Used by the field editor so a typed value can never reach the
 * database as a constraint failure; the repository still validates, because a clamp is a UI
 * courtesy and not the rule.
 */
export function clampFieldDueLeadDays(days: number): number {
  if (!Number.isFinite(days)) return FIELD_DUE_LEAD_DAYS_MIN;
  return Math.min(FIELD_DUE_LEAD_DAYS_MAX, Math.max(FIELD_DUE_LEAD_DAYS_MIN, Math.round(days)));
}

/**
 * Classify one custom-field due date against `now`.
 *
 * @param dueAt    UNIX-ms midnight-UTC instant of the stored day; null/undefined ⇒ `NONE`.
 * @param leadDays The definition's notice period in calendar days (`0` = "on the day").
 * @param now      Current wall-clock instant (UNIX-ms). Injected, so this is deterministic.
 */
export function fieldDueStatus(
  dueAt: number | null | undefined,
  leadDays: number,
  now: number,
): FieldDueStatus {
  if (dueAt == null) return 'NONE';
  const dueDay = utcDayToLocalDay(dueAt);
  const today = startOfLocalDay(now);
  if (dueDay < today) return 'OVERDUE';
  if (dueDay <= addCalendarDays(today, clampFieldDueLeadDays(leadDays))) return 'DUE_SOON';
  return 'SCHEDULED';
}
