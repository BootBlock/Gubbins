import { useEffect, useState } from 'react';
import { Button, FormField, Input, Modal, Spinner, useToast } from '@/components/foundry';
import { useSetBudget } from '../projects';

/**
 * Set or clear a project's overall budget (spec §4 budgeting). An empty field clears the
 * budget (the feature is opt-in); a negative/blank value is treated as "no budget".
 */
export function SetBudgetDialog({
  open,
  onClose,
  projectId,
  currentBudget,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  currentBudget: number | null;
}) {
  const setBudget = useSetBudget();
  const { show } = useToast();
  const [value, setValue] = useState('');

  // Seed the field from the current budget whenever the dialog (re)opens.
  useEffect(() => {
    if (open) setValue(currentBudget == null ? '' : String(currentBudget));
  }, [open, currentBudget]);

  const submit = () => {
    const trimmed = value.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    const budget = parsed != null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    setBudget.mutate(
      { id: projectId, budget },
      {
        onSuccess: () => {
          show({
            tone: 'success',
            heading: budget == null ? 'Budget cleared' : 'Budget set',
            message:
              budget == null
                ? 'This project no longer has a budget.'
                : 'The project budget was updated.',
          });
          onClose();
        },
        onError: () =>
          show({ tone: 'danger', heading: 'Update failed', message: 'The budget was not saved.' }),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Project budget"
      description="Set an overall budget for this project, or clear the field to remove it."
    >
      <div className="space-y-4">
        <FormField label="Budget">
          <Input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            placeholder="e.g. 500"
            data-testid="budget-amount-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
        </FormField>
        <div className="flex justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setValue('')}
            disabled={setBudget.isPending || value.trim() === ''}
          >
            Clear budget
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose} disabled={setBudget.isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={setBudget.isPending} data-testid="budget-save">
              {setBudget.isPending ? <Spinner /> : null}
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
