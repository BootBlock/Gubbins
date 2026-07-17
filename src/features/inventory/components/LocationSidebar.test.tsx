import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { ToastProvider } from '@/components/foundry';
import { ItemDragProvider, useItemDragSource } from '../item-drag';
import { LocationSidebar } from './LocationSidebar';
import { useLocationExpansionStore } from '../useLocationExpansionStore';

// Keep the test free of the Web Worker / QueryClient: the sidebar (and the
// CreateLocationDialog it mounts on demand) only need these mutation hooks to exist.
// Shared spies (via vi.hoisted) let us assert what a rename/delete dispatched.
const spies = vi.hoisted(() => ({
  update: vi.fn(),
  del: vi.fn(),
  archive: vi.fn(),
  move: vi.fn(),
}));
// Mutable so a test can simulate an in-flight drag-to-nest re-parent / item move (isPending +
// variables) and drive the receiving-row spinner.
const updateState = vi.hoisted(() => ({
  isPending: false,
  variables: undefined as { id: string; input: unknown } | undefined,
}));
const moveState = vi.hoisted(() => ({
  isPending: false,
  variables: undefined as { id: string; locationId: string } | undefined,
}));
// The tag filter and the Edit dialog's location tag editor (issue #84) read react-query hooks;
// stub them so the test stays free of a QueryClient (an undefined index means no filter chips,
// and an empty tag set means the editor renders inertly — both leave behaviour unchanged).
vi.mock('../tags', () => ({
  useLocationTagIndex: () => ({ data: undefined }),
  useLocationTags: () => ({ data: [] }),
  useSetLocationTags: () => ({ mutate: vi.fn() }),
  useTagSuggestions: () => ({ data: [] }),
}));
vi.mock('../mutations', () => ({
  useDeleteLocation: () => ({ mutate: spies.del, isPending: false }),
  useCreateLocation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateLocation: () => ({
    mutate: spies.update,
    isPending: updateState.isPending,
    variables: updateState.variables,
  }),
  useArchiveLocation: () => ({ mutate: spies.archive, isPending: false }),
  useMoveItem: () => ({ mutate: spies.move, isPending: moveState.isPending, variables: moveState.variables }),
}));

afterEach(cleanup);
beforeEach(() => {
  spies.update.mockClear();
  spies.del.mockClear();
  // Default: the move mutation resolves synchronously as a success, so `onSuccess` (toast +
  // announcement) fires. A test that needs a pending move sets `moveState.isPending` instead.
  spies.move.mockReset();
  spies.move.mockImplementation((_vars: unknown, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.());
  updateState.isPending = false;
  updateState.variables = undefined;
  moveState.isPending = false;
  moveState.variables = undefined;
  // Expansion is a persisted module-singleton store; clear it so each test starts from
  // the baseline (top-level open, deeper collapsed) rather than a prior test's toggles.
  useLocationExpansionStore.getState().reset();
});

function node(
  id: string,
  name: string,
  children: LocationTreeNode[] = [],
  extra: Partial<LocationTreeNode> = {},
): LocationTreeNode {
  return {
    id,
    name,
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    updatedAt: 0,
    itemCount: 0,
    children,
    ...extra,
  };
}

// workshop (expanded) → cabinet (collapsed) → drawer; plus a system Unassigned leaf.
// Workshop carries a colour swatch + a description to exercise the tint + tooltip.
const tree: LocationTreeNode[] = [
  node('workshop', 'Workshop', [node('cabinet', 'Cabinet', [node('drawer', 'Drawer')], { itemCount: 2 })], {
    color: 'teal',
    description: 'Main bench area',
    itemCount: 5,
  }),
  node('unassigned', 'Unassigned', [], { isSystem: true }),
];

const flat: LocationWithCount[] = [
  {
    id: 'workshop',
    name: 'Workshop',
    parentId: null,
    isSystem: false,
    description: null,
    color: 'teal',
    updatedAt: 0,
    itemCount: 5,
  },
  {
    id: 'cabinet',
    name: 'Cabinet',
    parentId: 'workshop',
    isSystem: false,
    description: null,
    color: null,
    updatedAt: 0,
    itemCount: 2,
  },
  {
    id: 'drawer',
    name: 'Drawer',
    parentId: 'cabinet',
    isSystem: false,
    description: null,
    color: null,
    updatedAt: 0,
    itemCount: 0,
  },
  {
    id: 'unassigned',
    name: 'Unassigned',
    parentId: null,
    isSystem: true,
    description: null,
    color: null,
    updatedAt: 0,
    itemCount: 0,
  },
];

function renderSidebar(onSelect = vi.fn()) {
  render(
    <ToastProvider>
      <LocationSidebar tree={tree} flat={flat} selectedId={null} onSelect={onSelect} totalCount={7} />
    </ToastProvider>,
  );
  return onSelect;
}

describe('LocationSidebar — accessible APG tree', () => {
  it('renders a single role="tree" with treeitem rows', () => {
    renderSidebar();
    expect(screen.getByRole('tree', { name: 'Locations' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'All items' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Workshop' })).toBeTruthy();
    // Top-level nodes start expanded, so the level-2 child is visible…
    expect(screen.getByRole('treeitem', { name: 'Cabinet' })).toBeTruthy();
    // …but the collapsed level-2 node hides its own child.
    expect(screen.queryByRole('treeitem', { name: 'Drawer' })).toBeNull();
  });

  it('exposes a single tab stop via roving tabindex', () => {
    renderSidebar();
    expect(screen.getByRole('treeitem', { name: 'All items' }).getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('treeitem', { name: 'Workshop' }).getAttribute('tabindex')).toBe('-1');
  });

  it('conveys hierarchy with aria-level and aria-expanded', () => {
    renderSidebar();
    expect(screen.getByRole('treeitem', { name: 'Workshop' }).getAttribute('aria-level')).toBe('1');
    expect(screen.getByRole('treeitem', { name: 'Cabinet' }).getAttribute('aria-level')).toBe('2');
    // Workshop is an expanded parent; Cabinet a collapsed parent.
    expect(screen.getByRole('treeitem', { name: 'Workshop' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('treeitem', { name: 'Cabinet' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('ArrowDown moves focus and the roving tab stop to the next row', () => {
    renderSidebar();
    const all = screen.getByRole('treeitem', { name: 'All items' });
    all.focus();
    fireEvent.keyDown(all, { key: 'ArrowDown' });
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    expect(document.activeElement).toBe(workshop);
    expect(workshop.getAttribute('tabindex')).toBe('0');
    expect(all.getAttribute('tabindex')).toBe('-1');
  });

  it('ArrowRight expands a collapsed parent, revealing its child', () => {
    renderSidebar();
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    cabinet.focus();
    fireEvent.keyDown(cabinet, { key: 'ArrowRight' });
    expect(screen.getByRole('treeitem', { name: 'Drawer' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Cabinet' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('Enter selects the focused location', () => {
    const onSelect = renderSidebar();
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    workshop.focus();
    fireEvent.keyDown(workshop, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('workshop');
  });

  it('clicking the "All items" row selects the null (all) filter', () => {
    const onSelect = renderSidebar();
    fireEvent.click(screen.getByRole('treeitem', { name: 'All items' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('F2 opens an inline rename that commits a new name on Enter', () => {
    renderSidebar();
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    workshop.focus();
    fireEvent.keyDown(workshop, { key: 'F2' });
    const input = screen.getByRole('textbox', { name: 'Rename Workshop' });
    fireEvent.change(input, { target: { value: 'Main Workshop' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(spies.update).toHaveBeenCalledWith({
      id: 'workshop',
      input: { name: 'Main Workshop' },
    });
  });

  it('Escape abandons an inline rename without committing', () => {
    renderSidebar();
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    workshop.focus();
    fireEvent.keyDown(workshop, { key: 'F2' });
    const input = screen.getByRole('textbox', { name: 'Rename Workshop' });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(spies.update).not.toHaveBeenCalled();
    expect(screen.getByRole('treeitem', { name: 'Workshop' })).toBeTruthy();
  });

  it('F2 is a no-op on the system Unassigned row', () => {
    renderSidebar();
    const unassigned = screen.getByRole('treeitem', { name: 'Unassigned' });
    unassigned.focus();
    fireEvent.keyDown(unassigned, { key: 'F2' });
    expect(screen.queryByRole('textbox', { name: 'Rename Unassigned' })).toBeNull();
  });

  it('the pencil button opens the Edit dialog showing the location metadata', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Workshop' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit location' });
    // The dialog seeds the rename field with the current name and surfaces metadata.
    expect(dialog.querySelector('input')?.value).toBe('Workshop');
    expect(screen.getByText('Items stored')).toBeTruthy();
    expect(screen.getByText('Last changed')).toBeTruthy();
  });

  it('does not offer Edit/Delete affordances on the system row', () => {
    renderSidebar();
    expect(screen.queryByRole('button', { name: 'Edit Unassigned' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete Unassigned' })).toBeNull();
  });

  it('deletes an empty location immediately, with no confirmation prompt', () => {
    renderSidebar();
    // Reveal the empty Drawer (itemCount 0), open its Edit dialog, and delete from there.
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    cabinet.focus();
    fireEvent.keyDown(cabinet, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Drawer' }));
    fireEvent.click(screen.getByTestId('edit-location-delete'));
    expect(spies.del).toHaveBeenCalledWith('drawer');
    expect(screen.queryByRole('dialog', { name: 'Delete location?' })).toBeNull();
  });

  it('asks for confirmation before deleting a location that still holds items', () => {
    renderSidebar();
    // Deletion lives in the Edit dialog now — open it, then click Delete location.
    fireEvent.click(screen.getByRole('button', { name: 'Edit Workshop' }));
    fireEvent.click(screen.getByTestId('edit-location-delete'));
    // Nothing deleted yet — the confirmation dialog stands in the way.
    expect(spies.del).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Delete location?' });
    expect(dialog.textContent).toContain('5 items');
    fireEvent.click(screen.getByTestId('confirm-delete-location'));
    expect(spies.del).toHaveBeenCalledWith('workshop', expect.anything());
  });

  it('cancelling the confirmation leaves the location untouched', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Workshop' }));
    fireEvent.click(screen.getByTestId('edit-location-delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(spies.del).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Delete location?' })).toBeNull();
  });

  it('the Delete key also routes a non-empty location through confirmation', () => {
    renderSidebar();
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    workshop.focus();
    fireEvent.keyDown(workshop, { key: 'Delete' });
    expect(spies.del).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Delete location?' })).toBeTruthy();
  });

  it('tints a coloured location name with its swatch class', () => {
    renderSidebar();
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    // The name span carries the location's swatch text class…
    expect(workshop.querySelector('.text-loc-teal')?.textContent).toBe('Workshop');
    // …while an uncoloured location keeps the default colour.
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    expect(cabinet.querySelector('.text-loc-teal')).toBeNull();
  });

  it('remembers a collapsed branch across a remount (persisted expansion)', () => {
    renderSidebar();
    // Workshop starts expanded (top-level default), so its child Cabinet is visible.
    expect(screen.getByRole('treeitem', { name: 'Cabinet' })).toBeTruthy();
    // Collapse Workshop via the keyboard.
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    workshop.focus();
    fireEvent.keyDown(workshop, { key: 'ArrowLeft' });
    expect(screen.queryByRole('treeitem', { name: 'Cabinet' })).toBeNull();

    // Remount (as a page reload would) — the collapse is restored from the store, so
    // the default "top-level open" no longer applies to Workshop.
    cleanup();
    renderSidebar();
    expect(screen.queryByRole('treeitem', { name: 'Cabinet' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'Workshop' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('restores a pre-seeded expansion override on mount', () => {
    // A previous session expanded Cabinet (normally collapsed at level 2).
    useLocationExpansionStore.getState().setExpanded('cabinet', true);
    renderSidebar();
    // Its child Drawer is visible without any interaction this session.
    expect(screen.getByRole('treeitem', { name: 'Drawer' })).toBeTruthy();
  });

  it('prunes a stale override for a location that no longer exists', () => {
    // A ghost id lingers from a since-deleted location; mounting reconciles against `flat`.
    useLocationExpansionStore.getState().setExpanded('ghost', true);
    useLocationExpansionStore.getState().setExpanded('cabinet', true);
    renderSidebar();
    const overrides = useLocationExpansionStore.getState().overrides;
    expect(overrides).not.toHaveProperty('ghost');
    // A live location's override is untouched.
    expect(overrides.cabinet).toBe(true);
  });
});

/** Dispatch a fully-populated pointer event (jsdom's PointerEvent is absent/partial). */
function firePointer(
  target: EventTarget,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { x?: number; y?: number } = {},
) {
  const { x = 0, y = 0 } = init;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: x, clientY: y, pointerType: 'mouse', pointerId: 1, button: 0 });
  act(() => {
    target.dispatchEvent(event);
  });
}

describe('LocationSidebar — drag-to-nest', () => {
  afterEach(() => {
    // Restore the hit-test stub some tests below install (jsdom has no layout).
    // @ts-expect-error deleting the stubbed method restores jsdom's default (returns null).
    delete document.elementFromPoint;
  });

  // Drag-to-nest needs the pointer-drag provider that InventoryScreen supplies in production.
  function renderWithDrag() {
    render(
      <ToastProvider>
        <ItemDragProvider>
          <LocationSidebar tree={tree} flat={flat} selectedId={null} onSelect={vi.fn()} totalCount={7} />
        </ItemDragProvider>
      </ToastProvider>,
    );
  }

  it('re-parents a location dragged onto another location row', () => {
    renderWithDrag();
    // Reveal Drawer (nested under the collapsed Cabinet) so it can be dragged out to Workshop.
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    cabinet.focus();
    fireEvent.keyDown(cabinet, { key: 'ArrowRight' });
    const drawer = screen.getByRole('treeitem', { name: 'Drawer' });
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });

    // Point every hit-test at the Workshop row, then drag Drawer onto it.
    document.elementFromPoint = vi.fn(() => workshop);
    firePointer(drawer, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 }); // past the activation threshold
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(spies.update).toHaveBeenCalledWith(
      { id: 'drawer', input: { parentId: 'workshop' } },
      expect.anything(),
    );
  });

  it('does not re-parent a location dropped onto its own current parent (a no-op)', () => {
    renderWithDrag();
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });

    // Cabinet already lives under Workshop, so nesting it there again is vetoed — no highlight,
    // no update.
    document.elementFromPoint = vi.fn(() => workshop);
    firePointer(cabinet, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(spies.update).not.toHaveBeenCalled();
  });

  it('shows a busy spinner on the location whose re-parent is in flight', () => {
    // Simulate the drag-to-nest mutation being in flight for Cabinet.
    updateState.isPending = true;
    updateState.variables = { id: 'cabinet', input: { parentId: 'workshop' } };
    renderWithDrag();

    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    expect(cabinet.getAttribute('aria-busy')).toBe('true');
    // The moving row surfaces a labelled progress spinner in place of its item count…
    expect(screen.getByRole('status', { name: 'Moving Cabinet' })).toBeTruthy();
    // …while an unaffected sibling row stays idle.
    expect(screen.getByRole('treeitem', { name: 'Workshop' }).getAttribute('aria-busy')).toBeNull();
  });

  it('will not start a second re-parent while one is already in flight', () => {
    // A nest is mid-flight, so rows are non-draggable and `nestLocation` self-guards — spamming a
    // fresh drag-and-drop must not stack a second concurrent re-parent.
    updateState.isPending = true;
    renderWithDrag();

    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    cabinet.focus();
    fireEvent.keyDown(cabinet, { key: 'ArrowRight' }); // reveal Drawer
    const drawer = screen.getByRole('treeitem', { name: 'Drawer' });
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });

    document.elementFromPoint = vi.fn(() => workshop);
    firePointer(drawer, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    expect(spies.update).not.toHaveBeenCalled();
  });
});

describe('LocationSidebar — drag-to-move item feedback', () => {
  afterEach(() => {
    // @ts-expect-error restore jsdom's default hit-test (returns null).
    delete document.elementFromPoint;
  });

  // An inventory item drag source (as ItemCard/ItemRow provide) plus the sidebar, both under the
  // pointer-drag provider and a ToastProvider (as <App> supplies).
  function renderWithItemSource() {
    function ItemSource() {
      const drag = useItemDragSource({ id: 'item-1', name: 'NE555 timer' });
      return (
        <div {...drag} data-testid="item-source">
          NE555 timer
        </div>
      );
    }
    render(
      <ToastProvider>
        <ItemDragProvider>
          <ItemSource />
          <LocationSidebar tree={tree} flat={flat} selectedId={null} onSelect={vi.fn()} totalCount={7} />
        </ItemDragProvider>
      </ToastProvider>,
    );
  }

  it('moves the item and surfaces a toast + live announcement when dropped on a location', () => {
    renderWithItemSource();
    const source = screen.getByTestId('item-source');
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });

    document.elementFromPoint = vi.fn(() => workshop);
    firePointer(source, 'pointerdown', { x: 10, y: 10 });
    firePointer(window, 'pointermove', { x: 40, y: 40 });
    firePointer(window, 'pointerup', { x: 40, y: 40 });

    // The move dispatches to the dropped-on location…
    expect(spies.move).toHaveBeenCalledWith({ id: 'item-1', locationId: 'workshop' }, expect.anything());
    // …a visible (and aria-live) toast confirms the result, so the drop is never silent even
    // before the sidebar counts refresh…
    expect(screen.getByText('Moved NE555 timer to Workshop.')).toBeTruthy();
    // …and the live region carries the immediate "Moving…" start cue (the toast owns the result,
    // so there's no second "moved" message to double-announce).
    expect(screen.getByTestId('location-move-live-region').textContent).toContain(
      'Moving NE555 timer to Workshop…',
    );
  });

  it('shows a busy spinner on the location currently receiving a dragged item', () => {
    // Simulate the move mutation being in flight, targeting Workshop.
    moveState.isPending = true;
    moveState.variables = { id: 'item-1', locationId: 'workshop' };
    renderWithItemSource();

    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    expect(workshop.getAttribute('aria-busy')).toBe('true');
    // A labelled progress spinner takes the count's place while the item lands…
    expect(screen.getByRole('status', { name: 'Moving item into Workshop' })).toBeTruthy();
    // …while a sibling not receiving anything stays idle.
    expect(screen.getByRole('treeitem', { name: 'Cabinet' }).getAttribute('aria-busy')).toBeNull();
  });
});
