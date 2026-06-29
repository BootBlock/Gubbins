import { useState } from 'react';
import { Button, Input, Spinner } from '@/components/foundry';
import { AddIcon, DeleteIcon } from '@/components/icons';
import { useFormatters } from '@/lib/useFormatters';
import { summariseBudgetCategory, type BudgetCategorySummary } from '../budget';
import type { ProjectBudgetCategoryRollup } from '@/db/repositories';
import { useAddBudgetCategory, useRemoveBudgetCategory } from '../projects';
import { BudgetMeter } from './BudgetMeter';
import { BUDGET_STATUS_TEXT } from './projects-ui';

/**
 * Manage a project's optional budget categories (spec §4 budgeting): named sub-budget
 * buckets with their own allocation, each showing allocation-vs-spend. Casual users add
 * none; power users split the budget into Parts / Shipping / Labour / Tools, etc.
 */
export function BudgetCategoryEditor({
  projectId,
  categories,
  warnPercent,
}: {
  projectId: string;
  /** Category roll-ups (allocation + derived spend) from the budget summary. */
  categories: readonly ProjectBudgetCategoryRollup[];
  warnPercent: number;
}) {
  const addCategory = useAddBudgetCategory(projectId);
  const removeCategory = useRemoveBudgetCategory(projectId);
  const fmt = useFormatters();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const parsed = Number(amount);
    addCategory.mutate(
      { name: trimmed, amount: Number.isFinite(parsed) && parsed >= 0 ? parsed : 0 },
      {
        onSuccess: () => {
          setName('');
          setAmount('');
        },
      },
    );
  };

  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">Budget categories</h3>

      {categories.length > 0 ? (
        <ul className="mb-3 space-y-2">
          {categories.map((category) => {
            const summary = summariseBudgetCategory(category, warnPercent);
            return (
              <CategoryRow
                key={category.id}
                summary={summary}
                money={(n) => fmt.currency(n)}
                onRemove={() => removeCategory.mutate(category.id)}
                removing={removeCategory.isPending}
              />
            );
          })}
        </ul>
      ) : (
        <p className="mb-3 text-xs text-muted-foreground">
          No categories yet — add one to split the budget into buckets (optional).
        </p>
      )}

      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-field-gap block text-xs font-medium text-muted-foreground">Name</span>
          <Input
            placeholder="e.g. Shipping"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="category-name-input"
          />
        </label>
        <label className="w-28">
          <span className="mb-field-gap block text-xs font-medium text-muted-foreground">Amount</span>
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            data-testid="category-amount-input"
          />
        </label>
        <Button
          type="button"
          variant="outline"
          onClick={add}
          disabled={addCategory.isPending || !name.trim()}
          data-testid="add-category"
        >
          {addCategory.isPending ? <Spinner /> : <AddIcon />}
          Add
        </Button>
      </div>
    </section>
  );
}

function CategoryRow({
  summary,
  money,
  onRemove,
  removing,
}: {
  summary: BudgetCategorySummary;
  money: (n: number) => string;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <li className="rounded-lg border border-border/60 p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium">{summary.name}</span>
        <span className={`ml-auto text-xs tabular-nums ${BUDGET_STATUS_TEXT[summary.status]}`}>
          {money(summary.spent)} / {money(summary.amount)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive [&_svg]:size-4"
          aria-label={`Remove ${summary.name}`}
          onClick={onRemove}
          disabled={removing}
        >
          <DeleteIcon />
        </Button>
      </div>
      <BudgetMeter
        className="mt-2"
        fraction={summary.spentFraction}
        status={summary.status}
      />
    </li>
  );
}
