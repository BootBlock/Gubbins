import { useEffect, useRef, useState } from 'react';
import { Button, FormField, Input, Modal, SelectField, Spinner, useToast } from '@/components/foundry';
import type { ProjectBudgetCategory, ProjectExpense } from '@/db/repositories';
import { useAddExpense, useUpdateExpense } from '../projects';

/** Convert a UNIX-ms timestamp to a `yyyy-mm-dd` value for a date input (local time). */
function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a `yyyy-mm-dd` date input back to UNIX-ms (local midnight); null when blank/invalid. */
function fromDateInput(value: string): number | null {
  if (!value) return null;
  const ms = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Add or edit a manual expense in a project's spend ledger (spec §4 budgeting). Captures a
 * description, amount, optional budget category and the date the cost was incurred. Passing
 * an `expense` switches the dialog to edit mode.
 */
export function ExpenseDialog({
  open,
  onClose,
  projectId,
  categories,
  expense,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  categories: readonly ProjectBudgetCategory[];
  /** When set, the dialog edits this expense instead of adding a new one. */
  expense?: ProjectExpense | null;
}) {
  const addExpense = useAddExpense(projectId);
  const updateExpense = useUpdateExpense(projectId);
  const { show } = useToast();
  const editing = Boolean(expense);
  const pending = addExpense.isPending || updateExpense.isPending;
  const descriptionRef = useRef<HTMLInputElement>(null);

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [incurred, setIncurred] = useState(() => toDateInput(Date.now()));
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setDescription(expense?.description ?? '');
    setAmount(expense ? String(expense.amount) : '');
    setCategoryId(expense?.categoryId ?? '');
    setIncurred(toDateInput(expense?.incurredAt ?? Date.now()));
  }, [open, expense]);

  const submit = () => {
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Enter a non-negative amount.');
      return;
    }
    const input = {
      description: description.trim() || null,
      amount: parsed,
      categoryId: categoryId || null,
      incurredAt: fromDateInput(incurred) ?? Date.now(),
    };
    const onSuccess = () => {
      show({
        tone: 'success',
        heading: editing ? 'Expense updated' : 'Expense added',
        message: 'The project ledger was updated.',
      });
      onClose();
    };
    const onError = () =>
      show({ tone: 'danger', heading: 'Save failed', message: 'The expense was not saved.' });

    if (editing && expense) {
      updateExpense.mutate({ expenseId: expense.id, input }, { onSuccess, onError });
    } else {
      addExpense.mutate(input, { onSuccess, onError });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? 'Edit expense' : 'Add expense'}
      description="Record a cost against this project — parts, shipping, labour or anything else."
      initialFocusRef={descriptionRef}
    >
      <div className="space-y-4">
        <FormField label="Description">
          <Input
            ref={descriptionRef}
            placeholder="e.g. PCB fabrication"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Amount" error={error}>
            <Input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              data-testid="expense-amount-input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </FormField>
          <FormField label="Date">
            <Input type="date" value={incurred} onChange={(e) => setIncurred(e.target.value)} />
          </FormField>
        </div>
        <SelectField
          label="Category (optional)"
          value={categoryId}
          onChange={setCategoryId}
          options={[
            { value: '', label: '— Uncategorised —' },
            ...categories.map((c) => ({ value: c.id, label: c.name })),
          ]}
        />
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending} data-testid="expense-save">
            {pending ? <Spinner /> : null}
            {editing ? 'Save changes' : 'Add expense'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
