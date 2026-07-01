import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { LocationTreeNode, LocationWithCount } from '@/db/repositories';
import { LocationSidebar } from './LocationSidebar';

// Keep the test free of the Web Worker / QueryClient: the sidebar (and the
// CreateLocationDialog it mounts on demand) only need these mutation hooks to exist.
// Shared spies (via vi.hoisted) let us assert what a rename/delete dispatched.
const spies = vi.hoisted(() => ({
  update: vi.fn(),
  del: vi.fn(),
  archive: vi.fn(),
}));
vi.mock('../mutations', () => ({
  useDeleteLocation: () => ({ mutate: spies.del, isPending: false }),
  useCreateLocation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateLocation: () => ({ mutate: spies.update, isPending: false }),
  useArchiveLocation: () => ({ mutate: spies.archive, isPending: false }),
}));

afterEach(cleanup);
beforeEach(() => {
  spies.update.mockClear();
  spies.del.mockClear();
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
  node(
    'workshop',
    'Workshop',
    [node('cabinet', 'Cabinet', [node('drawer', 'Drawer')], { itemCount: 2 })],
    { color: 'teal', description: 'Main bench area', itemCount: 5 },
  ),
  node('unassigned', 'Unassigned', [], { isSystem: true }),
];

const flat: LocationWithCount[] = [
  { id: 'workshop', name: 'Workshop', parentId: null, isSystem: false, description: null, color: 'teal', updatedAt: 0, itemCount: 5 },
  { id: 'cabinet', name: 'Cabinet', parentId: 'workshop', isSystem: false, description: null, color: null, updatedAt: 0, itemCount: 2 },
  { id: 'drawer', name: 'Drawer', parentId: 'cabinet', isSystem: false, description: null, color: null, updatedAt: 0, itemCount: 0 },
  { id: 'unassigned', name: 'Unassigned', parentId: null, isSystem: true, description: null, color: null, updatedAt: 0, itemCount: 0 },
];

function renderSidebar(onSelect = vi.fn()) {
  render(
    <LocationSidebar tree={tree} flat={flat} selectedId={null} onSelect={onSelect} totalCount={7} />,
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
    // Reveal the empty Drawer (itemCount 0) and delete it via its button.
    const cabinet = screen.getByRole('treeitem', { name: 'Cabinet' });
    cabinet.focus();
    fireEvent.keyDown(cabinet, { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Drawer' }));
    expect(spies.del).toHaveBeenCalledWith('drawer');
    expect(screen.queryByRole('dialog', { name: 'Delete location?' })).toBeNull();
  });

  it('asks for confirmation before deleting a location that still holds items', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Workshop' }));
    // Nothing deleted yet — the confirmation dialog stands in the way.
    expect(spies.del).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Delete location?' });
    expect(dialog.textContent).toContain('5 items');
    fireEvent.click(screen.getByTestId('confirm-delete-location'));
    expect(spies.del).toHaveBeenCalledWith('workshop', expect.anything());
  });

  it('cancelling the confirmation leaves the location untouched', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Workshop' }));
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
});
