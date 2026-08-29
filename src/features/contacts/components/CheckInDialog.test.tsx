import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { CheckoutWithNames } from '@/db/repositories';

/**
 * Behaviour tests for {@link CheckInDialog} (spec §4 Borrowing, B2 "condition on return"). This
 * pins the dialog's contract: the fast one-tap path (an empty submit returns with no condition
 * and no note — behaving exactly like the pre-dialog return); returning part of a multi-unit loan
 * (issue #662); capturing a condition on return (driven through the Foundry Select); capturing a
 * return note; and a failed check-in surfacing the error without closing. Per the component-test conventions the check-in mutation hook is
 * mocked; the pure `conditionSelectOptions` seam runs for real.
 */

const h = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock('../contacts', () => ({
  useCheckInItem: () => ({ mutate: h.mutate, isPending: false }),
}));

import { CheckInDialog } from './CheckInDialog';

const onClose = vi.fn();

function makeCheckout(overrides: Partial<CheckoutWithNames> = {}): CheckoutWithNames {
  return {
    id: 'checkout-1',
    itemId: 'item-1',
    itemName: 'Torque wrench',
    borrowerType: 'contact',
    contactId: 'c-1',
    projectId: null,
    locationId: null,
    borrowerName: 'Ada Lovelace',
    quantity: 1,
    returnedQuantity: 0,
    dueDate: null,
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
  return render(<CheckInDialog open onClose={onClose} checkout={checkout} />);
}

const returnButton = () => screen.getByRole('button', { name: /Return/ });

beforeEach(() => {
  h.mutate.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  onClose.mockReset();
});
afterEach(cleanup);

describe('CheckInDialog — the fast one-tap path', () => {
  it('returns with no condition and no note on an empty submit, then closes', async () => {
    renderDialog();
    fireEvent.click(returnButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        { checkoutId: 'checkout-1', note: undefined, condition: undefined, quantity: undefined },
        expect.anything(),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CheckInDialog — returning part of a loan (issue #662)', () => {
  const quantityField = () => screen.getByTestId('checkin-quantity');

  it('offers no quantity field when there is only one unit to hand back', () => {
    renderDialog();
    expect(screen.queryByTestId('checkin-quantity')).toBeNull();
  });

  it('defaults to everything still out and sends no quantity for a whole-loan return', async () => {
    renderDialog(makeCheckout({ quantity: 6, returnedQuantity: 2 }));
    expect(quantityField()).toHaveValue(4);

    fireEvent.click(returnButton());

    // Returning everything outstanding is exactly what an omitted quantity means, so the fast
    // path stays byte-identical to the one-tap return rather than growing a redundant argument.
    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: undefined }),
        expect.anything(),
      ),
    );
  });

  it('sends the chosen quantity when the user hands back only part of the loan', async () => {
    renderDialog(makeCheckout({ quantity: 6 }));
    fireEvent.change(quantityField(), { target: { value: '2' } });
    fireEvent.click(returnButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({ quantity: 2 }), expect.anything()),
    );
  });

  it('clamps a quantity above what is still out rather than letting it be submitted', () => {
    renderDialog(makeCheckout({ quantity: 6, returnedQuantity: 2 }));
    fireEvent.change(quantityField(), { target: { value: '99' } });
    expect(quantityField()).toHaveValue(4);
  });

  it('states how much of the loan is still out', () => {
    renderDialog(makeCheckout({ quantity: 6, returnedQuantity: 2 }));
    expect(screen.getByText('4 of 6 still out')).toBeInTheDocument();
  });
});

describe('CheckInDialog — condition on return', () => {
  it('sends the chosen condition (Foundry Select driven by clicking)', async () => {
    renderDialog();
    // Foundry Select is a custom listbox — open it and click the option (not selectOption).
    fireEvent.click(screen.getByRole('combobox', { name: /Condition on return/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Needs repair' }));
    fireEvent.click(returnButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ condition: 'NEEDS_REPAIR' }),
        expect.anything(),
      ),
    );
  });

  it('sends no condition when the user leaves it on "— No change —"', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('combobox', { name: /Condition on return/ }));
    fireEvent.click(screen.getByRole('option', { name: '— No change —' }));
    fireEvent.click(returnButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ condition: undefined }),
        expect.anything(),
      ),
    );
  });
});

describe('CheckInDialog — return note', () => {
  it('sends a trimmed return note', async () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/chipped blade/), {
      target: { value: '  now due calibration  ' },
    });
    fireEvent.click(returnButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ note: 'now due calibration' }),
        expect.anything(),
      ),
    );
  });
});

describe('CheckInDialog — a failed check-in surfaces the error and stays open', () => {
  it('shows the mutation error in an alert and does not close', async () => {
    h.mutate.mockImplementation((_input, opts) => opts?.onError?.(new Error('Could not restore stock.')));
    renderDialog();
    fireEvent.click(returnButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not restore stock.'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
