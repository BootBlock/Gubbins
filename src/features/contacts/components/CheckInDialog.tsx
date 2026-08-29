import { useEffect, useRef, useState } from 'react';
import { Button, FormField, Input, Modal, SelectField, Textarea } from '@/components/foundry';
import { CheckInIcon } from '@/components/icons';
import type { CheckoutWithNames, Condition } from '@/db/repositories';
import { conditionSelectOptions } from '@/features/inventory/components/inventory-ui';
import { useCheckInItem } from '../contacts';
import { useErrorMessage } from '@/features/errors';
import { useT } from '@/features/i18n';

/**
 * Check a loaned item back in (spec §4 Borrowing, B2 "condition on return").
 *
 * A returned tool is frequently in a *different* state than when it went out — blunt,
 * chipped, now due calibration — so the return is more than a one-tap stock restore. This
 * dialog optionally captures the item's **condition on return** (which updates the item and
 * logs a `CONDITION_CHANGED` alongside the check-in) and a free-text **return note** (which
 * lands in the checkout's own `return_note` column, never clobbering the loan note — B1).
 *
 * A loan of several units can also come back in **instalments** (issue #662): lend six drill bits,
 * get two back today and four next week. The quantity field appears only when there is more than
 * one unit to choose between, and defaults to everything still out — so submitting straight away
 * returns the whole loan exactly as it always did, and the fast path is preserved.
 *
 * Both the condition and the note are optional and default to "no change".
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
  const t = useT();
  const checkIn = useCheckInItem();
  // '' = leave the condition unchanged (the untracked/blank row); any real Condition updates it.
  const [condition, setCondition] = useState<Condition | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const describeError = useErrorMessage();
  const noteRef = useRef<HTMLTextAreaElement>(null);

  // What is still with the borrower, and how much of it this return is handing back. The default
  // is everything outstanding, so the dialog opens on the whole-loan return it always performed.
  const outstanding = checkout.quantity - checkout.returnedQuantity;
  const [quantity, setQuantity] = useState(outstanding);

  // A single dialog instance is reused across loans (the parent swaps `checkout` rather than
  // remounting), so the default has to follow the loan it is showing — otherwise the second loan
  // opened inherits the first one's count.
  useEffect(() => setQuantity(outstanding), [checkout.id, outstanding]);

  const submit = () => {
    setError(null);
    checkIn.mutate(
      {
        checkoutId: checkout.id,
        // Only send a note/condition when the user actually filled them in — an empty submit
        // is a pure one-tap return that touches neither the loan note nor the item's condition.
        note: note.trim() || undefined,
        condition: condition || undefined,
        // Likewise the quantity: returning everything outstanding is what an omitted quantity
        // already means, so the whole-loan return sends no quantity at all.
        quantity: quantity < outstanding ? quantity : undefined,
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
      busy={checkIn.isPending}
    >
      <div className="space-y-4">
        {outstanding > 1 ? (
          <div>
            <FormField label={t('contacts.checkin.quantityLabel')} hint={t('contacts.checkin.quantityHint')}>
              <Input
                type="number"
                // Clamped-on-keystroke controlled field: it cannot hold an intermediate
                // expression, so the micro-calculator is opted out here, exactly as the
                // checkout's own quantity field is (issue #93).
                calc={false}
                min={1}
                max={outstanding}
                value={quantity}
                data-testid="checkin-quantity"
                onChange={(e) => setQuantity(Math.max(1, Math.min(outstanding, Number(e.target.value) || 1)))}
              />
            </FormField>
            {/* The caption sits outside the FormField, which clones a single control child. */}
            <span className="mt-1 block text-xs text-muted-foreground">
              {t(
                checkout.returnedQuantity > 0
                  ? 'contacts.checkin.stillOutOfLoan'
                  : 'contacts.checkin.stillOut',
                { vars: { outstanding, quantity: checkout.quantity } },
              )}
            </span>
          </div>
        ) : null}

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
            sizeKey="contact.checkin-note"
            autoGrow
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
            {quantity < outstanding
              ? t('contacts.checkin.submitPartial', { vars: { quantity } })
              : t('contacts.checkin.submit')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
