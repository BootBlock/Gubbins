/**
 * Overdue-loan display helpers (pure).
 *
 * A checkout is *overdue* when it is still open and its due date has passed — the same rule the
 * repository's {@link overdueCheckoutExistsSql} predicate and the derived `isOverdue` flag on
 * {@link CheckoutWithNames} express (`OPEN && dueDate !== null && dueDate < now`). These helpers
 * turn that raw "past its due date" state into the "how overdue" affordance shown on the
 * dashboard's Overdue widget and in the Upcoming agenda, so both surfaces read a late loan the
 * same way — as prominently as low stock reads its shortfall.
 *
 * Pure (`now` injected, no DB / React / clock), so the boundary is exhaustively unit-testable.
 */
import { MS_PER_DAY } from '@/db/repositories/constants';
import { plural } from '@/lib/plural';

/**
 * Whole days a loan is past its due date, floored to complete 24-hour periods and never
 * negative. A loan overdue by less than a full day (or not yet due) yields `0`; due exactly one
 * day ago yields `1`. Uses the same instant comparison as the SSOT overdue predicate rather than
 * calendar-day maths, so it can never disagree with whether a loan *is* overdue.
 */
export function daysOverdue(dueDate: number, now: number): number {
  return Math.max(0, Math.floor((now - dueDate) / MS_PER_DAY));
}

/**
 * Short human affordance for an overdue loan: `"3 days overdue"`, `"1 day overdue"`, or a plain
 * `"Overdue"` when it is past due by less than a full day (so the badge never reads
 * "0 days overdue").
 */
export function overdueLabel(days: number): string {
  return days <= 0 ? 'Overdue' : `${days} ${plural(days, 'day')} overdue`;
}
