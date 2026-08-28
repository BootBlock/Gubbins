import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/foundry';
import { writeSuspendedError } from '@/features/storage/write-gate';
import type { Item, KitComponent } from '@/db/repositories';

/**
 * Behaviour tests for the {@link KitEditor} item-detail facet (Kits v1 — definition +
 * availability; v2 — assemble / disassemble; v3 — nested-kit roll-up, cascade and destination).
 * The buildable maths lives in the pure `buildableCount` / `rollUpBuildable` seam (covered by
 * kit-availability.test.ts) and runs here for real; this pins the *editor's* logic — the headline
 * "You can build N" line and its limiting note, the roll-up line + cascade toggle when the kit
 * nests, the destination picker, the add flow (item picker + qty → exact mutation payload), inline
 * re-quantify on blur, remove, and the assemble/disassemble controls (ceiling-bounded buttons →
 * exact mutation payload). Per the component-test conventions every hook the component calls is
 * mocked (`../hooks` + the item-list/locations queries); `useToast` runs for real in a `ToastProvider`.
 */
const h = vi.hoisted(() => ({
  components: [] as KitComponent[],
  candidates: [] as Item[],
  locations: [] as { id: string; name: string }[],
  rollUp: undefined as
    { count: number; limiting: { itemId: string; name: string }[]; subKitCount: number } | undefined,
  add: vi.fn(),
  updateQty: vi.fn(),
  remove: vi.fn(),
  assemble: vi.fn(),
  disassemble: vi.fn(),
}));

vi.mock('../hooks', () => ({
  useItemKit: () => ({ data: h.components }),
  useKitAvailability: () => ({ data: h.rollUp }),
  useAddKitComponent: () => ({ mutate: h.add, isPending: false }),
  useUpdateKitComponentQty: () => ({ mutate: h.updateQty, isPending: false }),
  useRemoveKitComponent: () => ({ mutate: h.remove, isPending: false }),
  useAssembleKit: () => ({ mutate: h.assemble, isPending: false }),
  useDisassembleKit: () => ({ mutate: h.disassemble, isPending: false }),
}));

vi.mock('@/features/inventory/queries', () => ({
  useInventoryItems: () => ({ data: { pages: [{ rows: h.candidates }] } }),
  useLocations: () => ({ data: { rows: h.locations } }),
  // The picker searches the catalogue rather than reading a fixed page of it (issue #484). Nothing
  // is typed into it here, so only its browse read answers; the by-id read is what refills the box
  // when a value is set from outside, which these tests never do.
  useItemRelevanceSearch: () => ({ data: undefined }),
  useItem: () => ({ data: undefined }),
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
  trackingMode: 'DISCRETE',
  sort: 0,
  ...o,
});

function renderEditor(kit: Item = item()) {
  return render(
    <ToastProvider>
      <KitEditor item={kit} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  h.components = [];
  h.candidates = [item({ id: 'part-1', name: 'Bandage' }), item({ id: 'part-2', name: 'Scissors' })];
  h.locations = [{ id: 'loc-b', name: 'Finished goods' }];
  h.rollUp = undefined;
  h.add.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.updateQty.mockReset();
  h.remove.mockReset();
  h.assemble.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.disassemble.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
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
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Scissors' }));
    fireEvent.change(screen.getByTestId('kit-qty'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('add-kit-component'));

    await waitFor(() =>
      expect(h.add).toHaveBeenCalledWith(
        { kitId: 'kit-1', componentItemId: 'part-2', quantity: 3 },
        expect.anything(),
      ),
    );
    // onSuccess clears the qty back to 1 for the next entry.
    expect(screen.getByTestId('kit-qty')).toHaveValue('1');
  });

  it('surfaces an add failure in an alert', async () => {
    h.add.mockImplementation((_input, opts) => opts?.onError?.(new Error('That would create a cycle.')));
    renderEditor();
    fireEvent.click(screen.getByRole('combobox', { name: 'Component item' }));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Bandage' }));
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

describe('KitEditor — assemble / disassemble (v2)', () => {
  it('hides the assemble panel until the kit has components', () => {
    renderEditor();
    expect(screen.queryByTestId('kit-assemble')).toBeNull();
  });

  it('shows the buildable and on-hand bounds', () => {
    h.components = [component({ quantity: 2, stock: 10 })]; // 5 buildable
    renderEditor(item({ quantity: 4 }));
    expect(screen.getByTestId('kit-build-bounds')).toHaveTextContent('Up to 5 buildable · 4 on hand');
  });

  it('assembles the entered count and gates the button by the buildable ceiling', () => {
    h.components = [component({ quantity: 2, stock: 10 })]; // 5 buildable
    renderEditor(item({ quantity: 0 }));

    const qty = screen.getByTestId('kit-build-qty');
    fireEvent.change(qty, { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('assemble-kit'));
    expect(h.assemble).toHaveBeenCalledWith({ kitId: 'kit-1', count: 3 }, expect.anything());
    // onSuccess resets the count back to 1.
    expect(qty).toHaveValue('1');

    // Above the ceiling the Assemble button is disabled.
    fireEvent.change(qty, { target: { value: '6' } });
    expect(screen.getByTestId('assemble-kit')).toBeDisabled();
  });

  it('disassembles the entered count, gated by the kit on-hand quantity', () => {
    h.components = [component({ quantity: 2, stock: 10 })];
    renderEditor(item({ quantity: 2 }));

    // Disassembly is capped at the 2 on hand.
    const qty = screen.getByTestId('kit-build-qty');
    fireEvent.change(qty, { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('disassemble-kit'));
    expect(h.disassemble).toHaveBeenCalledWith({ kitId: 'kit-1', count: 2 }, expect.anything());

    fireEvent.change(qty, { target: { value: '3' } });
    expect(screen.getByTestId('disassemble-kit')).toBeDisabled();
  });

  it('disables disassemble when no kits are on hand', () => {
    h.components = [component({ quantity: 2, stock: 10 })];
    renderEditor(item({ quantity: 0 }));
    expect(screen.getByTestId('disassemble-kit')).toBeDisabled();
    // …but assembling is available (there is component stock).
    expect(screen.getByTestId('assemble-kit')).not.toBeDisabled();
  });

  it('passes a chosen destination location to the assemble mutation', () => {
    h.components = [component({ quantity: 1, stock: 10 })];
    renderEditor(item({ quantity: 0 }));

    fireEvent.change(screen.getByTestId('kit-build-qty'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Destination' }));
    fireEvent.click(screen.getByRole('option', { name: 'Finished goods' }));
    fireEvent.click(screen.getByTestId('assemble-kit'));

    expect(h.assemble).toHaveBeenCalledWith(
      { kitId: 'kit-1', count: 2, destinationLocationId: 'loc-b', cascade: undefined },
      expect.anything(),
    );
  });

  it('humanises a build failure in the toast rather than showing its internal text (#681)', async () => {
    // The storage Hard Stop: highly actionable, but only once the error-copy seam has turned
    // "Storage is full (Hard Stop)" into a sentence saying what to do about it.
    h.components = [component({ quantity: 1, stock: 10 })];
    h.assemble.mockImplementation((_input, opts) => opts?.onError?.(writeSuspendedError()));
    renderEditor(item({ quantity: 0 }));

    fireEvent.click(screen.getByTestId('assemble-kit'));
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveTextContent(
        'Saving is paused because storage is nearly full.',
      ),
    );
    expect(screen.getByTestId('toast')).not.toHaveTextContent('Hard Stop');
  });

  it('keeps an authored failure sentence, and falls back to the call site copy for raw text', async () => {
    h.components = [component({ quantity: 1, stock: 10 })];
    h.disassemble.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('That kit is checked out.')),
    );
    const { unmount } = renderEditor(item({ quantity: 5 }));
    fireEvent.click(screen.getByTestId('disassemble-kit'));
    await waitFor(() => expect(screen.getByTestId('toast')).toHaveTextContent('That kit is checked out.'));
    unmount();

    // Unclassifiable raw SQLite text must not reach the user; the handler's own copy does.
    h.disassemble.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('no such column: kits.wibble')),
    );
    renderEditor(item({ quantity: 5 }));
    fireEvent.click(screen.getByTestId('disassemble-kit'));
    await waitFor(() =>
      expect(screen.getByTestId('toast')).toHaveTextContent('Could not disassemble the kit.'),
    );
  });
});

describe('KitEditor — nested-kit roll-up & cascade (v3)', () => {
  it('surfaces the roll-up line and buildable sub-kit count only when the kit nests', () => {
    h.components = [component({ name: 'Trauma pack', quantity: 1, stock: 0 })];
    // Flat kit: no roll-up line.
    h.rollUp = { count: 0, limiting: [], subKitCount: 0 };
    const { rerender } = renderEditor(item({ quantity: 0 }));
    expect(screen.queryByTestId('kit-rollup')).toBeNull();
    expect(screen.queryByTestId('kit-cascade-toggle')).toBeNull();

    // Nested kit: the roll-up line names the count, sub-kit count and deepest constraint.
    h.rollUp = { count: 12, limiting: [{ itemId: 'gauze', name: 'Gauze' }], subKitCount: 1 };
    rerender(
      <ToastProvider>
        <KitEditor item={item({ quantity: 0 })} />
      </ToastProvider>,
    );
    const line = screen.getByTestId('kit-rollup');
    expect(line).toHaveTextContent('Up to 12');
    expect(line).toHaveTextContent('1 buildable sub-kit');
    expect(line).toHaveTextContent('Gauze');
  });

  it('raises the assemble ceiling and sends cascade:true when "assemble sub-kits" is on', () => {
    h.components = [component({ name: 'Trauma pack', quantity: 1, stock: 3 })]; // direct: 3 buildable
    h.rollUp = { count: 12, limiting: [{ itemId: 'gauze', name: 'Gauze' }], subKitCount: 1 };
    renderEditor(item({ quantity: 0 }));

    const qty = screen.getByTestId('kit-build-qty');
    fireEvent.change(qty, { target: { value: '8' } });
    // 8 exceeds the direct ceiling of 3, so Assemble is disabled until cascade is enabled.
    expect(screen.getByTestId('assemble-kit')).toBeDisabled();
    expect(screen.getByTestId('kit-build-bounds')).toHaveTextContent('Up to 3 buildable');

    fireEvent.click(screen.getByRole('checkbox'));
    // Now bounded by the roll-up count of 12; the button enables and the bounds update.
    expect(screen.getByTestId('kit-build-bounds')).toHaveTextContent('Up to 12 buildable');
    expect(screen.getByTestId('assemble-kit')).not.toBeDisabled();

    fireEvent.click(screen.getByTestId('assemble-kit'));
    expect(h.assemble).toHaveBeenCalledWith(
      { kitId: 'kit-1', count: 8, destinationLocationId: undefined, cascade: true },
      expect.anything(),
    );
  });

  it('shows a gauge component’s net value as "remaining" rather than "in stock"', () => {
    h.components = [
      component({ name: 'Adhesive', trackingMode: 'CONSUMABLE_GAUGE', quantity: 50, stock: 220 }),
    ];
    renderEditor(item({ quantity: 0 }));
    expect(screen.getByTestId('kit-component')).toHaveTextContent('220 remaining');
  });
});
