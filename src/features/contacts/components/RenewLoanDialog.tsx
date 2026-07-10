import { useRef, useState } from 'react';
import { Button, FormField, Input, Modal } from '@/components/foundry';
import { DueDateIcon } from '@/components/icons';
import type { CheckoutWithNames } from '@/db/repositories';
import { fromDateInputValue, toDateInputValue } from '@/features/inventory/components/inventory-ui';
import { useRenewLoan } from '../contacts';

/**
 * Renew an open loan by changing its due date in place (spec §4 Borrowing, B3).
 *
 * Previously the only way to move a loan's due date was to check the item in and back out
 * again — losing the loan's continuity and its original checkout timestamp. This dialog edits
 * the due date directly: the open checkout keeps its identity and history, only `due_date`
 * changes, logged as a **Loan renewed** entry.
 *
 * The field is seeded with the loan's current due date. Clearing it (an empty date) is a valid
 * renew that turns a dated loan into an open-ended one.
 */
export function RenewLoanDialog({
  open,
  onClose,
  checkout,
}: {
  open: boolean;
  onClose: () => void;
  checkout: CheckoutWithNames;
}) {
  const renew = useRenewLoan();
  const [dueDate, setDueDate] = useState(() => toDateInputValue(checkout.dueDate));
  const [error, setError] = useState<string | null>(null);
  const dueDateRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    setError(null);
    renew.mutate(
      { checkoutId: checkout.id, dueDate: fromDateInputValue(dueDate) },
      {
        onSuccess: () => onClose(),
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not renew the loan.'),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Renew loan"
      description={`${checkout.itemName} — on loan to ${checkout.borrowerName}`}
      initialFocusRef={dueDateRef}
    >
      <div className="space-y-4">
        <FormField
          label="Due date"
          hint={
            'Change when this loan is due back without ending it — the loan keeps its original ' +
            'checkout date and history. Leave it empty for an open-ended loan with no due date.'
          }
        >
          <Input
            ref={dueDateRef}
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            data-testid="renew-due-date"
          />
        </FormField>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={renew.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={renew.isPending}>
            <DueDateIcon />
            Renew
          </Button>
        </div>
      </div>
    </Modal>
  );
}
