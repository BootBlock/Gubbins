import { useRef, useState } from 'react';
import { Button, FormField, Modal, SelectField, Textarea } from '@/components/foundry';
import { CheckInIcon } from '@/components/icons';
import type { CheckoutWithNames, Condition } from '@/db/repositories';
import { conditionSelectOptions } from '@/features/inventory/components/inventory-ui';
import { useCheckInItem } from '../contacts';
import { useErrorMessage } from '@/features/errors';

/**
 * Check a loaned item back in (spec §4 Borrowing, B2 "condition on return").
 *
 * A returned tool is frequently in a *different* state than when it went out — blunt,
 * chipped, now due calibration — so the return is more than a one-tap stock restore. This
 * dialog optionally captures the item's **condition on return** (which updates the item and
 * logs a `CONDITION_CHANGED` alongside the check-in) and a free-text **return note** (which
 * lands in the checkout's own `return_note` column, never clobbering the loan note — B1).
 *
 * Both are optional and default to "no change": submitting straight away behaves exactly like
 * the previous one-tap return, so the fast path is preserved.
 */
export function CheckInDialog({
  open,
  onClose,
  checkout,
}: {
  open: boolean;
  onClose: () => void;
  checkout: CheckoutWithNames;
}) {
  const checkIn = useCheckInItem();
  // '' = leave the condition unchanged (the untracked/blank row); any real Condition updates it.
  const [condition, setCondition] = useState<Condition | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const noteRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    setError(null);
    checkIn.mutate(
      {
        checkoutId: checkout.id,
        // Only send a note/condition when the user actually filled them in — an empty submit
        // is a pure one-tap return that touches neither the loan note nor the item's condition.
        note: note.trim() || undefined,
        condition: condition || undefined,
      },
      {
        onSuccess: () => {
          setCondition('');
          setNote('');
          onClose();
        },
        onError: (e) => setError(describeError(e, 'Could not check the item back in.')),
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Return item"
      description={`${checkout.itemName} — on loan to ${checkout.borrowerName}`}
      initialFocusRef={noteRef}
    >
      <div className="space-y-4">
        <SelectField
          label="Condition on return (optional)"
          value={condition}
          onChange={(value) => setCondition(value as Condition | '')}
          data-testid="checkin-condition"
          hint={
            'Record the item’s state as it comes back. Leaving this unchanged keeps the item’s ' +
            'current condition; picking one updates it and logs a **Condition changed** entry in the ' +
            'item’s activity log.'
          }
          options={conditionSelectOptions('— No change —')}
        />

        <FormField label="Return note (optional)">
          <Textarea
            ref={noteRef}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. returned with a chipped blade, now due calibration"
          />
        </FormField>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={checkIn.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={checkIn.isPending}>
            <CheckInIcon />
            Return
          </Button>
        </div>
      </div>
    </Modal>
  );
}
