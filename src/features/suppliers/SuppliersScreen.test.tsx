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

let listState: {
  isLoading: boolean;
  isError: boolean;
  data?: { rows: SupplierWithCounts[]; hasMore: boolean };
} = { isLoading: false, isError: false, data: { rows: [], hasMore: false } };
const refetch = vi.fn();

vi.mock('./queries', () => ({
  supplierKeys: { all: ['suppliers'], list: () => ['suppliers', 'list'] },
  useSuppliers: () => ({ ...listState, refetch }),
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

beforeEach(() => {
  refetch.mockClear();
  createMutate.mockClear();
  updateMutate.mockClear();
  mergeMutate.mockClear();
  deleteMutate.mockClear();
  listState = { isLoading: false, isError: false, data: { rows: [], hasMore: false } };
  usePreferencesStore.setState({ paginateLists: false, defaultPageSize: 50 });
});
afterEach(cleanup);

describe('SuppliersScreen (issue #384)', () => {
  it('reports a failed load instead of the empty state', () => {
    // A failed read must never render "No suppliers yet" — that reads like success.
    listState = { isLoading: false, isError: true };
    render(<SuppliersScreen />);

    expect(screen.getByRole('alert').textContent).toContain('couldn’t be loaded');
    expect(screen.queryByText(/No suppliers yet/)).toBeNull();
  });

  it('offers a retry that refetches', () => {
    listState = { isLoading: false, isError: true };
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('lists suppliers with their part and order counts', () => {
    listState = {
      isLoading: false,
      isError: false,
      data: { rows: [supplier('a', 'RS Components', 12, 3), supplier('b', 'Local shop')], hasMore: false },
    };
    render(<SuppliersScreen />);

    const row = screen.getByRole('button', { name: /RS Components/ });
    expect(row.textContent).toContain('12 parts');
    expect(row.textContent).toContain('3 orders');
    // Singular/plural come from the catalog, never a hand-rolled ternary.
    expect(screen.getByRole('button', { name: /Local shop/ }).textContent).toContain('0 parts');
  });

  it('cannot merge with fewer than two suppliers to choose between', () => {
    listState = {
      isLoading: false,
      isError: false,
      data: { rows: [supplier('a', 'RS Components')], hasMore: false },
    };
    render(<SuppliersScreen />);

    expect(screen.getByTestId('suppliers-merge').hasAttribute('disabled')).toBe(true);
  });

  it('warns about both consequences before deleting a supplier that carries orders', () => {
    // Deleting is allowed even with spend history against it: the parts cascade away, but the
    // orders survive unlinked (ON DELETE SET NULL). The confirm has to say both.
    listState = {
      isLoading: false,
      isError: false,
      data: { rows: [supplier('a', 'RS Components', 12, 3)], hasMore: false },
    };
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
    listState = {
      isLoading: false,
      isError: false,
      data: { rows: [supplier('a', 'RS Components', 12, 3)], hasMore: false },
    };
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: /RS Components/ }));
    expect(screen.getByRole('button', { name: 'Delete supplier' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Merge this supplier instead' })).toBeTruthy();
  });

  it('omits the count warnings when nothing hangs off the supplier', () => {
    listState = {
      isLoading: false,
      isError: false,
      data: { rows: [supplier('a', 'Local shop', 0, 0)], hasMore: false },
    };
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
    listState = {
      isLoading: false,
      isError: false,
      data: {
        rows: [supplier('a', 'RS-Components', 1, 0), supplier('b', 'RS Components', 4, 0)],
        hasMore: false,
      },
    };
    render(<SuppliersScreen />);

    fireEvent.click(screen.getByRole('button', { name: /RS-Components/ }));
    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    fireEvent.change(nameInput, { target: { value: 'rs components' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(updateMutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('already named');
    expect(screen.getByRole('button', { name: 'Merge into the existing supplier' })).toBeTruthy();
  });

  it('hides pagination when the preference is off', () => {
    listState = {
      isLoading: false,
      isError: false,
      data: { rows: [supplier('a', 'RS Components')], hasMore: false },
    };
    render(<SuppliersScreen />);
    expect(screen.queryByTestId('suppliers-pagination')).toBeNull();
  });
});
