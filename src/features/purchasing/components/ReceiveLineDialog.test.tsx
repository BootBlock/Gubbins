/**
 * Behaviour tests for {@link ReceiveLineDialog} — the batch identity a purchase-order receipt
 * records (issue #684).
 *
 * The dialog collected a batch number and a lot number but hard-coded `expiryDate: null`, so no
 * lot arriving through a purchase order could ever carry a date — and a date is what FEFO consumes
 * by and what the expiry alerts read. These pin the three cases that matter: a date alone is
 * enough to make the receipt a tracked lot, a date rides alongside a batch/lot marking, and a
 * receipt with none of the three still records no batch at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { PurchaseOrderLine, TrackingMode } from '@/db/repositories';
import { ReceiveLineDialog } from './ReceiveLineDialog';

const onSubmit = vi.fn();
const onClose = vi.fn();

const line = {
  id: 'line-1',
  purchaseOrderId: 'po-1',
  itemId: 'item-1',
  orderedQty: 10,
  receivedQty: 0,
} as unknown as PurchaseOrderLine;

function renderDialog(itemTrackingMode?: TrackingMode) {
  return render(
    <ReceiveLineDialog
      open
      line={line}
      locationOptions={[]}
      itemTrackingMode={itemTrackingMode}
      isSaving={false}
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
}

/** The batch identity the dialog handed to its `onSubmit`, if any. */
function submittedBatch(): unknown {
  return (onSubmit.mock.calls[0]?.[0] as { batch?: unknown }).batch;
}

beforeEach(() => {
  onSubmit.mockClear();
  onClose.mockClear();
});

afterEach(cleanup);

describe('ReceiveLineDialog — batch identity', () => {
  it('records an expiry date entered on its own as a tracked lot', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('po-receive-expiry'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByTestId('po-receive-save'));

    expect(submittedBatch()).toEqual({
      batchNumber: null,
      lotNumber: null,
      // Stored as the day-grained midnight-UTC stamp every expiry read compares against (#320).
      expiryDate: Date.UTC(2026, 7, 1),
    });
  });

  it('records the expiry alongside a batch number', () => {
    renderDialog();
    fireEvent.change(screen.getByTestId('po-receive-batch'), { target: { value: 'B-42' } });
    fireEvent.change(screen.getByTestId('po-receive-expiry'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByTestId('po-receive-save'));

    expect(submittedBatch()).toEqual({
      batchNumber: 'B-42',
      lotNumber: null,
      expiryDate: Date.UTC(2026, 7, 1),
    });
  });

  it('records no batch when none of the three fields is filled in', () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('po-receive-save'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submittedBatch()).toBeUndefined();
  });
});

/**
 * A receipt against an item with no counted quantity (issue #608). The dialog used to promise
 * "Receiving lands the units in your inventory" and collect a destination, batch, lot and expiry
 * for a write that discarded all four and moved no stock at all.
 */
describe('ReceiveLineDialog — an item that cannot hold counted stock', () => {
  it('says the receipt will not change stock, and why', () => {
    renderDialog('SERIALISED');
    expect(screen.getByTestId('po-receive-record-only')).toHaveTextContent('No stock will be added');
    expect(screen.getByTestId('po-receive-record-only')).toHaveTextContent('serialised');
  });

  it('drops the destination, batch, lot and expiry fields the write would discard', () => {
    renderDialog('CONSUMABLE_GAUGE');
    expect(screen.queryByTestId('po-receive-batch')).toBeNull();
    expect(screen.queryByTestId('po-receive-expiry')).toBeNull();
    expect(screen.queryByRole('combobox', { name: /destination location/i })).toBeNull();
    // The instalment quantity is still the user's to choose — a partial delivery is a partial
    // delivery whether or not it moves stock.
    expect(screen.getByTestId('po-receive-qty')).toBeInTheDocument();
  });

  it('submits a bare quantity, never a placement the units did not take', () => {
    renderDialog('UNTRACKED');
    fireEvent.click(screen.getByTestId('po-receive-save'));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toEqual({ quantity: 10 });
  });

  it('promises stock as before for a bulk item, and while the mode is still unknown', () => {
    renderDialog('DISCRETE');
    expect(screen.queryByTestId('po-receive-record-only')).toBeNull();
    cleanup();
    // Undefined = the item read has not landed (or the line is unlinked). Warning on a value it
    // does not have yet would show a caution that the next render takes back.
    renderDialog(undefined);
    expect(screen.queryByTestId('po-receive-record-only')).toBeNull();
    expect(screen.getByTestId('po-receive-batch')).toBeInTheDocument();
  });
});
