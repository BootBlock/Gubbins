import { useId, useRef, useState, type FormEvent } from 'react';
import { Button, FormField, Input, Modal } from '@/components/foundry';
import { LocationSelect, type LocationOption } from '@/features/inventory/components/LocationSelect';
import { batchIdentityFrom, type BatchIdentity } from '@/features/inventory/batches';
import type { PurchaseOrderLine, TrackingMode } from '@/db/repositories';
import { recordOnlyReceiptReason } from '@/features/projects/receipts';
import { fromDateInputValue } from '@/lib/date-input';

/**
 * Receive a single PO line into stock (Inventory-depth Phase 62). A partial instalment is
 * allowed (defaulting to the whole outstanding remainder); an optional destination location
 * routes the received units there, and an optional batch/lot/expiry is recorded where the item is
 * batch-tracked. The clamp/accumulate arithmetic lives in the pure `planPoReceipt` seam and
 * the repository — this dialog only collects the instalment. Design tokens only, British copy.
 *
 * Where the linked item's tracking mode holds no counted quantity (issue #608) the receipt is
 * *record-only*: it is written to the order and the item's Activity Log, and no stock moves. The
 * dialog says so rather than promising units into inventory, and drops the destination, batch,
 * lot and expiry fields — the repository discards all four on that path, so collecting them would
 * be asking for something nothing reads. Which modes land stock is the shared receipt seam's call,
 * not this dialog's, so the copy and the write cannot come to promise different things.
 */
export interface ReceiveLineDialogProps {
  readonly open: boolean;
  readonly line: PurchaseOrderLine;
  /** Selectable destination locations (value = id). Empty value = the item's primary home. */
  readonly locationOptions: readonly LocationOption[];
  /**
   * The linked item's tracking mode, when the line has one and it has loaded. Undefined for an
   * unlinked line (nothing to move stock into) and while the read is in flight; both are treated
   * as the ordinary stock-landing case, so a slow read never *adds* a warning that turns out to
   * be wrong — it only delays one.
   */
  readonly itemTrackingMode?: TrackingMode;
  readonly isSaving: boolean;
  readonly onSubmit: (input: { quantity?: number; locationId?: string; batch?: BatchIdentity }) => void;
  readonly onClose: () => void;
}

export function ReceiveLineDialog({
  open,
  line,
  locationOptions,
  itemTrackingMode,
  isSaving,
  onSubmit,
  onClose,
}: ReceiveLineDialogProps) {
  const outstanding = Math.max(0, line.orderedQty - line.receivedQty);
  // A reason and a record-only landing are the same statement (see `recordOnlyReceiptReason`), so
  // reading the reason answers both questions at once and leaves no branch for a record-only
  // receipt with nothing to explain — there is no such case.
  const recordOnlyReason = itemTrackingMode === undefined ? null : recordOnlyReceiptReason(itemTrackingMode);
  const recordOnly = recordOnlyReason !== null;
  const [quantity, setQuantity] = useState(String(outstanding));
  const [locationId, setLocationId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locationLabelId = useId();
  const quantityRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setError('Enter a whole quantity greater than zero to receive.');
      return;
    }
    // A record-only receipt reaches the repository as a bare quantity. The destination and the
    // batch identity are dropped rather than sent and discarded, so nothing downstream can read
    // a placement the units never took.
    if (recordOnly) {
      onSubmit({ quantity: qty });
      return;
    }
    // What makes an arrival a tracked lot — including the rule that a date on its own is enough —
    // is `batchIdentityFrom`'s to decide, so every receipt dialog answers it the same way.
    const batch = batchIdentityFrom(batchNumber, lotNumber, fromDateInputValue(expiryDate));
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
      title={recordOnly ? 'Record a receipt' : 'Receive into stock'}
      description={
        recordOnly
          ? `${outstanding} of ${line.orderedQty} still to arrive. Receiving records the delivery against this order; it does not change stock.`
          : `${outstanding} of ${line.orderedQty} still to arrive. Receiving lands the units in your inventory.`
      }
      initialFocusRef={quantityRef}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="po-receive-form">
        <FormField
          label="Quantity to receive"
          hint="Defaults to the whole outstanding remainder; a partial receipt is fine."
        >
          <Input
            ref={quantityRef}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            data-testid="po-receive-qty"
          />
        </FormField>

        {recordOnly ? (
          <p
            className="rounded-lg border border-border bg-secondary/50 p-3 text-sm text-muted-foreground"
            data-testid="po-receive-record-only"
          >
            No stock will be added, because {recordOnlyReason}. The delivery is recorded against this order
            and in the item&rsquo;s activity log.
          </p>
        ) : (
          <>
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

            <FormField
              label="Expiry date"
              hint="Optional — for perishables. Dated lots are used oldest-first and raise expiry alerts."
            >
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                data-testid="po-receive-expiry"
              />
            </FormField>
          </>
        )}

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
