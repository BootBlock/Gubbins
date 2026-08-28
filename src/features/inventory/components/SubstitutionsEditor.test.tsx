import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Item, ItemRelationView } from '@/db/repositories';

/**
 * Behaviour tests for the {@link SubstitutionsEditor} item-detail facet (issue #36 — mark items
 * interchangeable so they can be freely substituted in a project or list). Substitutions are stored
 * as ordinary symmetric `INTERCHANGEABLE_WITH` `item_relations`; the pure vocabulary + partition seam
 * (`item-relations.ts`) runs here for real, so these pin the *editor's* glue: it lists only the
 * substitution links (never the general "Related" cross-links that share the same store), assembles
 * the exact add payload from the item picker, surfaces an add failure, and removes a substitute. Per
 * the component-test conventions every hook the component calls is mocked (`../queries`, `../mutations`).
 */
const h = vi.hoisted(() => ({
  relations: [] as ItemRelationView[],
  candidates: [] as Item[],
  add: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../queries', () => ({
  useItemRelations: () => ({ data: h.relations }),
  useInventoryItems: () => ({ data: { pages: [{ rows: h.candidates }] } }),
  // The picker searches the catalogue rather than reading a fixed page of it (issue #484). Nothing
  // is typed into it here, so only its browse read answers; the by-id read is what refills the box
  // when a value is set from outside, which these tests never do.
  useItemRelevanceSearch: () => ({ data: undefined }),
  useItem: () => ({ data: undefined }),
}));

vi.mock('../mutations', () => ({
  useAddRelation: () => ({ mutate: h.add, isPending: false }),
  useRemoveRelation: () => ({ mutate: h.remove, isPending: false }),
}));

import { SubstitutionsEditor } from './SubstitutionsEditor';

const item = (o: Partial<Item> = {}): Item =>
  ({ id: 'item-1', name: 'M3×10 screw', serialNo: null, ...o }) as Item;

/** A stored relation joined for display, from `item-1`'s perspective. */
const view = (o: Partial<ItemRelationView> = {}): ItemRelationView => ({
  id: 'r1',
  fromItemId: 'item-1',
  toItemId: 'other-1',
  kind: 'INTERCHANGEABLE_WITH',
  note: null,
  createdAt: 0,
  updatedAt: 0,
  otherItemId: 'other-1',
  otherItemName: 'M3×10 bolt',
  otherItemSerialNo: null,
  ...o,
});

function renderEditor(it: Item = item()) {
  return render(<SubstitutionsEditor item={it} />);
}

beforeEach(() => {
  h.relations = [];
  h.candidates = [item({ id: 'other-1', name: 'M3×10 bolt' }), item({ id: 'other-2', name: 'M3×12 screw' })];
  h.add.mockReset().mockImplementation((_input, opts) => opts?.onSuccess?.());
  h.remove.mockReset();
});
afterEach(cleanup);

describe('SubstitutionsEditor — listing', () => {
  it('prompts to add substitutes when there are none', () => {
    renderEditor();
    expect(screen.getByTestId('substitutions-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('substitutions-list')).toBeNull();
  });

  it('lists interchangeable items under a single "Interchangeable with" heading', () => {
    h.relations = [view({ id: 'r1', otherItemId: 'other-1', otherItemName: 'M3×10 bolt' })];
    renderEditor();
    const list = screen.getByTestId('substitutions-list');
    expect(list).toHaveTextContent('Interchangeable with');
    expect(list.querySelectorAll('[data-testid="substitution-row"]')).toHaveLength(1);
    expect(screen.getByTestId('substitution-row')).toHaveTextContent('M3×10 bolt');
  });

  it('excludes general "Related" cross-links — only substitutions appear here', () => {
    h.relations = [
      view({ id: 'r-sub', otherItemName: 'M3×10 bolt', kind: 'INTERCHANGEABLE_WITH' }),
      view({ id: 'r-works', otherItemId: 'other-2', otherItemName: 'Screwdriver', kind: 'WORKS_WITH' }),
    ];
    renderEditor();
    expect(screen.getByTestId('substitutions-list')).toHaveTextContent('M3×10 bolt');
    expect(screen.queryByText('Screwdriver')).toBeNull();
    expect(screen.getAllByTestId('substitution-row')).toHaveLength(1);
  });
});

describe('SubstitutionsEditor — add a substitute', () => {
  it('assembles the exact add payload (always INTERCHANGEABLE_WITH) and resets on success', async () => {
    renderEditor();
    // Disabled until an item is chosen.
    expect(screen.getByTestId('add-substitution')).toBeDisabled();

    fireEvent.click(screen.getByRole('combobox', { name: 'Item' }));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'M3×12 screw' }));
    fireEvent.change(screen.getByTestId('substitution-note'), { target: { value: 'same pitch' } });
    fireEvent.click(screen.getByTestId('add-substitution'));

    await waitFor(() =>
      expect(h.add).toHaveBeenCalledWith(
        { fromItemId: 'item-1', toItemId: 'other-2', kind: 'INTERCHANGEABLE_WITH', note: 'same pitch' },
        expect.anything(),
      ),
    );
    // onSuccess clears the note for the next entry.
    expect(screen.getByTestId('substitution-note')).toHaveValue('');
  });

  it('surfaces an add failure in an alert', async () => {
    h.add.mockImplementation((_input, opts) =>
      opts?.onError?.(new Error('An item cannot be related to itself.')),
    );
    renderEditor();
    fireEvent.click(screen.getByRole('combobox', { name: 'Item' }));
    fireEvent.mouseDown(screen.getByRole('option', { name: 'M3×10 bolt' }));
    fireEvent.click(screen.getByTestId('add-substitution'));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('An item cannot be related to itself.'),
    );
  });

  it('excludes the item itself from the picker', () => {
    h.candidates = [item({ id: 'item-1', name: 'M3×10 screw' }), item({ id: 'other-1', name: 'M3×10 bolt' })];
    renderEditor();
    fireEvent.click(screen.getByRole('combobox', { name: 'Item' }));
    expect(screen.queryByRole('option', { name: 'M3×10 screw' })).toBeNull();
    expect(screen.getByRole('option', { name: 'M3×10 bolt' })).toBeInTheDocument();
  });
});

describe('SubstitutionsEditor — remove', () => {
  it('removes a substitute with its endpoints so both items refresh', () => {
    h.relations = [
      view({ id: 'r1', fromItemId: 'item-1', toItemId: 'other-1', otherItemName: 'M3×10 bolt' }),
    ];
    renderEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Remove substitute — M3×10 bolt' }));
    expect(h.remove).toHaveBeenCalledWith({ relationId: 'r1', fromItemId: 'item-1', toItemId: 'other-1' });
  });
});
