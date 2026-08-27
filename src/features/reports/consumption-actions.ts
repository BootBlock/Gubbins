/**
 * The single definition of "did this ledger entry consume stock?".
 *
 * Three panels on the Reports screen ask that question — the consumption rate, ABC analysis and
 * inventory turnover — and each used to answer it by looking at the *sign* of a delta and nothing
 * else. A sign alone cannot tell a sale from a loan: a DISCRETE check-out writes
 * `quantity_delta: -n` and its check-in writes the same magnitude back positive, so lending a tool
 * out weekly and getting it back every time netted to no change on hand while booking a year of
 * "consumption". ABC then ranked the most-*lent* items as the most-consumed (a signal to buy more
 * of them), and turnover reported a brisk turn on stock that never left (issue #571).
 *
 * Which action wrote the row is the only thing that separates the two, so the answer is a
 * vocabulary, kept here in one pure place rather than re-derived in each SQL query. Gubbins treats
 * lending as first-class, so an inventory used partly as a tool library depends on this line being
 * drawn once and drawn the same way everywhere.
 *
 * **Two dimensions, two lists.** A count of whole things and a gauge's material draw are different
 * quantities (issue #685), and they are written into different columns by different actions, so
 * each column carries its own action list. Neither list is the other's superset: `GAUGE_UPDATE`
 * only ever moves material, `SOLD` only ever moves units — and a `SOLD` row's `net_value_delta`
 * holds the sale **proceeds**, money rather than material, which is exactly the kind of row
 * {@link CONSUMPTION_MATERIAL_ACTIONS} exists to keep out of a material total. Today those proceeds
 * are always positive, so a sign test happens to exclude them; naming the actions makes it a
 * property of the vocabulary instead of an accident of which rows exist.
 *
 * **What is deliberately *not* consumption**, listed in {@link RECOVERABLE_STOCK_OUT_ACTIONS} so
 * the exclusions are as explicit as the inclusions: a check-out (expected back), a return to a
 * supplier (a refund reversing a receipt, not demand), and a disassembly (a kit turning back into
 * the components it was built from — the stock changes shape, it does not leave).
 *
 * This vocabulary does **not** govern the stock-movement chart. That report answers a different
 * question — what moved in and out of the shelves, whatever the reason — so a loan belongs in its
 * "out" bar and its return in the next "in" bar. The two panels sitting side by side are meant to
 * differ; only the three consumption panels have to agree with each other.
 */
import type { HistoryAction } from '@/db/repositories/constants';

/**
 * Actions whose **negative `quantity_delta`** is a count of whole units gone for good.
 *
 * - `QUANTITY_CHANGE` — a manual stock adjustment downwards, the plain "I used some" path (it is
 *   also what a disassembly's recovered components are booked back in with, but only positively).
 * - `CONSUMED` — parts drawn permanently into an assembly.
 * - `SOLD` / `WRITTEN_OFF` — stock out for a commercial reason, with proceeds or without.
 * - `RECONCILED` — a negative cycle-count variance: stock that was already gone, discovered.
 */
export const CONSUMPTION_UNIT_ACTIONS: readonly HistoryAction[] = [
  'QUANTITY_CHANGE',
  'CONSUMED',
  'SOLD',
  'WRITTEN_OFF',
  'RECONCILED',
];

/**
 * Actions whose **negative `net_value_delta`** is material drawn out of a gauge, measured in that
 * item's own `unit_of_measure`.
 *
 * `GAUGE_UPDATE` covers both a draw and the spill forced by shrinking a gauge's capacity below
 * what is in it (issue #69) — material with nowhere to sit is material gone. `CONSUMED` is the
 * gauge half of an assembly draw, written by the same code path that writes the unit half.
 */
export const CONSUMPTION_MATERIAL_ACTIONS: readonly HistoryAction[] = ['GAUGE_UPDATE', 'CONSUMED'];

/**
 * Actions that take stock off the shelf **without consuming it** — the explicit complement of the
 * two lists above, so the judgement is recorded rather than left as an absence.
 *
 * Each is expected back, or was never demand in the first place: a loan returns, a supplier return
 * reverses a receipt, and a disassembled kit becomes its own components again.
 */
export const RECOVERABLE_STOCK_OUT_ACTIONS: readonly HistoryAction[] = [
  'CHECKED_OUT',
  'RETURNED_TO_SUPPLIER',
  'DISASSEMBLED',
];

/**
 * A SQL `IN (…)` predicate over `column` for one of the action lists above, e.g.
 * `h.action IN ('QUANTITY_CHANGE', …)`.
 *
 * The values are inlined rather than bound because they are compile-time constants from a closed
 * vocabulary, never user input — the same way `ReportRepository` already inlines `'HISTORY_CLEARED'`
 * and `'RECONCILED'` — and because a bound list would have to build its own placeholder run and
 * thread the parameters through every caller's argument order.
 */
export function actionInSql(column: string, actions: readonly HistoryAction[]): string {
  return `${column} IN (${actions.map((a) => `'${a}'`).join(', ')})`;
}
