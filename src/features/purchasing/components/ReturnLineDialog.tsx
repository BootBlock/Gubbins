import { useId, useRef, useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal } from '@/components/foundry';
import { LocationSelect, type LocationOption } from '@/features/inventory/components/LocationSelect';
import type { PurchaseOrderLine } from '@/db/repositories';

/**
 * Return (refund) a single received PO line back to the supplier — the inverse of
 * {@link ReceiveLineDialog}. A partial return is allowed (defaulting to everything received on the
 * line); an optional source location says where the units are drawn from. The clamp/accumulate
 * arithmetic lives in the pure `planPoReturn` seam and the repository — this dialog only collects
 * the instalment. Design tokens only, British copy.
 */
export interface ReturnLineDialogProps {
  readonly open: boolean;
  readonly line: PurchaseOrderLine;
  /** Selectable source locations (value = id). Empty value = the item's primary home. */
  readonly locationOptions: readonly LocationOption[];
  readonly isSaving: boolean;
  readonly onSubmit: (input: { quantity?: number; locationId?: string }) => void;
  readonly onClose: () => void;
}

export function ReturnLineDialog({
  open,
  line,
  locationOptions,
  isSaving,
  onSubmit,
  onClose,
}: ReturnLineDialogProps) {
  const received = Math.max(0, line.receivedQty);
  const [quantity, setQuantity] = useState(String(received));
  const [locationId, setLocationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locationLabelId = useId();
  const quantityRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Enter a whole quantity greater than zero to return.');
      return;
    }
    if (qty > received) {
      setError(`You can return at most ${received} — only that many have been received.`);
      return;
    }
    onSubmit({ quantity: qty, locationId: locationId.length === 0 ? undefined : locationId });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Return to supplier"
      description={`${received} received on this line. Returning sends the units back and reduces the received quantity.`}
      initialFocusRef={quantityRef}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="po-return-form">
        <FormField
          label="Quantity to return"
          hint="Defaults to everything received on this line; a partial return is fine."
        >
          <Input
            ref={quantityRef}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            data-testid="po-return-qty"
          />
        </FormField>

        <FormField label="Return from location">
          <span id={locationLabelId} className="sr-only">
            Return from location
          </span>
          <LocationSelect
            value={locationId}
            onChange={setLocationId}
            options={locationOptions}
            labelledBy={locationLabelId}
          />
        </FormField>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="po-return-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="destructive" disabled={isSaving} data-testid="po-return-save">
            Return
          </Button>
        </div>
      </form>
    </Modal>
  );
}
