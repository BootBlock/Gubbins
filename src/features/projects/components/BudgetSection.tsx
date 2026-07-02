import { useState } from 'react';
import { Button, Spinner, Surface, Tooltip, INFO_OPEN_DELAY_MS } from '@/components/foundry';
import { BudgetIcon, EditIcon } from '@/components/icons';
import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { useFormatters } from '@/lib/useFormatters';
import { summariseBudget } from '../budget';
import { useBudgetCategories, useProjectBudget } from '../projects';
import { BUDGET_STATUS_LABELS, BUDGET_STATUS_TEXT } from './projects-ui';
import { BudgetMeter } from './BudgetMeter';
import { BudgetCategoryEditor } from './BudgetCategoryEditor';
import { ExpenseLedger } from './ExpenseLedger';
import { SetBudgetDialog } from './SetBudgetDialog';

/**
 * The budgeting workspace for a project (spec §4 budgeting): the headline budget-vs-spend
 * meter and breakdown, the optional sub-budget categories, and the manual expense ledger.
 * All figures derive from the pure `summariseBudget` over the repository's raw aggregates.
 */
export function BudgetSection({ projectId }: { projectId: string }) {
  const budgetQuery = useProjectBudget(projectId);
  const categoriesQuery = useBudgetCategories(projectId);
  const warnPercent = usePreferencesStore((s) => s.budgetWarnPercent);
  const fmt = useFormatters();
  const [setBudgetOpen, setSetBudgetOpen] = useState(false);

  if (budgetQuery.isLoading || !budgetQuery.data) {
    return (
      <Surface className="flex items-center justify-center p-6">
        <Spinner />
      </Surface>
    );
  }

  const summary = summariseBudget(budgetQuery.data, warnPercent);
  const money = (n: number) => fmt.currency(n);
  const hasBudget = summary.budget != null;
  const categories = categoriesQuery.data ?? [];

  return (
    <div className="space-y-4">
      <Surface className="space-y-4 p-4" data-testid="budget-card">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-muted-foreground [&_svg]:size-4">
            <BudgetIcon />
            <span className="text-sm font-medium text-foreground">Budget</span>
          </div>
          {hasBudget ? (
            <span
              className={`text-xs font-medium ${BUDGET_STATUS_TEXT[summary.status]}`}
              data-testid="budget-status"
            >
              {BUDGET_STATUS_LABELS[summary.status]}
            </span>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => setSetBudgetOpen(true)}
            data-testid="set-budget"
          >
            <EditIcon />
            {hasBudget ? 'Edit budget' : 'Set a budget'}
          </Button>
        </div>

        {hasBudget ? (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-lg font-semibold tabular-nums" data-testid="budget-spent">
                {money(summary.totalSpent)}
                <span className="text-sm font-normal text-muted-foreground"> spent</span>
              </span>
              <span className="text-sm text-muted-foreground tabular-nums">of {money(summary.budget)}</span>
            </div>

            <BudgetMeter
              fraction={summary.spentFraction}
              projectedFraction={summary.projectedFraction}
              status={summary.status}
            />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
              <Figure label="Committed (BOM)" value={money(summary.committedFromBom)} />
              <Figure label="Expenses" value={money(summary.manualExpenseTotal)} />
              <Figure
                label={summary.remaining! >= 0 ? 'Remaining' : 'Over by'}
                value={money(Math.abs(summary.remaining!))}
                tone={BUDGET_STATUS_TEXT[summary.status]}
              />
              <Figure
                label="Projected total"
                value={money(summary.projectedFinalCost)}
                tone={BUDGET_STATUS_TEXT[summary.projectedStatus]}
                hint="Forecast final cost: the full BOM estimate plus all recorded expenses."
              />
            </dl>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No budget set. Spent so far:{' '}
            <span className="font-medium text-foreground tabular-nums">{money(summary.totalSpent)}</span> (
            {money(summary.committedFromBom)} parts + {money(summary.manualExpenseTotal)} expenses).
          </p>
        )}
      </Surface>

      <Surface className="space-y-6 p-4">
        <BudgetCategoryEditor
          projectId={projectId}
          categories={budgetQuery.data.categories}
          warnPercent={warnPercent}
        />
        <ExpenseLedger projectId={projectId} categories={categories} />
      </Surface>

      <SetBudgetDialog
        open={setBudgetOpen}
        onClose={() => setSetBudgetOpen(false)}
        projectId={projectId}
        currentBudget={summary.budget}
      />
    </div>
  );
}

function Figure({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  hint?: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {hint ? (
          <Tooltip content={hint} openDelayMs={INFO_OPEN_DELAY_MS}>
            <span className="cursor-help text-muted-foreground/70" aria-label={hint}>
              ⓘ
            </span>
          </Tooltip>
        ) : null}
      </dt>
      <dd className={`tabular-nums font-medium ${tone ?? 'text-foreground'}`}>{value}</dd>
    </div>
  );
}
