import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item, ItemBatchPlacement, ItemStockPlacement } from '@/db/repositories';

/**
 * Behaviour tests for the {@link SellDialog} glue (Sales & disposals). The FEFO/lot draw lives in
 * the pure `inventory/batches` seam and the repository (covered elsewhere); this pins the dialog's
 * contract: the price gate, the exact input handed to the sell mutation for the happy path and the
 * split/quantity branches, the success → `onClose` flow, and a failed sale (`role="alert"`, stays
 * open). Per the component-test conventions the sales + lifecycle hooks are mocked.
 */

const h = vi.hoisted(() => ({
  placements: [] as ItemStockPlacement[],
  batches: [] as ItemBatchPlacement[],
  mutate: vi.fn(),
}));

vi.mock('../sales', () => ({
  useSellItem: () => ({ mutate: h.mutate, isPending: false }),
  useWriteOffItem: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/features/lifecycle/hooks', () => ({
  useItemStock: () => ({ data: h.placements }),
  useItemBatches: () => ({ data: h.batches }),
}));

import { SellDialog } from './SellDialog';

const onClose = vi.fn();

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    name: 'Widget',
    locationId: 'loc-1',
    trackingMode: 'DISCRETE',
    quantity: 5,
    unitCost: null,
    ...overrides,
  } as Item;
}

function renderDialog(item: Item = makeItem()) {
  return render(<SellDialog open onClose={onClose} item={item} />);
}

const priceInput = () => screen.getByPlaceholderText('0.00');
const sellButton = () => screen.getByRole('button', { name: /^Sell$/ });

beforeEach(() => {
  h.placements = [{ locationId: 'loc-1', locationName: 'Shelf A', quantity: 5 }];
  h.batches = [];
  h.mutate.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  onClose.mockReset();
});
afterEach(cleanup);

describe('SellDialog — the price gate', () => {
  it('disables Sell until a valid price is entered', () => {
    renderDialog();
    expect(sellButton()).toBeDisabled();
    fireEvent.change(priceInput(), { target: { value: '5' } });
    expect(sellButton()).toBeEnabled();
  });

  it('a negative price keeps Sell disabled', () => {
    renderDialog();
    fireEvent.change(priceInput(), { target: { value: '-3' } });
    expect(sellButton()).toBeDisabled();
  });
});

describe('SellDialog — the happy path', () => {
  it('sells one unit at the entered price with no explicit source, then closes', async () => {
    renderDialog();
    fireEvent.change(priceInput(), { target: { value: '5' } });
    fireEvent.click(sellButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        {
          itemId: 'item-1',
          quantity: 1,
          unitSalePrice: 5,
          counterparty: undefined,
          fromLocationId: undefined,
          fromBatchKey: undefined,
        },
        expect.anything(),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('sends the trimmed buyer when one is entered', async () => {
    renderDialog();
    fireEvent.change(priceInput(), { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText('Who bought it'), { target: { value: '  Acme  ' } });
    fireEvent.click(sellButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ counterparty: 'Acme' }),
        expect.anything(),
      ),
    );
  });

  it('clamps the quantity to what the placement holds', async () => {
    renderDialog(makeItem({ quantity: 3 }));
    fireEvent.change(priceInput(), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('outbound-qty'), { target: { value: '10' } });
    fireEvent.click(sellButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3 }), expect.anything()),
    );
  });
});

describe('SellDialog — a failed sale surfaces the error and stays open', () => {
  it('shows the mutation error in an alert and does not close', async () => {
    h.mutate.mockImplementation((_input, opts) => opts?.onError?.(new Error('Not enough stock.')));
    renderDialog();
    fireEvent.change(priceInput(), { target: { value: '5' } });
    fireEvent.click(sellButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not enough stock.'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
