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
import type { PurchaseOrderLine } from '@/db/repositories';
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

function renderDialog() {
  return render(
    <ReceiveLineDialog
      open
      line={line}
      locationOptions={[]}
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
