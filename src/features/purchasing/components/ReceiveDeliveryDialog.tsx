import { useId, useMemo, useState, type FormEvent } from 'react';
import { Button, Checkbox, FormField, Input, Modal } from '@/components/foundry';
import { LocationSelect, type LocationOption } from '@/features/inventory/components/LocationSelect';
import type { PurchaseOrderLine, PurchaseOrderLineReceipt, TrackingMode } from '@/db/repositories';
import { useT } from '@/features/i18n';
import { batchIdentityFrom } from '@/features/inventory/batches';
import { recordOnlyReason } from '@/features/projects/receipts';
import { fromDateInputValue } from '@/lib/date-input';
import { useFormatters } from '@/lib/useFormatters';

/**
 * Receive a whole delivery — every outstanding line of one purchase order — in a single pass
 * (issue #589).
 *
 * The common delivery is "the box arrived and everything in it is here", which the per-line
 * `ReceiveLineDialog` could only express as one modal round-trip per line, with the destination
 * and any batch re-entered every time. So this dialog inverts the defaults: every outstanding line
 * arrives ticked with its whole remainder filled in, and the destination, batch, lot and expiry are
 * asked **once** and applied across the delivery. Correcting an exception — a short shipment, a
 * line that did not arrive — is editing one row rather than repeating the whole flow.
 *
 * It collects only; the clamp/accumulate arithmetic stays in the pure `planPoReceipt` seam and the
 * repository, which commits the whole delivery as one transaction. The per-line dialog stays for
 * the one-off correction, and both send the same shape of instalment.
 *
 * A line whose item holds no counted quantity is *record-only* (issue #608): it can still be
 * received, but the shared destination and batch are not sent with it — the repository discards
 * them on that path, so passing them would record a placement the units never took. The row says
 * so rather than leaving the shared fields looking as though they applied.
 */

/** One outstanding line offered for receipt, with what the dialog needs to describe it. */
export interface DeliveryLine {
  readonly line: PurchaseOrderLine;
  /** How the line is named on screen — the matched item's name, else its typed description. */
  readonly label: string;
  /**
   * The linked item's tracking mode, when the line has one and it has loaded. Undefined for an
   * unlinked line and while the read is in flight; both read as the ordinary stock-landing case,
   * so a slow read never *adds* a warning that turns out to be wrong.
   */
  readonly trackingMode?: TrackingMode;
}

export interface ReceiveDeliveryDialogProps {
  readonly open: boolean;
  /** The order's outstanding lines, in the order they are listed on screen. */
  readonly lines: readonly DeliveryLine[];
  /** Selectable destination locations (value = id). Empty value = the item's primary home. */
  readonly locationOptions: readonly LocationOption[];
  readonly isSaving: boolean;
  readonly onSubmit: (receipts: readonly PurchaseOrderLineReceipt[]) => void;
  readonly onClose: () => void;
}

/** What one row of the delivery holds while it is being edited. */
interface RowState {
  readonly include: boolean;
  readonly quantity: string;
}

/** Units still to arrive on a line, floored at zero. */
function outstandingOf(line: PurchaseOrderLine): number {
  return Math.max(0, line.orderedQty - line.receivedQty);
}

export function ReceiveDeliveryDialog({
  open,
  lines,
  locationOptions,
  isSaving,
  onSubmit,
  onClose,
}: ReceiveDeliveryDialogProps) {
  const t = useT();
  const f = useFormatters();
  const [rows, setRows] = useState<ReadonlyMap<string, RowState>>(new Map());
  const [locationId, setLocationId] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const locationLabelId = useId();

  /**
   * A row's current state, defaulting to "arrived in full". The map holds only the rows the user
   * has actually touched, so a line the order refetches into view while the dialog is open still
   * arrives ticked and pre-filled rather than silently excluded.
   */
  const rowFor = (entry: DeliveryLine): RowState =>
    rows.get(entry.line.id) ?? { include: true, quantity: String(outstandingOf(entry.line)) };

  const setRow = (lineId: string, next: RowState) => {
    setRows((prev) => new Map(prev).set(lineId, next));
  };

  // Ticking or clearing every row changes only whether each is included — a quantity the user has
  // already corrected is theirs, and re-filling it would quietly undo the correction.
  const setEveryRow = (include: boolean) => {
    setRows((prev) => {
      const next = new Map<string, RowState>();
      for (const entry of lines) {
        const row = prev.get(entry.line.id);
        next.set(entry.line.id, { include, quantity: row?.quantity ?? String(outstandingOf(entry.line)) });
      }
      return next;
    });
  };

  // Whether *any* offered line can land stock at all. When none can, the shared destination and
  // batch fields would apply to nothing, so the dialog does not ask for them.
  const anyLandsStock = useMemo(
    () =>
      lines.some(
        (entry) => entry.trackingMode === undefined || recordOnlyReason(entry.trackingMode) === null,
      ),
    [lines],
  );

  const includedCount = lines.filter((entry) => rowFor(entry).include).length;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const receipts: PurchaseOrderLineReceipt[] = [];
    // One batch identity for the whole delivery, built by the same seam every receipt dialog uses,
    // so what counts as a tracked lot cannot differ between them.
    const batch = batchIdentityFrom(batchNumber, lotNumber, fromDateInputValue(expiryDate));

    for (const entry of lines) {
      const row = rowFor(entry);
      if (!row.include) continue;
      const outstanding = outstandingOf(entry.line);
      const qty = Number(row.quantity);
      if (!Number.isInteger(qty) || qty <= 0 || qty > outstanding) {
        setError(
          t('purchasing.orders.receive.error.qty', {
            vars: { line: entry.label, max: f.quantity(outstanding) },
          }),
        );
        return;
      }
      // A record-only line reaches the repository as a bare quantity: it discards the destination
      // and the batch on that path, so sending them would describe a placement that never happened.
      const recordOnly = entry.trackingMode !== undefined && recordOnlyReason(entry.trackingMode) !== null;
      receipts.push(
        recordOnly
          ? { lineId: entry.line.id, quantity: qty }
          : {
              lineId: entry.line.id,
              quantity: qty,
              locationId: locationId.length === 0 ? undefined : locationId,
              batch,
            },
      );
    }

    if (receipts.length === 0) {
      setError(t('purchasing.orders.receive.error.none'));
      return;
    }
    onSubmit(receipts);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('purchasing.orders.receive.title')}
      description={t('purchasing.orders.receive.description')}
      className="max-w-2xl"
      busy={isSaving}
    >
      <form onSubmit={handleSubmit} className="space-y-3" data-testid="po-receive-delivery-form">
        {anyLandsStock && (
          <>
            <FormField
              label={t('purchasing.orders.receive.destination.label')}
              hint={t('purchasing.orders.receive.destination.hint')}
            >
              <span id={locationLabelId} className="sr-only">
                {t('purchasing.orders.receive.destination.label')}
              </span>
              <LocationSelect
                value={locationId}
                onChange={setLocationId}
                options={locationOptions}
                labelledBy={locationLabelId}
              />
            </FormField>

            <div className="grid grid-cols-2 gap-3">
              <FormField
                label={t('purchasing.orders.receive.batch.label')}
                hint={t('purchasing.orders.receive.batch.hint')}
              >
                <Input
                  value={batchNumber}
                  onChange={(e) => setBatchNumber(e.target.value)}
                  placeholder="—"
                  data-testid="po-delivery-batch"
                />
              </FormField>
              <FormField
                label={t('purchasing.orders.receive.lot.label')}
                hint={t('purchasing.orders.receive.lot.hint')}
              >
                <Input value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} placeholder="—" />
              </FormField>
            </div>

            <FormField
              label={t('purchasing.orders.receive.expiry.label')}
              hint={t('purchasing.orders.receive.expiry.hint')}
            >
              <Input
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
                data-testid="po-delivery-expiry"
              />
            </FormField>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <h3 className="text-sm font-semibold">
            {t('purchasing.orders.receive.lines.heading', { vars: { count: lines.length } })}
          </h3>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEveryRow(true)}
              data-testid="po-delivery-select-all"
            >
              {t('purchasing.orders.receive.selectAll')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEveryRow(false)}
              data-testid="po-delivery-clear-all"
            >
              {t('purchasing.orders.receive.clearAll')}
            </Button>
          </div>
        </div>

        <ul className="flex flex-col divide-y divide-border">
          {lines.map((entry) => {
            const row = rowFor(entry);
            const outstanding = outstandingOf(entry.line);
            // The clause is read as a *key*, not as the seam's stored English: this sentence is
            // translated, and splicing English into it would leave a German reader half a sentence.
            const reason = entry.trackingMode === undefined ? null : recordOnlyReason(entry.trackingMode);
            return (
              <li
                key={entry.line.id}
                className="flex flex-wrap items-center gap-3 py-2"
                data-testid="po-delivery-row"
              >
                <Checkbox
                  checked={row.include}
                  onChange={(e) => setRow(entry.line.id, { ...row, include: e.target.checked })}
                  aria-label={t('purchasing.orders.receive.include.label', { vars: { line: entry.label } })}
                  data-testid="po-delivery-include"
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{entry.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {t('purchasing.orders.receive.outstanding', {
                      vars: {
                        outstanding: f.quantity(outstanding),
                        ordered: f.quantity(entry.line.orderedQty),
                      },
                    })}
                    {reason !== null && (
                      <>
                        {' · '}
                        <span data-testid="po-delivery-record-only">
                          {t('purchasing.orders.receive.recordOnly', {
                            vars: { reason: t(reason.messageKey) },
                          })}
                        </span>
                      </>
                    )}
                  </span>
                </div>
                <Input
                  value={row.quantity}
                  // Typing a quantity into an unticked row is an unambiguous statement that the
                  // line did arrive, so the row ticks itself rather than discarding the entry.
                  // Editing is the signal, not focus: tabbing past a row the user deliberately
                  // unticked must not put it back.
                  onChange={(e) => setRow(entry.line.id, { include: true, quantity: e.target.value })}
                  inputMode="numeric"
                  className="w-24"
                  aria-label={t('purchasing.orders.receive.quantity.label', { vars: { line: entry.label } })}
                  data-testid="po-delivery-qty"
                />
              </li>
            );
          })}
        </ul>

        {error !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="po-delivery-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
            {t('purchasing.orders.receive.cancel')}
          </Button>
          <Button
            type="submit"
            variant="primary"
            // Nothing ticked is nothing to receive. The form still refuses on submit (Enter from a
            // quantity field reaches it past a disabled button) and says why.
            disabled={isSaving || includedCount === 0}
            data-testid="po-delivery-save"
          >
            {t('purchasing.orders.receive.submit', { vars: { count: includedCount } })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
