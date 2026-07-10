import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item, ItemBatchPlacement, ItemStockPlacement } from '@/db/repositories';

/**
 * Behaviour tests for the {@link CheckoutDialog} glue (spec §4 Borrowing, Phases 26/29). The
 * per-location FEFO / explicit-lot maths lives in the pure `inventory/batches` seam (covered by
 * batches.test.ts); this pins the *dialog's* contract — the high-stakes path that physically
 * moves stock to a borrower. It nails down: the submit gate (a borrower name is required); the
 * exact {@link CheckoutItemInput} handed to the mutation for the simple happy path and each
 * meaningful branch (a chosen source location vs. the silent default, an explicit lot vs. FEFO,
 * discrete quantity bounds vs. a pinned serialised unit, a due-date preset); the success →
 * `onClose` flow; and a blocked/failed case (`role="alert"`, no mutation). Per the component-test
 * conventions the contacts + lifecycle hooks are mocked; the `isDefaultBatch` seam runs for real.
 */

const h = vi.hoisted(() => ({
  placements: [] as ItemStockPlacement[],
  batches: [] as ItemBatchPlacement[],
  contactRows: [] as { id: string; name: string }[],
  projectRows: [] as { id: string; name: string }[],
  locationRows: [] as { id: string; name: string }[],
  projectsOn: true,
  mutate: vi.fn(),
}));

vi.mock('../contacts', () => ({
  useContacts: () => ({ data: { rows: h.contactRows } }),
  useCheckoutItem: () => ({ mutate: h.mutate, isPending: false }),
}));
vi.mock('@/features/lifecycle/hooks', () => ({
  useItemStock: () => ({ data: h.placements }),
  useItemBatches: () => ({ data: h.batches }),
}));
// B4: the dialog now also reads the project/location pickers and the Projects feature flag.
vi.mock('@/features/projects/projects', () => ({
  useProjects: () => ({ data: { rows: h.projectRows } }),
}));
vi.mock('@/features/inventory/queries', () => ({
  useLocations: () => ({ data: { rows: h.locationRows } }),
}));
vi.mock('@/features/modules/useFeature', () => ({
  useFeature: () => h.projectsOn,
}));

import { CheckoutDialog } from './CheckoutDialog';

const onClose = vi.fn();

/** A tracked lot at Shelf A: batch "42", holding `quantity` units. */
const trackedLot = (quantity: number): ItemBatchPlacement => ({
  locationId: 'loc-1',
  locationName: 'Shelf A',
  batchKey: '["42",null,null]',
  batchNumber: '42',
  lotNumber: null,
  expiryDate: null,
  quantity,
});

/** The untracked remainder at a location (the anonymous default batch). */
const untrackedLot = (locationId: string, locationName: string, quantity: number): ItemBatchPlacement => ({
  locationId,
  locationName,
  batchKey: '',
  batchNumber: null,
  lotNumber: null,
  expiryDate: null,
  quantity,
});

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    name: 'Torque wrench',
    locationId: 'loc-1',
    trackingMode: 'DISCRETE',
    quantity: 3,
    ...overrides,
  } as Item;
}

function renderDialog(item: Item = makeItem()) {
  return render(<CheckoutDialog open onClose={onClose} item={item} />);
}

const borrowerInput = () => screen.getByPlaceholderText(/Type a name/);
const checkoutButton = () => screen.getByRole('button', { name: /Check out/ });

beforeEach(() => {
  h.placements = [{ locationId: 'loc-1', locationName: 'Shelf A', quantity: 3 }];
  h.batches = [];
  h.contactRows = [{ id: 'c-1', name: 'Existing Borrower' }];
  h.projectRows = [{ id: 'p-1', name: 'Henderson job' }];
  h.locationRows = [
    { id: 'loc-1', name: 'Shelf A' },
    { id: 'van', name: 'The van' },
  ];
  h.projectsOn = true;
  h.mutate.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  onClose.mockReset();
});
afterEach(cleanup);

describe('CheckoutDialog — the borrower gate', () => {
  it('disables Check out until a borrower name is entered', () => {
    renderDialog();
    expect(checkoutButton()).toBeDisabled();
    fireEvent.change(borrowerInput(), { target: { value: 'Ada Lovelace' } });
    expect(checkoutButton()).toBeEnabled();
  });

  it('a blank/whitespace name keeps Check out disabled', () => {
    renderDialog();
    fireEvent.change(borrowerInput(), { target: { value: '   ' } });
    expect(checkoutButton()).toBeDisabled();
  });

  it('submitting an empty name via Enter shows an alert and does not mutate', () => {
    renderDialog();
    // Enter drives submit even while the button is disabled — the guard must reject it.
    fireEvent.keyDown(borrowerInput(), { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Enter who is borrowing this.');
    expect(h.mutate).not.toHaveBeenCalled();
  });
});

describe('CheckoutDialog — the simple happy path (single placement, no lots)', () => {
  it('lends one unit with no explicit source, then closes', async () => {
    renderDialog();
    fireEvent.change(borrowerInput(), { target: { value: '  Ada Lovelace  ' } });
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        {
          itemId: 'item-1',
          contactName: 'Ada Lovelace', // trimmed
          quantity: 1,
          dueDate: null,
          fromLocationId: undefined, // not split → repository uses the primary placement
          fromBatchKey: undefined, // no tracked lot → repository draws FEFO
        },
        expect.anything(),
      ),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('does not offer a source-location or lot picker when stock is not split', () => {
    renderDialog();
    expect(screen.queryByTestId('checkout-from-location')).toBeNull();
    expect(screen.queryByTestId('checkout-from-lot')).toBeNull();
  });
});

describe('CheckoutDialog — discrete quantity bounds', () => {
  it('clamps the requested quantity to what the placement holds', async () => {
    renderDialog(makeItem({ quantity: 3 }));
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    // Ask for more than on hand — the input clamps to the 3 available.
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '10' } });
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3 }), expect.anything()),
    );
  });
});

describe('CheckoutDialog — split source location (Phase 26)', () => {
  beforeEach(() => {
    h.placements = [
      { locationId: 'loc-1', locationName: 'Shelf A', quantity: 2 },
      { locationId: 'loc-2', locationName: 'Van', quantity: 5 },
    ];
  });

  it('defaults the source to the item primary and sends it explicitly', async () => {
    renderDialog(makeItem({ locationId: 'loc-1', quantity: 7 }));
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ fromLocationId: 'loc-1' }),
        expect.anything(),
      ),
    );
  });

  it('sends the chosen location when the user lends from another placement', async () => {
    renderDialog(makeItem({ locationId: 'loc-1', quantity: 7 }));
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    // Foundry Select is a custom listbox — open it and click the option (not selectOption).
    fireEvent.click(screen.getByRole('combobox', { name: 'Lend from' }));
    fireEvent.click(screen.getByRole('option', { name: 'Van (5)' }));
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ fromLocationId: 'loc-2' }),
        expect.anything(),
      ),
    );
  });
});

describe('CheckoutDialog — explicit lot vs. FEFO (Phase 29)', () => {
  beforeEach(() => {
    // A single placement holding a tracked lot plus an untracked remainder → the lot picker shows.
    h.placements = [{ locationId: 'loc-1', locationName: 'Shelf A', quantity: 5 }];
    h.batches = [trackedLot(3), untrackedLot('loc-1', 'Shelf A', 2)];
  });

  it('draws FEFO by default (no explicit batch key)', async () => {
    renderDialog(makeItem({ quantity: 5 }));
    expect(screen.getByTestId('checkout-from-lot')).not.toBeNull();
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ fromBatchKey: undefined }),
        expect.anything(),
      ),
    );
  });

  it('lends the exact lot the user picks, capping the quantity to that lot', async () => {
    renderDialog(makeItem({ quantity: 5 }));
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Lend from lot' }));
    fireEvent.click(screen.getByRole('option', { name: 'Batch 42 (3)' }));
    // The chosen lot only holds 3 — asking for 9 clamps to 3.
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '9' } });
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ fromBatchKey: '["42",null,null]', quantity: 3 }),
        expect.anything(),
      ),
    );
  });
});

describe('CheckoutDialog — non-discrete items are pinned to one unit', () => {
  it('sends quantity 1 and no source even when stock is split', async () => {
    h.placements = [
      { locationId: 'loc-1', locationName: 'Shelf A', quantity: 2 },
      { locationId: 'loc-2', locationName: 'Van', quantity: 1 },
    ];
    renderDialog(makeItem({ trackingMode: 'SERIALISED', quantity: 3 }));
    // No quantity field, and no split/lot pickers, for a serialised item.
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByTestId('checkout-from-location')).toBeNull();
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ quantity: 1, fromLocationId: undefined, fromBatchKey: undefined }),
        expect.anything(),
      ),
    );
  });
});

describe('CheckoutDialog — due date', () => {
  it('a preset sets a concrete due timestamp instead of null', async () => {
    renderDialog();
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    fireEvent.click(screen.getByRole('button', { name: '1 week' }));
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ dueDate: expect.any(Number) }),
        expect.anything(),
      ),
    );
  });
});

describe('CheckoutDialog — loan target is a tagged union (B4)', () => {
  /** Switch the "Loan to" Foundry Select to the named option. */
  const chooseTarget = (name: RegExp) => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Loan to' }));
    fireEvent.click(screen.getByRole('option', { name }));
  };

  it('shows the project picker and dispatches a projectId (not a contact) when Project is chosen', async () => {
    renderDialog();
    // The contact name box is the default; switching to Project swaps in the project picker.
    expect(screen.queryByPlaceholderText(/Type a name/)).not.toBeNull();
    chooseTarget(/A project/);
    expect(screen.queryByPlaceholderText(/Type a name/)).toBeNull();

    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    fireEvent.click(screen.getByRole('option', { name: 'Henderson job' }));
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item-1', projectId: 'p-1' }),
        expect.anything(),
      ),
    );
    // No contact fields leak into the project loan.
    const input = h.mutate.mock.calls[0][0];
    expect(input.contactName).toBeUndefined();
    expect(input.locationId).toBeUndefined();
  });

  it('dispatches a locationId when Location is chosen', async () => {
    renderDialog();
    chooseTarget(/A location/);
    fireEvent.click(screen.getByRole('combobox', { name: 'Location' }));
    fireEvent.click(screen.getByRole('option', { name: 'The van' }));
    fireEvent.click(checkoutButton());

    await waitFor(() =>
      expect(h.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'item-1', locationId: 'van' }),
        expect.anything(),
      ),
    );
  });

  it('keeps Check out disabled until a project is picked', () => {
    renderDialog();
    chooseTarget(/A project/);
    expect(checkoutButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    fireEvent.click(screen.getByRole('option', { name: 'Henderson job' }));
    expect(checkoutButton()).toBeEnabled();
  });

  it('omits the Project option when the Projects module is off', () => {
    h.projectsOn = false;
    renderDialog();
    fireEvent.click(screen.getByRole('combobox', { name: 'Loan to' }));
    expect(screen.queryByRole('option', { name: /A project/ })).toBeNull();
    expect(screen.queryByRole('option', { name: /A location/ })).not.toBeNull();
  });
});

describe('CheckoutDialog — a failed checkout surfaces the error and stays open', () => {
  it('shows the mutation error in an alert and does not close', async () => {
    h.mutate.mockImplementation((_input, opts) => opts?.onError?.(new Error('Not enough stock at Shelf A.')));
    renderDialog();
    fireEvent.change(borrowerInput(), { target: { value: 'Ada' } });
    fireEvent.click(checkoutButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Not enough stock at Shelf A.'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
