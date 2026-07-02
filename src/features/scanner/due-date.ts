/**
 * Borrowing due-date maths (spec §4 Due Dates, Phase 6).
 *
 * Pure helpers for turning a "due in N days" choice into a stored UNIX-ms timestamp
 * and for classifying an open checkout as due-soon / overdue, so the dashboard
 * "Overdue Items" tracker (§3) and the checkout UI share one tested implementation
 * with no clock hidden inside them (callers pass `now`).
 */

export const MS_PER_DAY = 86_400_000;

/** Lifecycle of an open checkout relative to its (optional) due date. */
export type DueStatus = 'NONE' | 'UPCOMING' | 'DUE_SOON' | 'OVERDUE';

/**
 * Convert a "due in `days` days" choice into an absolute UNIX-ms due date — simply
 * `from + days × MS_PER_DAY`. Returns `null` for a non-positive or non-finite day
 * count (i.e. "no due date").
 */
export function dueDateFromDays(days: number, from: number = Date.now()): number | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  return from + Math.round(days) * MS_PER_DAY;
}

/** Whole days remaining until `dueDate` (negative when overdue), rounded down. */
export function daysUntil(dueDate: number, now: number = Date.now()): number {
  return Math.floor((dueDate - now) / MS_PER_DAY);
}

/**
 * Classify a checkout's urgency. `dueDate` of `null` is `NONE`. Past due is
 * `OVERDUE`; within `dueSoonDays` (default 2) is `DUE_SOON`; otherwise `UPCOMING`.
 */
export function dueStatus(dueDate: number | null, now: number = Date.now(), dueSoonDays = 2): DueStatus {
  if (dueDate === null) return 'NONE';
  if (dueDate < now) return 'OVERDUE';
  if (dueDate - now <= dueSoonDays * MS_PER_DAY) return 'DUE_SOON';
  return 'UPCOMING';
}

/** True when an open checkout's due date has passed. */
export function isOverdue(dueDate: number | null, now: number = Date.now()): boolean {
  return dueDate !== null && dueDate < now;
}
