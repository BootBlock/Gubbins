import { useMemo, useState } from 'react';
import { Button, Spinner } from '@/components/foundry';
import { AddIcon, DeleteIcon, EditIcon, ExpenseIcon } from '@/components/icons';
import type { ProjectBudgetCategory, ProjectExpense } from '@/db/repositories';
import { useFormatters } from '@/lib/useFormatters';
import { useExpenses, useRemoveExpense } from '../projects';
import { ExpenseDialog } from './ExpenseDialog';

/**
 * The manual expense ledger for a project (spec §4 budgeting): a dated list of recorded
 * costs with add / edit / remove, each optionally filed under a budget category.
 */
export function ExpenseLedger({
  projectId,
  categories,
}: {
  projectId: string;
  categories: readonly ProjectBudgetCategory[];
}) {
  const expensesQuery = useExpenses(projectId);
  const removeExpense = useRemoveExpense(projectId);
  const fmt = useFormatters();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ProjectExpense | null>(null);

  const categoryName = useMemo(() => {
    const map = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (map.get(id) ?? 'Uncategorised') : 'Uncategorised');
  }, [categories]);

  const rows = expensesQuery.data?.rows ?? [];

  const openAdd = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (expense: ProjectExpense) => {
    setEditing(expense);
    setDialogOpen(true);
  };

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4">
          <ExpenseIcon />
          Expenses
          <span className="text-xs font-normal text-muted-foreground">(recorded spend)</span>
        </h3>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={openAdd}
          data-testid="add-expense"
        >
          <AddIcon />
          Add expense
        </Button>
      </div>

      {expensesQuery.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No expenses recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((expense) => (
                <tr key={expense.id} className="border-t border-border/60">
                  <td className="px-3 py-2">{expense.description ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {categoryName(expense.categoryId)}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {fmt.date(expense.incurredAt)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmt.currency(expense.amount)}</td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1 [&_svg]:size-4">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${expense.description ?? 'expense'}`}
                        onClick={() => openEdit(expense)}
                      >
                        <EditIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove ${expense.description ?? 'expense'}`}
                        disabled={removeExpense.isPending}
                        onClick={() => removeExpense.mutate(expense.id)}
                      >
                        <DeleteIcon />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ExpenseDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        projectId={projectId}
        categories={categories}
        expense={editing}
      />
    </section>
  );
}
