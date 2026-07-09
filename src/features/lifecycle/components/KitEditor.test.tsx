import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item, KitComponent } from '@/db/repositories';

/**
 * Behaviour tests for the {@link KitEditor} item-detail facet (Kits v1 — definition +
 * availability). The buildable maths lives in the pure `buildableCount` seam (covered by
 * kit-availability.test.ts) and runs here for real; this pins the *editor's* logic — the
 * headline "You can build N" line and its limiting note, the add flow (item picker + qty →
 * exact mutation payload), inline re-quantify on blur, and remove. Per the component-test
 * conventions every hook the component calls is mocked (`../hooks` + the item-list query).
 */
const h = vi.hoisted(() => ({
  components: [] as KitComponent[],
  candidates: [] as Item[],
  add: vi.fn(),
  updateQty: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../hooks', () => ({
  useItemKit: () => ({ data: h.components }),
  useAddKitComponent: () => ({ mutate: h.add, isPending: false }),
  useUpdateKitComponentQty: () => ({ mutate: h.updateQty, isPending: false }),
  useRemoveKitComponent: () => ({ mutate: h.remove, isPending: false }),
}));

vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: () => ({ data: { pages: [{ rows: h.candidates }] } }),
}));

import { KitEditor } from './KitEditor';

/** A minimal item fixture — only the fields the editor reads matter. */
const item = (o: Partial<Item> = {}): Item =>
  ({
    id: 'kit-1',
    name: 'First-aid kit',
    quantity: 0,
    trackingMode: 'DISCRETE',
    parentId: null,
    ...o,
  }) as Item;

const component = (o: Partial<KitComponent> = {}): KitComponent => ({
  id: 'kc-1',
  componentItemId: 'part-1',
  name: 'Bandage',
  quantity: 2,
  stock: 10,
  sort: 0,
  ...o,
});

function renderEditor(kit: Item = item()) {
  return render(<KitEditor item={kit} />);
}

beforeEach(() => {
  h.components = [];
  h.candidates = [item({ id: 'part-1', name: 'Bandage' }), item({ id: 'part-2', name: 'Scissors' })];
  h.add.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.updateQty.mockReset();
  h.remove.mockReset();
});
afterEach(cleanup);

describe('KitEditor — availability headline', () => {
  it('prompts to add components when the kit is empty', () => {
    renderEditor();
    expect(screen.getByTestId('kit-buildable')).toHaveTextContent(/Add components/);
    expect(screen.queryByTestId('kit-list')).toBeNull();
  });

  it('shows how many whole kits are buildable and names the limiting component', () => {
    h.components = [
      component({ id: 'kc-1', name: 'Bandage', quantity: 2, stock: 10 }), // 5
      component({ id: 'kc-2', name: 'Scissors', quantity: 1, stock: 3 }), // 3 (limiting)
    ];
    renderEditor();
    expect(screen.getByTestId('kit-buildable-count')).toHaveTextContent('3');
    expect(screen.getByTestId('kit-limiting')).toHaveTextContent('Scissors');
    expect(screen.getByTestId('kit-list').querySelectorAll('[data-testid="kit-component"]')).toHaveLength(2);
  });

  it('reads 0 buildable and flags the missing component when a component is out of stock', () => {
    h.components = [component({ name: 'Bandage', quantity: 1, stock: 0 })];
    renderEditor();
    expect(screen.getByTestId('kit-buildable-count')).toHaveTextContent('0');
    expect(screen.getByTestId('kit-limiting')).toHaveTextContent(/Short on Bandage/);
  });
});

describe('KitEditor — add a component', () => {
  it('assembles the exact add payload from the picker + qty, and resets on success', async () => {
    renderEditor();
    // The add button is disabled until an item is chosen.
    expect(screen.getByTestId('add-kit-component')).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Component item' }));
    fireEvent.click(screen.getByRole('option', { name: 'Scissors' }));
    fireEvent.change(screen.getByTestId('kit-qty'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('add-kit-component'));

    await waitFor(() =>
      expect(h.add).toHaveBeenCalledWith(
        { kitId: 'kit-1', componentItemId: 'part-2', quantity: 3 },
        expect.anything(),
      ),
    );
    // onSuccess clears the qty back to 1 for the next entry.
    expect(screen.getByTestId('kit-qty')).toHaveValue(1);
  });

  it('surfaces an add failure in an alert', async () => {
    h.add.mockImplementation((_input, opts) => opts?.onError?.(new Error('That would create a cycle.')));
    renderEditor();
    fireEvent.click(screen.getByRole('combobox', { name: 'Component item' }));
    fireEvent.click(screen.getByRole('option', { name: 'Bandage' }));
    fireEvent.click(screen.getByTestId('add-kit-component'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That would create a cycle.'));
  });

  it('excludes the kit itself and already-added components from the picker', () => {
    // The kit is one of the candidate rows, and Bandage is already a component.
    h.candidates = [
      item({ id: 'kit-1', name: 'First-aid kit' }),
      item({ id: 'part-1', name: 'Bandage' }),
      item({ id: 'part-2', name: 'Scissors' }),
    ];
    h.components = [component({ id: 'kc-1', componentItemId: 'part-1', name: 'Bandage' })];
    renderEditor();
    fireEvent.click(screen.getByRole('combobox', { name: 'Component item' }));
    expect(screen.queryByRole('option', { name: 'First-aid kit' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Bandage' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Scissors' })).toBeInTheDocument();
  });
});

describe('KitEditor — component rows', () => {
  it('commits an inline quantity change on blur', () => {
    h.components = [component({ id: 'kc-1', name: 'Bandage', quantity: 2 })];
    renderEditor();
    const qty = screen.getByLabelText('Quantity of Bandage per kit');
    fireEvent.change(qty, { target: { value: '5' } });
    fireEvent.blur(qty);
    expect(h.updateQty).toHaveBeenCalledWith({ id: 'kc-1', kitId: 'kit-1', quantity: 5 });
  });

  it('does not fire an update when the quantity is unchanged', () => {
    h.components = [component({ id: 'kc-1', name: 'Bandage', quantity: 2 })];
    renderEditor();
    const qty = screen.getByLabelText('Quantity of Bandage per kit');
    fireEvent.blur(qty);
    expect(h.updateQty).not.toHaveBeenCalled();
  });

  it('removes a component', () => {
    h.components = [component({ id: 'kc-1', name: 'Bandage' })];
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bandage' }));
    expect(h.remove).toHaveBeenCalledWith({ id: 'kc-1', kitId: 'kit-1' });
  });
});
