import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, within } from '@testing-library/react';
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
  create: vi.fn(),
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
  // The tag editor's combobox offers the existing tag names (issue #84).
  useTagNames: () => ({ data: { rows: [] } }),
}));
// Same reasoning for the Edit dialog's inheritable-fields editor (issue #97): it reads
// react-query hooks, and an empty dictionary renders it inertly without a QueryClient.
vi.mock('../categories', () => ({
  useFieldDefs: () => ({ data: [] }),
  useLocationFieldValues: () => ({ data: [], isLoading: false }),
  // The sidebar search's field-value haystack (issue #617). Undefined means "not loaded", which
  // leaves matching on the path + description the flat list already carries.
  useLocationFieldSearchText: () => ({ data: undefined }),
  useSetLocationFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveLocationFieldValue: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../mutations', () => ({
  useDeleteLocation: () => ({ mutate: spies.del, isPending: false }),
  useUpdateLocation: () => ({
    mutate: spies.update,
    isPending: updateState.isPending,
    variables: updateState.variables,
  }),
  useArchiveLocation: () => ({ mutate: spies.archive, isPending: false }),
  useCreateLocationPath: () => ({ mutate: spies.create, isPending: false }),
  useMoveItem: () => ({ mutate: spies.move, isPending: moveState.isPending, variables: moveState.variables }),
}));
// The location-list export (issue #617, `N7`) re-reads the list from the repository rather than
// serialising the tree on screen. Stub that one read — and the download side-effect — so the test
// stays free of a DB worker while still being able to assert *which* rows were serialised.
const exportSpies = vi.hoisted(() => ({
  readPage: vi.fn(async () => ({
    rows: [{ id: 'archived-bin', name: 'Archived bin', parentId: null, archivedAt: 1, itemCount: 0 }],
    limit: 100,
    offset: 0,
    hasMore: false,
  })),
  download: vi.fn(),
}));
vi.mock('../queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queries')>()),
  readLocationsPage: exportSpies.readPage,
}));
vi.mock('@/features/export/download', () => ({ download: exportSpies.download }));

afterEach(cleanup);
beforeEach(() => {
  spies.update.mockClear();
  spies.del.mockClear();
  spies.archive.mockClear();
  spies.create.mockReset();
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
  exportSpies.readPage.mockClear();
  exportSpies.download.mockClear();
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
    // The rename also passes an `onError` reporter so a failed inline rename isn't silent (#389).
    expect(spies.update).toHaveBeenCalledWith(
      { id: 'workshop', input: { name: 'Main Workshop' } },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
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

  it('puts Print label last on an editable row so it lines up with the print-only rows (issue #613)', () => {
    renderSidebar();
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    const edit = within(workshop).getByRole('button', { name: 'Edit Workshop' });
    const print = within(workshop).getByRole('button', { name: 'Print label for Workshop' });
    // Print is the row's *last* action, so it occupies the same column as the lone Print
    // button of a system row — which can be printed but not edited.
    expect(edit.compareDocumentPosition(print) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const unassigned = screen.getByRole('treeitem', { name: 'Unassigned' });
    expect(within(unassigned).getByRole('button', { name: 'Print label for Unassigned' })).toBeTruthy();
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

  it('no longer offers an archive control on the location row itself', () => {
    renderSidebar();
    // Archiving moved into the Edit dialog — the hover row only carries Edit (and Print label).
    expect(screen.queryByRole('button', { name: 'Archive Workshop' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore Workshop' })).toBeNull();
  });

  it('archives a live location from the Edit dialog and closes it', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Workshop' }));
    fireEvent.click(screen.getByTestId('edit-location-archive'));
    expect(spies.archive).toHaveBeenCalledWith({ id: 'workshop', archived: true });
    expect(screen.queryByRole('dialog', { name: 'Edit location' })).toBeNull();
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

describe('LocationSidebar — name search (issue #129)', () => {
  function search(text: string) {
    const box = screen.getByRole('textbox', { name: 'Search locations' });
    fireEvent.change(box, { target: { value: text } });
    return box;
  }

  it('narrows the tree to matches and opens the branches leading to them', () => {
    renderSidebar();
    // Drawer starts hidden — its parent Cabinet is collapsed by default.
    expect(screen.queryByRole('treeitem', { name: 'Drawer' })).toBeNull();

    search('drawer');

    // The match is revealed without the user expanding anything…
    expect(screen.getByRole('treeitem', { name: 'Drawer' })).toBeTruthy();
    // …with its ancestor path kept for context…
    expect(screen.getByRole('treeitem', { name: 'Cabinet' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Workshop' })).toBeTruthy();
    // …and everything that doesn't lead to a match dropped.
    expect(screen.queryByRole('treeitem', { name: 'Unassigned' })).toBeNull();
    // "All items" is not a location and never filters away.
    expect(screen.getByRole('treeitem', { name: 'All items' })).toBeTruthy();
  });

  it('matches on the ancestry path, so a parent name narrows to its subtree', () => {
    renderSidebar();
    search('workshop');
    expect(screen.getByRole('treeitem', { name: 'Workshop' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Cabinet' })).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'Unassigned' })).toBeNull();
  });

  it('reports a query that matches nothing', () => {
    renderSidebar();
    search('nothing here');
    expect(screen.getByText('No locations match “nothing here”.')).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'Workshop' })).toBeNull();
  });

  it('restores the tree — and the user’s own expansion — when the search is cleared', () => {
    renderSidebar();
    search('drawer');
    expect(screen.getByRole('treeitem', { name: 'Drawer' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear location search' }));

    expect(screen.getByRole('treeitem', { name: 'Unassigned' })).toBeTruthy();
    // The forced expansion was never written to the store, so Cabinet is collapsed again.
    expect(screen.queryByRole('treeitem', { name: 'Drawer' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'Cabinet' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape in a non-empty search box clears it', () => {
    renderSidebar();
    const box = search('drawer');
    box.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('keeps arrow-key navigation consistent with the filtered rows', () => {
    renderSidebar();
    search('drawer');

    const all = screen.getByRole('treeitem', { name: 'All items' });
    all.focus();
    fireEvent.keyDown(all, { key: 'ArrowDown' });
    const workshop = screen.getByRole('treeitem', { name: 'Workshop' });
    expect(document.activeElement).toBe(workshop);

    fireEvent.keyDown(workshop, { key: 'ArrowDown' });
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    expect(document.activeElement).toBe(cabinet);

    // Cabinet is force-expanded by the filter, so Drawer really is the next row down — the
    // keyboard walks exactly the rows the filtered tree shows.
    fireEvent.keyDown(cabinet, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Drawer' }));
  });
});

describe('LocationSidebar — large trees (issue #129)', () => {
  // 300 top-level locations: comfortably past the windowing threshold.
  const bigTree: LocationTreeNode[] = Array.from({ length: 300 }, (_, i) =>
    node(`loc-${i}`, `Location ${i}`),
  );
  const bigFlat: LocationWithCount[] = bigTree.map((n) => ({
    id: n.id,
    name: n.name,
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    updatedAt: 0,
    itemCount: 0,
  }));

  it('renders only a window of rows, but still reports the full set size to assistive tech', () => {
    render(
      <ToastProvider>
        <LocationSidebar tree={bigTree} flat={bigFlat} selectedId={null} onSelect={vi.fn()} totalCount={0} />
      </ToastProvider>,
    );

    const rows = screen.getAllByRole('treeitem');
    // Far fewer nodes in the DOM than locations in the tree — that is the whole point.
    expect(rows.length).toBeLessThan(bigTree.length);
    // Every rendered row still says how many siblings it really has (301 = 300 + "All items"),
    // so a screen reader announces "2 of 301" rather than counting the rendered handful.
    expect(rows[0]!.getAttribute('aria-setsize')).toBe('301');
    expect(screen.getByRole('treeitem', { name: 'All items' }).getAttribute('aria-posinset')).toBe('1');
  });

  it('keeps the whole tree in the DOM below the threshold', () => {
    renderSidebar();
    // 1 "All items" + Workshop + Cabinet + Unassigned (Drawer's parent is collapsed).
    expect(screen.getAllByRole('treeitem').length).toBe(4);
  });
});

describe('LocationSidebar — volumetric fullness indicator (issue #457)', () => {
  // A canonical mm³ aggregate for a location holding a single measured item.
  const totals = (usedVolume: number) => ({
    usedVolume,
    measuredUnits: 1,
    totalUnits: 1,
    measuredItems: 1,
    totalItems: 1,
  });

  // Three location kinds:
  //  • Overflow bin — measured (10cm cube ⇒ 1,000,000 mm³) and volume-over-full (5× the space),
  //    plus a *count* capacity it is well within (3 of 10) so the count text has its own reading.
  //  • Roomy shelf — measured and a quarter full by volume (not over).
  //  • Count-only crate — a count capacity but no internal size, so no honest volume reading.
  const volumeTree: LocationTreeNode[] = [
    node('over', 'Overflow bin', [], {
      itemCount: 3,
      capacity: 10,
      width: 100,
      height: 100,
      depth: 100,
      volumeTotals: totals(5_000_000),
    }),
    node('roomy', 'Roomy shelf', [], {
      itemCount: 1,
      width: 100,
      height: 100,
      depth: 100,
      volumeTotals: totals(250_000),
    }),
    node('countonly', 'Count-only crate', [], { itemCount: 4, capacity: 10 }),
  ];
  const volumeFlat: LocationWithCount[] = volumeTree.map((n) => ({
    id: n.id,
    name: n.name,
    parentId: null,
    isSystem: false,
    description: null,
    color: null,
    updatedAt: 0,
    itemCount: n.itemCount,
  }));

  function renderVolumeSidebar() {
    render(
      <ToastProvider>
        <LocationSidebar
          tree={volumeTree}
          flat={volumeFlat}
          selectedId={null}
          onSelect={vi.fn()}
          totalCount={8}
        />
      </ToastProvider>,
    );
  }

  it('shows a labelled volume bar on a measured, over-full location — without tinting its count', () => {
    renderVolumeSidebar();
    const row = screen.getByRole('treeitem', { name: 'Overflow bin' });

    // The volume reading rides a distinct, accessibly-labelled indicator (role="img")…
    const indicator = within(row).getByRole('img', { name: 'Volume over capacity (100% full)' });
    expect(indicator).toBeTruthy();
    // …whose fill uses the destructive token when over capacity (never a raw colour).
    expect(indicator.querySelector('.bg-destructive')).toBeTruthy();

    // The count text stays count-based (3 of 10 ⇒ not full): the volume overflow must NOT bleed
    // into the number's tint (guards the reverted "count shown in red for a volume overflow" bug).
    const count = within(row).getByText('3/10');
    expect(count.className).toContain('text-muted-foreground');
    expect(count.className).not.toContain('text-glyph-danger');
    expect(count.className).not.toContain('text-warning');
  });

  it('shows a primary-tinted bar for a measured location that is within its volume', () => {
    renderVolumeSidebar();
    const row = screen.getByRole('treeitem', { name: 'Roomy shelf' });
    const indicator = within(row).getByRole('img', { name: 'Volume 25% full' });
    expect(indicator.querySelector('.bg-primary')).toBeTruthy();
    expect(indicator.querySelector('.bg-destructive')).toBeNull();
  });

  it('shows no volume indicator for a count-only location with no measured size', () => {
    renderVolumeSidebar();
    const row = screen.getByRole('treeitem', { name: 'Count-only crate' });
    expect(within(row).queryByRole('img')).toBeNull();
    // …and the "All items" synthetic row (no location) never carries one either.
    const allItems = screen.getByRole('treeitem', { name: 'All items' });
    expect(within(allItems).queryByRole('img')).toBeNull();
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
    // Ending a drag arms a one-shot capture listener on `window` that swallows the click the
    // release synthesises (see `item-drag`), disarming itself on a timer ~350ms later — long
    // after the next test has started. Spend it here with a throwaway click so it can't eat the
    // first click of whichever test runs next.
    window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

describe('LocationSidebar — compact placement in the drawer (issue #147)', () => {
  /** Render the pane as it appears inside the off-canvas drawer on a phone. */
  function renderCompact() {
    render(
      <ToastProvider>
        <LocationSidebar
          compact
          tree={tree}
          flat={flat}
          selectedId={null}
          onSelect={vi.fn()}
          totalCount={7}
        />
      </ToastProvider>,
    );
    return document.querySelector('aside')!;
  }

  it('fills the drawer instead of holding the fixed master-pane column', () => {
    const aside = renderCompact();
    expect(aside.className).toContain('w-full');
    // The 256px column is exactly what does not fit on a phone.
    expect(aside.className).not.toContain('w-64');
  });

  it('keeps the fixed column when placed beside the item list', () => {
    renderSidebar();
    const aside = document.querySelector('aside')!;
    expect(aside.className).toContain('w-64');
    expect(aside.className).not.toContain('w-full');
  });

  it('hides its own heading visually — the drawer already shows it — but still labels the tree', () => {
    renderCompact();
    const heading = screen.getByRole('heading', { name: 'Locations' });
    expect(heading.className).toContain('sr-only');
    // The tree's accessible name comes from that heading, so it must stay in the a11y tree.
    expect(screen.getByRole('tree', { name: 'Locations' })).toBeTruthy();
  });

  it('still offers "Add location" — the drawer must not cost the user an action', () => {
    renderCompact();
    expect(screen.getByRole('button', { name: 'Add location' })).toBeTruthy();
  });
});

describe('LocationSidebar — a newly created location is selected (issue #612)', () => {
  /** Drive the "+" dialog through to a successful create of `created`. */
  function createLocation(created: { id: string; name: string; parentId: string | null }) {
    fireEvent.click(screen.getByRole('button', { name: 'Add location' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: created.name } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    // The repository resolves each leaf of the (possibly nested) name; a plain name is one.
    const onSuccess = spies.create.mock.calls[0][1].onSuccess as (rows: unknown[]) => void;
    act(() => onSuccess([created]));
  }

  it('selects the location the Add dialog just created', () => {
    const onSelect = renderSidebar();
    createLocation({ id: 'bin3', name: 'Bin 3', parentId: 'cabinet' });
    expect(onSelect).toHaveBeenCalledWith('bin3');
  });

  it('opens the branch it landed in, so its row is not buried in a collapsed ancestor', () => {
    renderSidebar();
    // Cabinet sits at level 2 and so starts collapsed — its child Drawer is out of sight.
    expect(screen.queryByRole('treeitem', { name: 'Drawer' })).toBeNull();
    createLocation({ id: 'bin3', name: 'Bin 3', parentId: 'cabinet' });
    // Creating inside Cabinet opens it (and everything above it), revealing its contents.
    expect(screen.getByRole('treeitem', { name: 'Drawer' })).toBeTruthy();
    const overrides = useLocationExpansionStore.getState().overrides;
    expect(overrides.cabinet).toBe(true);
    expect(overrides.workshop).toBe(true);
  });

  it('keeps the tree in the tab order while the new row is still on its way', () => {
    renderSidebar();
    createLocation({ id: 'bin3', name: 'Bin 3', parentId: 'cabinet' });
    // The selected location has no row until the refetched tree carries it, so the tab stop
    // parks on "All items" — a tree with no `tabindex="0"` row would be unreachable by Tab.
    const tabStops = document.querySelectorAll('[role="treeitem"][tabindex="0"]');
    expect(tabStops).toHaveLength(1);
    expect(tabStops[0]!.textContent).toContain('All items');
  });

  it('waits for the refetched tree when the create also added the levels above it', () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <ToastProvider>
        <LocationSidebar tree={tree} flat={flat} selectedId={null} onSelect={onSelect} totalCount={7} />
      </ToastProvider>,
    );
    // "Cabinet/Shelf B/Bin 3" creates Shelf B on the way through, so at this point nothing in
    // `flat` knows where Bin 3 sits — the branch cannot be opened yet.
    createLocation({ id: 'bin3', name: 'Cabinet/Shelf B/Bin 3', parentId: 'shelfb' });
    expect(onSelect).toHaveBeenCalledWith('bin3');
    expect(useLocationExpansionStore.getState().overrides.cabinet).toBeUndefined();

    // The invalidated locations query lands, bringing both new levels with it.
    const grown = [
      ...flat,
      { ...flat[1]!, id: 'shelfb', name: 'Shelf B', parentId: 'cabinet', itemCount: 0 },
      { ...flat[1]!, id: 'bin3', name: 'Bin 3', parentId: 'shelfb', itemCount: 0 },
    ];
    rerender(
      <ToastProvider>
        <LocationSidebar tree={tree} flat={grown} selectedId="bin3" onSelect={onSelect} totalCount={7} />
      </ToastProvider>,
    );
    const overrides = useLocationExpansionStore.getState().overrides;
    expect(overrides.shelfb).toBe(true);
    expect(overrides.cabinet).toBe(true);
    expect(overrides.workshop).toBe(true);
  });
});

/**
 * The location list export (issue #617, `N7`). The sidebar is the app's location list, so this is
 * where the shared list-export control lives — and it must serialise the *list*, not the tree on
 * screen, which "Show archived", the tag chips and the search box have all already narrowed.
 */
describe('LocationSidebar — export the location list', () => {
  async function exportCsv() {
    renderSidebar();
    fireEvent.click(screen.getByTestId('export-locations'));
    fireEvent.click(await screen.findByTestId('export-locations-csv'));
    // The build walks the pages and serialises before handing the blob to the download.
    await vi.waitFor(() => expect(exportSpies.download).toHaveBeenCalled());
    const [blob, name] = exportSpies.download.mock.calls[0]! as unknown as [Blob, string];
    return { text: await blob.text(), name };
  }

  it('offers the shared export control beside the add button', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Export locations' })).toBeTruthy();
  });

  it('re-reads the whole list rather than serialising the filtered tree', async () => {
    const { text, name } = await exportCsv();
    expect(exportSpies.readPage).toHaveBeenCalled();
    // The stubbed read returns a location the sidebar is *not* showing (it is archived, and the
    // "Show archived" toggle is off), so its presence proves the file came from the repository.
    expect(text).toContain('Archived bin');
    expect(text).not.toContain('Workshop');
    expect(name).toMatch(/^gubbins-locations-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('carries what nothing else exported — the description and the walk order', async () => {
    exportSpies.readPage.mockResolvedValueOnce({
      rows: [
        {
          id: 'shelf',
          name: 'Shelf B',
          parentId: null,
          description: 'Overflow for the workshop',
          walkOrder: 3,
          itemCount: 0,
        },
      ],
      limit: 100,
      offset: 0,
      hasMore: false,
    } as never);
    const { text } = await exportCsv();
    expect(text).toContain('Overflow for the workshop');
    expect(text).toContain('Walk order');
    expect(text.split('\r\n')[1]).toContain('3');
  });
});
