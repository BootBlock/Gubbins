/**
 * Pure project-budget maths (spec §4 budgeting, on top of §4 BOM Costing).
 *
 * Side-effect-free derivations over the raw aggregates the {@link ProjectRepository}
 * gathers (`getBudget`): the allotted budget, the live/snapshot BOM *estimate*, the
 * auto-derived *committed* BOM spend (`Σ received_qty × unit cost`) and the manual
 * *expense* ledger. Keeping the arithmetic here (not in the repo or a component) means
 * the spent/remaining/projected figures and the OK/WARN/OVER status are unit-tested in
 * one place and shared verbatim by the project detail card and the dashboard
 * budget-alerts widget — mirroring the `cycle-count.ts` / `dashboard-layout.ts`
 * "logic out of the glue" seam.
 *
 * ## The two spend lanes
 *  - **Committed (derived):** `Σ received_qty × unit cost` over the BOM — money already
 *    laid out on parts that have physically arrived. A projection over the BOM, never a
 *    stored counter, so it can never drift (the Phase-20 In-Transit pattern).
 *  - **Manual (ledger):** explicitly recorded {@link ProjectExpense} rows — shipping,
 *    labour, tools, miscellany the BOM cost cannot capture.
 *
 * `totalSpent` = committed + manual is "spent so far". `projectedFinalCost` =
 * *full* BOM estimate + manual is the forecast at completion (the committed spend is a
 * subset of the full estimate, so there is no double-count). Both get a status so the UI
 * can warn on what's spent *and* on where the project is heading.
 *
 * **Money is quantised once, at the summary boundary** (issue #288), through `@/lib/money` —
 * fractions and the OK/WARN/OVER classification deliberately read the *raw* figures, so a
 * threshold is never crossed by a rounding penny. Those raw comparisons go through
 * `moneyExceeds` / `moneyReaches` rather than bare `>` / `>=`, so the drift a float SUM carries
 * cannot decide a threshold either (issue #287). The *scale* it quantises to is the currency's
 * minor unit, threaded in as `decimals` rather than assumed to be two (issue #292).
 */
import type { ProjectBudget, ProjectBudgetCategoryRollup } from '@/db/repositories';
import { MONEY_DECIMALS, moneyExceeds, moneyReaches, roundMoney } from '@/lib/money';

/** Budget health: no budget set, comfortably under, nearing the line, or over. */
export type BudgetStatus = 'NONE' | 'OK' | 'WARN' | 'OVER';

/** A fully-derived budget summary for one project (the pure projection of {@link ProjectBudget}). */
export interface BudgetSummary {
  /** The allotted overall budget, or null when none is set (the feature is opt-in). */
  readonly budget: number | null;
  /** Live/snapshot full BOM cost (`ProjectCosting.totalCost` under the active mode). */
  readonly estimatedCost: number;
  /** Auto-derived `Σ received_qty × unit cost` — BOM parts already paid for. */
  readonly committedFromBom: number;
  /** Sum of the manual expense ledger. */
  readonly manualExpenseTotal: number;
  /** Spent so far = committed BOM + manual expenses. */
  readonly totalSpent: number;
  /** budget − totalSpent, or null when no budget is set. */
  readonly remaining: number | null;
  /** Forecast final cost = full BOM estimate + manual expenses. */
  readonly projectedFinalCost: number;
  /** budget − projectedFinalCost, or null when no budget is set. */
  readonly projectedRemaining: number | null;
  /** totalSpent / budget in [0, ∞), or null when no positive budget is set. */
  readonly spentFraction: number | null;
  /** projectedFinalCost / budget in [0, ∞), or null when no positive budget is set. */
  readonly projectedFraction: number | null;
  /** The warning threshold (percent) used to derive the statuses. */
  readonly warnPercent: number;
  /** Health of spend-so-far against the budget. */
  readonly status: BudgetStatus;
  /** Health of the *forecast* final cost against the budget. */
  readonly projectedStatus: BudgetStatus;
  /** Per-category roll-ups (empty when the project uses no sub-budgets). */
  readonly categories: readonly BudgetCategorySummary[];
  /** Manual spend not assigned to any category. */
  readonly uncategorisedExpenseTotal: number;
}

/** A budget category's allocation vs its recorded spend. */
export interface BudgetCategorySummary {
  readonly id: string;
  readonly name: string;
  /** The allocated sub-budget for this category. */
  readonly amount: number;
  /** Sum of the expenses assigned to this category. */
  readonly spent: number;
  /** amount − spent (may be negative when over-spent). */
  readonly remaining: number;
  /** spent / amount in [0, ∞), or null when the allocation is zero. */
  readonly spentFraction: number | null;
  readonly status: BudgetStatus;
}

/**
 * Classify a spend `value` against a `limit` (budget or category allocation). A null or
 * non-positive limit means "no meaningful target": status is `NONE` for a null limit, and
 * for a zero/negative limit any positive spend reads as `OVER` (else `OK`). Otherwise spend
 * over the limit is `OVER`, spend at/above `warnPercent`% of it is `WARN`, else `OK`.
 *
 * The figures stay raw and unrounded (issue #288), but each comparison carries a sub-penny
 * tolerance (issue #287). Both sides of the classification need it: spend that equals the
 * budget in decimal can exceed it as a float sum, and the derived threshold drifts too — 60% of
 * a £8.05 budget is £4.83, but computes to `4.830000000000001`, so a spend of exactly £4.83
 * would otherwise fall short of its own warning band. Neither is a real difference in money.
 */
export function budgetStatus(value: number, limit: number | null, warnPercent: number): BudgetStatus {
  if (limit == null) return 'NONE';
  if (limit <= 0) return moneyExceeds(value, 0) ? 'OVER' : 'OK';
  if (moneyExceeds(value, limit)) return 'OVER';
  if (moneyReaches(value, (limit * warnPercent) / 100)) return 'WARN';
  return 'OK';
}

/** The minimal budget figures a cross-project alert (`ProjectBudgetAlert`) carries. */
export interface BudgetAlertFigures {
  readonly budget: number;
  readonly committedFromBom: number;
  readonly manualExpenseTotal: number;
  readonly estimatedCost: number;
}

/** Whether a budgeted project is over budget and/or in the warning band. */
export interface ProjectBudgetHealth {
  /** Spend so far *or* projected final cost has passed the budget. */
  readonly over: boolean;
  /** Not yet over, but at/above the warning threshold on either measure. */
  readonly warn: boolean;
}

/**
 * Classify a budgeted project against both its **spend so far** (committed BOM + manual
 * expenses) and its **projected final cost** (full BOM estimate + manual expenses): `over` when
 * either has passed the budget, `warn` when either is merely in the warning band. The single
 * definition shared by the dashboard "Budget alerts" widget and the over-budget nav-tile count
 * (backlog A2), so the two can never drift.
 */
export function projectBudgetHealth(figures: BudgetAlertFigures, warnPercent: number): ProjectBudgetHealth {
  const spentSoFar = figures.committedFromBom + figures.manualExpenseTotal;
  const projectedFinalCost = figures.estimatedCost + figures.manualExpenseTotal;
  const status = budgetStatus(spentSoFar, figures.budget, warnPercent);
  const projectedStatus = budgetStatus(projectedFinalCost, figures.budget, warnPercent);
  return {
    over: status === 'OVER' || projectedStatus === 'OVER',
    warn: status === 'WARN' || projectedStatus === 'WARN',
  };
}

/** value / limit, or null when the limit is null or non-positive (avoids /0 and noise). */
export function spentFraction(value: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  return value / limit;
}

/**
 * Roll one budget category up into its allocation-vs-spend summary.
 *
 * @param decimals How many places to quantise the published figures to — the *currency's* minor
 * unit, not a flat two (issue #292). A yen budget is written in whole yen and a Bahraini-dinar one
 * in thousandths, so a fixed 2dp would print a category allocation the currency cannot hold. React
 * callers pass `useFormatters().currencyFractionDigits()`; the default keeps the pre-#292 behaviour
 * for callers that have no currency to hand.
 */
export function summariseBudgetCategory(
  category: ProjectBudgetCategoryRollup,
  warnPercent: number,
  decimals: number = MONEY_DECIMALS,
): BudgetCategorySummary {
  const amount = roundMoney(category.amount, decimals);
  const spent = roundMoney(category.spent, decimals);
  return {
    id: category.id,
    name: category.name,
    amount,
    spent,
    // Derived from the *published* pair, so the row a budget card prints subtracts correctly
    // (issue #288) — `roundMoney(raw amount − raw spent)` would show 0.03, 0.01 and 0.01.
    remaining: roundMoney(amount - spent, decimals),
    // Fractions and the status classification read the raw figures: a threshold decided on a
    // rounded penny would flip a project into WARN/OVER a fraction early.
    spentFraction: spentFraction(category.spent, category.amount),
    status: budgetStatus(category.spent, category.amount, warnPercent),
  };
}

/**
 * Compose the full {@link BudgetSummary} for a project from its raw {@link ProjectBudget}
 * aggregates and the user's warning threshold (a Tier-2 preference, so it is threaded in
 * rather than read from a store — keeping this module pure and testable).
 *
 * @param decimals How many places to quantise the published figures to — the *currency's* minor
 * unit, not a flat two (issue #292). Rounding a yen budget to 2dp publishes a "spent so far" of
 * ¥301.50 that renders as ¥302 and disagrees with the meter beside it; a Bahraini-dinar budget
 * loses its third digit outright. Because every derived figure is composed from the published
 * parts, quantising them all at the same scale is also what keeps the card's own arithmetic exact
 * (budget − spent really is remaining) whatever that scale is. React callers pass
 * `useFormatters().currencyFractionDigits()`; the default keeps the pre-#292 behaviour.
 */
export function summariseBudget(
  facts: ProjectBudget,
  warnPercent: number,
  decimals: number = MONEY_DECIMALS,
): BudgetSummary {
  const totalSpent = facts.committedFromBom + facts.manualExpenseTotal;
  const projectedFinalCost = facts.estimatedCost + facts.manualExpenseTotal;
  const budget = facts.budget;

  // Quantised once at this boundary (issue #288), and every *derived* amount is then composed
  // from the published parts rather than re-rounded from the raw ones — so a budget card's
  // committed + manual really does equal its "spent so far", and budget − spent really does
  // equal its "remaining". Rounding each figure independently from the raw values would leave
  // the card's own arithmetic a penny out.
  const publishedBudget = budget == null ? null : roundMoney(budget, decimals);
  const publishedEstimatedCost = roundMoney(facts.estimatedCost, decimals);
  const publishedCommitted = roundMoney(facts.committedFromBom, decimals);
  const publishedManual = roundMoney(facts.manualExpenseTotal, decimals);
  const publishedTotalSpent = roundMoney(publishedCommitted + publishedManual, decimals);
  const publishedProjected = roundMoney(publishedEstimatedCost + publishedManual, decimals);

  return {
    budget: publishedBudget,
    estimatedCost: publishedEstimatedCost,
    committedFromBom: publishedCommitted,
    manualExpenseTotal: publishedManual,
    totalSpent: publishedTotalSpent,
    remaining: publishedBudget == null ? null : roundMoney(publishedBudget - publishedTotalSpent, decimals),
    projectedFinalCost: publishedProjected,
    projectedRemaining:
      publishedBudget == null ? null : roundMoney(publishedBudget - publishedProjected, decimals),
    // Fractions and statuses read the raw figures — see `summariseBudgetCategory`.
    spentFraction: spentFraction(totalSpent, budget),
    projectedFraction: spentFraction(projectedFinalCost, budget),
    warnPercent,
    status: budgetStatus(totalSpent, budget, warnPercent),
    projectedStatus: budgetStatus(projectedFinalCost, budget, warnPercent),
    categories: facts.categories.map((c) => summariseBudgetCategory(c, warnPercent, decimals)),
    uncategorisedExpenseTotal: roundMoney(facts.uncategorisedExpenseTotal, decimals),
  };
}
