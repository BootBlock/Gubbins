import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { SupplierWithCounts } from '@/db/repositories';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock('@/components/BrandMark', () => ({ BrandMark: () => <span data-testid="brand-mark" /> }));

// The global nav has its own suite; stub it so this screen needs no router/alerts context.
vi.mock('@/components/nav/AppNav', () => ({
  AppNav: () => <button type="button" data-testid="app-nav" aria-label="Navigation menu" />,
}));

vi.mock('@/components/icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/icons')>();
  return Object.fromEntries(Object.keys(actual).map((k) => [k, () => <span data-testid={`icon-${k}`} />]));
});

// ─── controlled query / mutation stubs ────────────────────────────────────────

/**
 * The whole dictionary the stubbed repository holds. The read hooks below page and filter it
 * exactly as the database does, so a test can put a supplier past the first page and assert it
 * is still reachable — the substance of issue #386, which client-side slicing of one bounded
 * page could not deliver.
 */
let allSuppliers: SupplierWithCounts[] = [];
let loadState: { isLoading: boolean; isError: boolean } = { isLoading: false, isError: false };
const refetch = vi.fn();

/** Stand-in for the repository's folded identity key (see `supplierNameKey`). */
function fold(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The suppliers a name filter matches, in the name order the repository returns them in —
 * on the display name or on the folded key, exactly as the SQL does.
 */
function matching(search: string): SupplierWithCounts[] {
  const term = search.trim().toLowerCase();
  const key = fold(search);
  const rows =
    term.length === 0
      ? allSuppliers
      : allSuppliers.filter(
          (s) => s.name.toLowerCase().includes(term) || (key.length > 0 && fold(s.name).includes(key)),
        );
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

vi.mock('./queries', () => ({
  SUPPLIER_SEARCH_LIMIT: 50,
  supplierKeys: { all: ['suppliers'], list: () => ['suppliers', 'list'] },
  useSupplierPage: (search: string, page: number, pageSize: number) => {
    const rows = matching(search).slice((page - 1) * pageSize, page * pageSize);
    return {
      ...loadState,
      data:
        loadState.isLoading || loadState.isError
          ? undefined
          : { rows, limit: pageSize, offset: (page - 1) * pageSize, hasMore: rows.length === pageSize },
      refetch,
    };
  },
  useSupplierCount: (search: string) => ({ data: matching(search).length }),
  useSupplierSearch: (term: string) => ({ data: { rows: matching(term).slice(0, 50) } }),
  useSupplierByName: (name: string) => ({
    data: allSuppliers.find((s) => fold(s.name) === fold(name)),
  }),
}));

const createMutate = vi.fn();
const updateMutate = vi.fn();
const mergeMutate = vi.fn();
const deleteMutate = vi.fn();

vi.mock('./mutations', () => ({
  useCreateSupplier: () => ({ mutate: createMutate, isPending: false }),
  useUpdateSupplier: () => ({ mutate: updateMutate, isPending: false }),
  useMergeSuppliers: () => ({ mutate: mergeMutate, isPending: false }),
  useDeleteSupplier: () => ({ mutate: deleteMutate, isPending: false }),
}));

import { usePreferencesStore } from '@/state/stores/usePreferencesStore';
import { SuppliersScreen } from './SuppliersScreen';

function supplier(id: string, name: string, partCount = 0, orderCount = 0): SupplierWithCounts {
  return {
    id,
    name,
    url: null,
    currency: null,
    note: null,
    createdAt: 0,
    updatedAt: 0,
    partCount,
    orderCount,
  };
}

/** `count` suppliers named `Supplier 001`… — enough to run past a bounded page. */
function manySuppliers(count: number): SupplierWithCounts[] {
  return Array.from({ length: count }, (_, i) =>
    supplier(`s${i}`, `Supplier ${String(i + 1).padStart(3, '0')}`),
  );
}

beforeEach(() => {
  refetch.mockClear();
  createMutate.mockClear();
  updateMutate.mockClear();
  mergeMutate.mockClear();
  deleteMutate.mockClear();
  allSuppliers = [];
  loadState = { isLoading: false, isError: false };
  usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
});
afterEach(cleanup);

describe('SuppliersScreen (issue #384)', () => {
  it('reports a failed load instead of the empty state', () => {
    // A failed read must never render "No suppliers yet" — that reads like success.
    loadState = { isLoading: false, isError: true };
    render(<SuppliersScreen />);

    expect(screen.getByRole('alert').textContent).toContain('couldn’t be loaded');
    expect(screen.queryByText(/No suppliers yet/)).toBeNull();
  });

  it('offers a retry that refetches', () => {
    loadState = { isLoading: false, isError: true };
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('lists suppliers with their part and order counts', () => {
    allSuppliers = [supplier('a', 'RS Components', 12, 3), supplier('b', 'Local shop')];
    render(<SuppliersScreen />);

    const row = screen.getByRole('button', { name: /RS Components/ });
    expect(row.textContent).toContain('12 parts');
    expect(row.textContent).toContain('3 orders');
    // Singular/plural come from the catalog, never a hand-rolled ternary.
    expect(screen.getByRole('button', { name: /Local shop/ }).textContent).toContain('0 parts');
  });

  it('cannot merge with fewer than two suppliers to choose between', () => {
    allSuppliers = [supplier('a', 'RS Components')];
    render(<SuppliersScreen />);

    expect(screen.getByTestId('suppliers-merge').hasAttribute('disabled')).toBe(true);
  });

  it('warns about both consequences before deleting a supplier that carries orders', () => {
    // Deleting is allowed even with spend history against it: the parts cascade away, but the
    // orders survive unlinked (ON DELETE SET NULL). The confirm has to say both.
    allSuppliers = [supplier('a', 'RS Components', 12, 3)];
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: /RS Components/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete supplier' }));

    const confirm = screen.getByTestId('supplier-delete-confirm');
    expect(confirm.textContent).toContain('The 12 supplier parts filed under it will be deleted.');
    expect(confirm.textContent).toContain(
      '3 purchase orders will be kept, but will no longer name a supplier.',
    );
    expect(deleteMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMutate).toHaveBeenCalledWith('a', expect.anything());
  });

  it('still offers the merge as an alternative to deleting', () => {
    // Merging is the right move for a duplicate — the orders keep naming a supplier — so it
    // stays on offer rather than being forced.
    allSuppliers = [supplier('a', 'RS Components', 12, 3)];
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: /RS Components/ }));
    expect(screen.getByRole('button', { name: 'Delete supplier' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge this supplier instead' })).toBeTruthy();
  });

  it('omits the count warnings when nothing hangs off the supplier', () => {
    allSuppliers = [supplier('a', 'Local shop', 0, 0)];
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: /Local shop/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete supplier' }));

    const confirm = screen.getByTestId('supplier-delete-confirm');
    expect(confirm.textContent).toContain('Delete this supplier?');
    expect(confirm.textContent).not.toContain('supplier part');
    expect(confirm.textContent).not.toContain('purchase order');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleteMutate).toHaveBeenCalledWith('a', expect.anything());
  });

  it('blocks a rename onto another supplier and points at the merge instead', () => {
    // Names fold case, spacing and punctuation, so this rename would claim an identity that
    // already exists — the dictionary refuses it and the merge is what was actually meant.
    allSuppliers = [supplier('a', 'Farnell', 1, 0), supplier('b', 'RS Components', 4, 0)];
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: /Farnell/ }));
    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(nameInput, { target: { value: 'rs-components' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already named');
    expect(screen.getByRole('button', { name: 'Merge into the existing supplier' })).toBeTruthy();
  });

  it('hides pagination when the preference is off', () => {
    allSuppliers = [supplier('a', 'RS Components')];
    render(<SuppliersScreen />);
    expect(screen.queryByTestId('suppliers-pagination')).toBeNull();
  });
});

describe('SuppliersScreen reach (issue #386)', () => {
  it('pages through the whole dictionary rather than one bounded read', () => {
    // The 120th supplier sorts past every bounded page; paging must still get there, since
    // editing, merging and deleting it are only possible from its row.
    allSuppliers = manySuppliers(120);
    usePreferencesStore.setState({ paginateLists: true, defaultPageSize: 50 });
    render(<SuppliersScreen />);

    expect(screen.queryByRole('button', { name: /Supplier 120/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));

    expect(screen.getByRole('button', { name: /Supplier 120/ })).toBeTruthy();
  });

  it('reaches a supplier past the first page by name, unpaginated', () => {
    // Without the page control, the filter is the way through — and it is resolved by the
    // repository, so it is not limited to the rows already on screen.
    allSuppliers = [...manySuppliers(120), supplier('late', 'Zeta Supplies', 2, 1)];
    render(<SuppliersScreen />);

    expect(screen.queryByRole('button', { name: /Zeta Supplies/ })).toBeNull();
    fireEvent.change(screen.getByTestId('suppliers-search'), { target: { value: 'Zeta' } });

    expect(screen.getByRole('button', { name: /Zeta Supplies/ })).toBeTruthy();
  });

  it('says how much of the dictionary a bounded read is showing', () => {
    allSuppliers = manySuppliers(120);
    render(<SuppliersScreen />);

    expect(screen.getByTestId('suppliers-truncated').textContent).toContain(
      'Showing the first 100 of 120 suppliers',
    );
  });

  it('reports a filtered-to-nothing list as no match, not an empty dictionary', () => {
    // "No suppliers yet" would be false, and would send the user to add one they already have.
    allSuppliers = [supplier('a', 'RS Components')];
    render(<SuppliersScreen />);

    fireEvent.change(screen.getByTestId('suppliers-search'), { target: { value: 'nope' } });

    expect(screen.getByText('No supplier matches “nope”.')).toBeTruthy();
    expect(screen.queryByText(/No suppliers yet/)).toBeNull();
  });

  it('catches a rename onto a supplier the screen has never shown', () => {
    // Checking the loaded page alone would have let this through to a bare constraint error,
    // with no offer of the merge that was actually meant.
    allSuppliers = [...manySuppliers(120), supplier('late', 'Zeta Supplies', 4, 0)];
    render(<SuppliersScreen />);

    expect(screen.queryByRole('button', { name: /Zeta Supplies/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Supplier 001/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'zeta supplies' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already named');
  });

  it('keeps merge available when a filter leaves one supplier on screen', () => {
    // The button asks "are there two suppliers to merge", not "are two of them visible".
    allSuppliers = [supplier('a', 'RS Components'), supplier('b', 'Farnell')];
    render(<SuppliersScreen />);

    fireEvent.change(screen.getByTestId('suppliers-search'), { target: { value: 'Farnell' } });

    expect(screen.getByTestId('suppliers-merge').hasAttribute('disabled')).toBe(false);
  });

  it('merges a pair that both sort past the loaded page', () => {
    // The case merge exists for: two spellings of one company, both late in the dictionary and
    // so unselectable from a dropdown built out of the first page.
    allSuppliers = [
      ...manySuppliers(120),
      supplier('z1', 'Zeta Supplies', 4, 2),
      supplier('z2', 'Zeta-Supplies Ltd', 1, 0),
    ];
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByTestId('suppliers-merge'));
    fireEvent.change(screen.getByTestId('merge-source'), { target: { value: 'Zeta-Supplies Ltd' } });
    fireEvent.change(screen.getByTestId('merge-target'), { target: { value: 'Zeta Supplies' } });

    expect(screen.getByTestId('merge-preview').textContent).toContain(
      '1 supplier part and 0 purchase orders will move to Zeta Supplies; Zeta-Supplies Ltd will be deleted.',
    );

    fireEvent.click(screen.getByTestId('merge-start'));
    fireEvent.click(screen.getByTestId('merge-confirm'));
    expect(mergeMutate).toHaveBeenCalledWith({ sourceId: 'z2', targetId: 'z1' }, expect.anything());
  });

  it('will not act on a name that matches no supplier', () => {
    // Merging is destructive, so text that names nothing selects nothing — there is no
    // "close enough" reading that could fold the wrong company into another.
    allSuppliers = [supplier('a', 'RS Components', 1, 0), supplier('b', 'Farnell')];
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByTestId('suppliers-merge'));
    fireEvent.change(screen.getByTestId('merge-source'), { target: { value: 'RS Comp' } });

    expect(screen.getByTestId('merge-source-unmatched').textContent).toContain('No supplier is named');
    expect(screen.queryByTestId('merge-preview')).toBeNull();
  });
});
