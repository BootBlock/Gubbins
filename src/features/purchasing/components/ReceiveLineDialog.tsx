import { useId, useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal } from '@/components/foundry';
import { LocationSelect, type LocationOption } from '@/features/inventory/components/LocationSelect';
import type { BatchIdentity } from '@/features/inventory/batches';
import type { PurchaseOrderLine } from '@/db/repositories';

/**
 * Receive a single PO line into stock (Inventory-depth Phase 62). A partial instalment is
 * allowed (defaulting to the whole outstanding remainder); an optional destination location
 * routes the received units there, and an optional batch/lot is recorded where the item is
 * batch-tracked. The clamp/accumulate arithmetic lives in the pure `planPoReceipt` seam and
 * the repository — this dialog only collects the instalment. Design tokens only, British copy.
 */
export interface ReceiveLineDialogProps {
  readonly open: boolean;
  readonly line: PurchaseOrderLine;
  /** Selectable destination locations (value = id). Empty value = the item's primary home. */
  readonly locationOptions: readonly LocationOption[];
  readonly isSaving: boolean;
  readonly onSubmit: (input: {
    quantity?: number;
    locationId?: string;
    batch?: BatchIdentity;
  }) => void;
  readonly onClose: () => void;
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function ReceiveLineDialog({
  open,
  line,
  locationOptions,
  isSaving,
  onSubmit,
  onClose,
}: ReceiveLineDialogProps) {
  const outstanding = Math.max(0, line.orderedQty - line.receivedQty);
  const [quantity, setQuantity] = useState(String(outstanding));
  const [locationId, setLocationId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locationLabelId = useId();

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Enter a whole quantity greater than zero to receive.');
      return;
    }
    const bn = optionalText(batchNumber);
    const ln = optionalText(lotNumber);
    const batch: BatchIdentity | undefined =
      bn !== null || ln !== null
        ? { batchNumber: bn, lotNumber: ln, expiryDate: null }
        : undefined;
    onSubmit({
      quantity: qty,
      locationId: locationId.length === 0 ? undefined : locationId,
      batch,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Receive into stock"
      description={`${outstanding} of ${line.orderedQty} still to arrive. Receiving lands the units in your inventory.`}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="po-receive-form">
        <FormField label="Quantity to receive" hint="Defaults to the whole outstanding remainder; a partial receipt is fine.">
          <Input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            data-testid="po-receive-qty"
            autoFocus
          />
        </FormField>

        <FormField label="Destination location">
          <span id={locationLabelId} className="sr-only">
            Destination location
          </span>
          <LocationSelect
            value={locationId}
            onChange={setLocationId}
            options={locationOptions}
            labelledBy={locationLabelId}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Batch number" hint="Optional — for batch/lot-tracked parts.">
            <Input
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              placeholder="—"
              data-testid="po-receive-batch"
            />
          </FormField>
          <FormField label="Lot number" hint="Optional.">
            <Input value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} placeholder="—" />
          </FormField>
        </div>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="po-receive-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={isSaving} data-testid="po-receive-save">
            Receive
          </Button>
        </div>
      </form>
    </Modal>
  );
}
