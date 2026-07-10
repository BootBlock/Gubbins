import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CheckoutWithNames } from '@/db/repositories';

/**
 * Behaviour tests for {@link RenewLoanDialog} (spec §4 Borrowing, B3 "renew a loan"). This pins
 * the dialog's contract: the date field is seeded from the loan's current due date; submitting a
 * new date calls the renew mutation with the parsed UNIX-ms instant; clearing the field renews to
 * an open-ended loan (`null`); and a failed renew surfaces the error without closing. Per the
 * component-test conventions the renew mutation hook is mocked; the pure `to/fromDateInputValue`
 * seam runs for real.
 */

const h = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('../contacts', () => ({
  useRenewLoan: () => ({ mutate: h.mutate, isPending: false }),
}));

import { RenewLoanDialog } from './RenewLoanDialog';

const onClose = vi.fn();

/** 2026-01-15 at midnight UTC — a clean instant that round-trips through the date input. */
const JAN_15_2026 = Date.parse('2026-01-15');
const FEB_01_2026 = Date.parse('2026-02-01');

function makeCheckout(overrides: Partial<CheckoutWithNames> = {}): CheckoutWithNames {
  return {
    id: 'checkout-1',
    itemId: 'item-1',
    itemName: 'Torque wrench',
    contactId: 'c-1',
    contactName: 'Ada Lovelace',
    quantity: 1,
    dueDate: JAN_15_2026,
    checkedOutAt: 0,
    returnedAt: null,
    note: null,
    returnNote: null,
    sourceLocationId: null,
    sourceBatchKey: null,
    updatedAt: 0,
    status: 'OPEN',
    isOverdue: false,
    ...overrides,
  };
}

function renderDialog(checkout: CheckoutWithNames = makeCheckout()) {
  return render(<RenewLoanDialog open onClose={onClose} checkout={checkout} />);
}

const dueDateInput = () => screen.getByTestId('renew-due-date') as HTMLInputElement;
const renewButton = () => screen.getByRole('button', { name: /Renew/ });

beforeEach(() => {
  h.mutate.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  onClose.mockReset();
});
afterEach(cleanup);

describe('RenewLoanDialog', () => {
  it('seeds the date field with the loan’s current due date', () => {
    renderDialog();
    expect(dueDateInput().value).toBe('2026-01-15');
  });

  it('seeds an empty field for an open-ended loan (no due date)', () => {
    renderDialog(makeCheckout({ dueDate: null }));
    expect(dueDateInput().value).toBe('');
  });

  it('renews with the parsed new due date, then closes', async () => {
    renderDialog();
    fireEvent.change(dueDateInput(), { target: { value: '2026-02-01' } });
    fireEvent.click(renewButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        { checkoutId: 'checkout-1', dueDate: FEB_01_2026 },
        expect.anything(),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('renews to an open-ended loan (null) when the date is cleared', async () => {
    renderDialog();
    fireEvent.change(dueDateInput(), { target: { value: '' } });
    fireEvent.click(renewButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith({ checkoutId: 'checkout-1', dueDate: null }, expect.anything()),
    );
  });

  it('surfaces a failed renew in an alert and stays open', async () => {
    h.mutate.mockImplementation((_input, opts) => opts?.onError?.(new Error('Could not renew the loan.')));
    renderDialog();
    fireEvent.click(renewButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not renew the loan.'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
