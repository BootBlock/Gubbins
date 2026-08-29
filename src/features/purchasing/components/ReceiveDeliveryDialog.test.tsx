/**
 * Behaviour tests for {@link ReceiveDeliveryDialog} — receiving a whole order in one pass
 * (issue #589).
 *
 * What the dialog exists to make true is that "the box arrived and everything in it is here" is a
 * single interaction: every outstanding line pre-filled with its remainder, one destination and one
 * batch across the lot. These pin that default, the exceptions it still allows (a short line, a
 * line that did not arrive at all), and the one thing it must never do — hand a destination or a
 * batch to a line whose item holds no counted quantity, which the write discards.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { PurchaseOrderLine, PurchaseOrderLineReceipt, TrackingMode } from '@/db/repositories';
import { ReceiveDeliveryDialog, type DeliveryLine } from './ReceiveDeliveryDialog';

const onSubmit = vi.fn();
const onClose = vi.fn();

function makeLine(id: string, orderedQty: number, receivedQty = 0): PurchaseOrderLine {
  return { id, poId: 'po-1', itemId: `item-${id}`, orderedQty, receivedQty } as unknown as PurchaseOrderLine;
}

function entry(id: string, label: string, orderedQty: number, trackingMode?: TrackingMode): DeliveryLine {
  return { line: makeLine(id, orderedQty), label, trackingMode };
}

const locationOptions = [
  { value: '', label: '— Item’s home location —' },
  { value: 'loc-bay', label: 'Goods-in bay' },
];

function renderDialog(lines: readonly DeliveryLine[]) {
  return render(
    <ReceiveDeliveryDialog
      open
      lines={lines}
      locationOptions={locationOptions}
      isSaving={false}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
}

/** The receipts the dialog handed to its `onSubmit`. */
function submitted(): readonly PurchaseOrderLineReceipt[] {
  return onSubmit.mock.calls[0]![0] as readonly PurchaseOrderLineReceipt[];
}

/** The quantity input of the row naming `label`. */
function qtyFieldOf(label: string): HTMLElement {
  const row = screen.getAllByTestId('po-delivery-row').find((el) => within(el).queryByText(label) !== null)!;
  return within(row).getByTestId('po-delivery-qty');
}

/** The include tick of the row naming `label`. */
function includeOf(label: string): HTMLElement {
  const row = screen.getAllByTestId('po-delivery-row').find((el) => within(el).queryByText(label) !== null)!;
  return within(row).getByTestId('po-delivery-include');
}

beforeEach(() => {
  onSubmit.mockClear();
  onClose.mockClear();
});

afterEach(cleanup);

describe('ReceiveDeliveryDialog — the whole delivery arrived', () => {
  it('pre-fills every outstanding line with its remainder and submits the lot', () => {
    renderDialog([entry('l1', 'M3 bolt', 50), entry('l2', 'M3 nut', 20)]);

    expect((qtyFieldOf('M3 bolt') as HTMLInputElement).value).toBe('50');
    expect((qtyFieldOf('M3 nut') as HTMLInputElement).value).toBe('20');

    fireEvent.click(screen.getByTestId('po-delivery-save'));

    expect(submitted()).toEqual([
      { lineId: 'l1', quantity: 50, locationId: undefined, batch: undefined },
      { lineId: 'l2', quantity: 20, locationId: undefined, batch: undefined },
    ]);
  });

  it('applies one destination and one batch across every line', () => {
    renderDialog([entry('l1', 'M3 bolt', 4), entry('l2', 'M3 nut', 4)]);

    fireEvent.change(screen.getByTestId('po-delivery-batch'), { target: { value: 'B-42' } });
    fireEvent.change(screen.getByTestId('po-delivery-expiry'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByTestId('po-delivery-save'));

    const batch = { batchNumber: 'B-42', lotNumber: null, expiryDate: Date.UTC(2026, 7, 1) };
    expect(submitted().map((r) => r.batch)).toEqual([batch, batch]);
  });

  it('accepts a short line beside a full one', () => {
    renderDialog([entry('l1', 'M3 bolt', 50), entry('l2', 'M3 nut', 20)]);

    fireEvent.change(qtyFieldOf('M3 nut'), { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('po-delivery-save'));

    expect(submitted().map((r) => [r.lineId, r.quantity])).toEqual([
      ['l1', 50],
      ['l2', 5],
    ]);
  });

  it('leaves out a line that did not arrive', () => {
    renderDialog([entry('l1', 'M3 bolt', 50), entry('l2', 'M3 nut', 20)]);

    fireEvent.click(includeOf('M3 nut'));
    fireEvent.click(screen.getByTestId('po-delivery-save'));

    expect(submitted().map((r) => r.lineId)).toEqual(['l1']);
  });

  it('refuses a quantity larger than the line has outstanding, and says which line', () => {
    renderDialog([entry('l1', 'M3 bolt', 50)]);

    fireEvent.change(qtyFieldOf('M3 bolt'), { target: { value: '60' } });
    fireEvent.click(screen.getByTestId('po-delivery-save'));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('po-delivery-error')).toHaveTextContent('M3 bolt');
  });

  it('refuses to submit with nothing ticked, rather than receiving an empty delivery', () => {
    renderDialog([entry('l1', 'M3 bolt', 50)]);

    fireEvent.click(screen.getByTestId('po-delivery-clear-all'));
    expect(screen.getByTestId('po-delivery-save')).toBeDisabled();
    // Enter from a quantity field still reaches the form past the disabled button, so the refusal
    // has to be the form's, not only the button's.
    fireEvent.submit(screen.getByTestId('po-receive-delivery-form'));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('po-delivery-error')).toBeInTheDocument();
  });

  it('re-ticks a row when its quantity is edited, but not merely focused', () => {
    renderDialog([entry('l1', 'M3 bolt', 50)]);

    fireEvent.click(screen.getByTestId('po-delivery-clear-all'));
    // Tabbing past a row the user deliberately unticked must leave it unticked.
    fireEvent.focus(qtyFieldOf('M3 bolt'));
    expect(includeOf('M3 bolt')).not.toBeChecked();

    fireEvent.change(qtyFieldOf('M3 bolt'), { target: { value: '12' } });
    expect(includeOf('M3 bolt')).toBeChecked();

    fireEvent.click(screen.getByTestId('po-delivery-save'));
    expect(submitted().map((r) => [r.lineId, r.quantity])).toEqual([['l1', 12]]);
  });
});

describe('ReceiveDeliveryDialog — a line that cannot hold counted stock', () => {
  it('says so on the row, and sends it a bare quantity', () => {
    renderDialog([entry('l1', 'M3 bolt', 4), entry('l2', 'Torque wrench', 1, 'SERIALISED')]);

    expect(screen.getByTestId('po-delivery-record-only')).toHaveTextContent('serialised');

    fireEvent.change(screen.getByTestId('po-delivery-batch'), { target: { value: 'B-42' } });
    fireEvent.click(screen.getByTestId('po-delivery-save'));

    // The shared batch reaches the bulk line only. Sending it with the serialised one would record
    // a placement the units never took — the write discards it either way.
    expect(submitted()).toEqual([
      {
        lineId: 'l1',
        quantity: 4,
        locationId: undefined,
        batch: { batchNumber: 'B-42', lotNumber: null, expiryDate: null },
      },
      { lineId: 'l2', quantity: 1 },
    ]);
  });

  it('drops the shared destination and batch fields when no line can land stock', () => {
    renderDialog([entry('l1', 'Drilling jig', 1, 'UNTRACKED')]);

    expect(screen.queryByTestId('po-delivery-batch')).toBeNull();
    expect(screen.queryByTestId('po-delivery-expiry')).toBeNull();
    // The quantity is still the user's to choose — a partial delivery is a partial delivery
    // whether or not it moves stock.
    expect(qtyFieldOf('Drilling jig')).toBeInTheDocument();
  });

  it('keeps the shared fields while a line’s tracking mode is still unknown', () => {
    // Undefined = the item read has not landed (or the line is unlinked). Hiding the fields on a
    // value it does not have yet would take back a choice the next render restores.
    renderDialog([entry('l1', 'M3 bolt', 4, undefined)]);

    expect(screen.getByTestId('po-delivery-batch')).toBeInTheDocument();
    expect(screen.queryByTestId('po-delivery-record-only')).toBeNull();
  });
});
