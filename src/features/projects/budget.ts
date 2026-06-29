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
 */
import type { ProjectBudget, ProjectBudgetCategoryRollup } from '@/db/repositories';

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
 */
export function budgetStatus(
  value: number,
  limit: number | null,
  warnPercent: number,
): BudgetStatus {
  if (limit == null) return 'NONE';
  if (limit <= 0) return value > 0 ? 'OVER' : 'OK';
  if (value > limit) return 'OVER';
  if (value >= (limit * warnPercent) / 100) return 'WARN';
  return 'OK';
}

/** value / limit, or null when the limit is null or non-positive (avoids /0 and noise). */
export function spentFraction(value: number, limit: number | null): number | null {
  if (limit == null || limit <= 0) return null;
  return value / limit;
}

/** Roll one budget category up into its allocation-vs-spend summary. */
export function summariseBudgetCategory(
  category: ProjectBudgetCategoryRollup,
  warnPercent: number,
): BudgetCategorySummary {
  return {
    id: category.id,
    name: category.name,
    amount: category.amount,
    spent: category.spent,
    remaining: category.amount - category.spent,
    spentFraction: spentFraction(category.spent, category.amount),
    status: budgetStatus(category.spent, category.amount, warnPercent),
  };
}

/**
 * Compose the full {@link BudgetSummary} for a project from its raw {@link ProjectBudget}
 * aggregates and the user's warning threshold (a Tier-2 preference, so it is threaded in
 * rather than read from a store — keeping this module pure and testable).
 */
export function summariseBudget(facts: ProjectBudget, warnPercent: number): BudgetSummary {
  const totalSpent = facts.committedFromBom + facts.manualExpenseTotal;
  const projectedFinalCost = facts.estimatedCost + facts.manualExpenseTotal;
  const budget = facts.budget;
  return {
    budget,
    estimatedCost: facts.estimatedCost,
    committedFromBom: facts.committedFromBom,
    manualExpenseTotal: facts.manualExpenseTotal,
    totalSpent,
    remaining: budget == null ? null : budget - totalSpent,
    projectedFinalCost,
    projectedRemaining: budget == null ? null : budget - projectedFinalCost,
    spentFraction: spentFraction(totalSpent, budget),
    projectedFraction: spentFraction(projectedFinalCost, budget),
    warnPercent,
    status: budgetStatus(totalSpent, budget, warnPercent),
    projectedStatus: budgetStatus(projectedFinalCost, budget, warnPercent),
    categories: facts.categories.map((c) => summariseBudgetCategory(c, warnPercent)),
    uncategorisedExpenseTotal: facts.uncategorisedExpenseTotal,
  };
}
