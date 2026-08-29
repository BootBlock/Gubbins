/**
 * Every purchase-order write refreshes the counts (issue #573).
 *
 * The Dashboard's Purchase-orders tile asks the database how many orders are still **open**, and
 * that key hangs off `purchaseOrderKeys.list()`. An order's effective status is *derived* from its
 * lines' receipt totals rather than stored, so far more writes move it than move the plain total:
 * raising an ordered quantity on a fully-received line makes the order PARTIAL — open again — with
 * no row added or removed. `useUpdatePurchaseOrderLine` swept the detail key and the outstanding
 * quantities but not the list, so the badge kept its pre-edit figure until some unrelated
 * purchase-order write happened to refresh it. The client sets `refetchOnWindowFocus: false`, so
 * nothing else recovered it.
 *
 * Each case below drives the real mutation hook against a client whose `invalidateQueries` is
 * recorded rather than executed, and asserts the list prefix was swept. Delete the sweep from any
 * one hook and its case fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { purchaseOrderKeys } from './queries';

// The write seams reach the database through the repository barrel; each mutation is stubbed to
// resolve so the hook's `onSuccess` — the invalidation being asserted — actually runs.
const repos = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'po-1' })),
  setStatus: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  addLine: vi.fn(async () => ({ id: 'ln-1' })),
  updateLine: vi.fn(async () => ({ id: 'ln-1' })),
  removeLine: vi.fn(async () => undefined),
  receiveLine: vi.fn(async () => ({ id: 'ln-1' })),
  receiveLines: vi.fn(async () => [{ id: 'ln-1' }]),
  returnLine: vi.fn(async () => ({ id: 'ln-1' })),
}));

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPurchaseOrderRepository: () => ({
    create: repos.create,
    setStatus: repos.setStatus,
    delete: repos.remove,
    addLine: repos.addLine,
    updateLine: repos.updateLine,
    removeLine: repos.removeLine,
    receiveLine: repos.receiveLine,
    receiveLines: repos.receiveLines,
    returnLine: repos.returnLine,
  }),
}));

import {
  useAddPurchaseOrderLine,
  useCreatePurchaseOrder,
  useDeletePurchaseOrder,
  useReceivePurchaseOrderDelivery,
  useReceivePurchaseOrderLine,
  useRemovePurchaseOrderLine,
  useReturnPurchaseOrderLine,
  useSetPurchaseOrderStatus,
  useUpdatePurchaseOrderLine,
} from './queries';

/** A real `QueryClient` with `invalidateQueries` recorded rather than executed. */
function trackedClient() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: 0 } } });
  const keys: unknown[][] = [];
  client.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
    keys.push(filters?.queryKey ?? []);
    return Promise.resolve();
  }) as QueryClient['invalidateQueries'];
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { keys, wrapper };
}

/** Did any recorded invalidation cover the list prefix the count keys hang off? */
function sweptList(keys: unknown[][]): boolean {
  const list = purchaseOrderKeys.list();
  return keys.some(
    (key) => Array.isArray(key) && key.length === list.length && list.every((part, i) => key[i] === part),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('purchase-order writes refresh the open count', () => {
  it('sweeps the list prefix when a line is edited', async () => {
    // The one this test exists for: no row is added or removed, but the order's effective status
    // can flip from RECEIVED to PARTIAL — from closed to open.
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useUpdatePurchaseOrderLine(), { wrapper });

    result.current.mutate({ poId: 'po-1', lineId: 'ln-1', input: { orderedQty: 10 } });

    await waitFor(() => expect(repos.updateLine).toHaveBeenCalled());
    await waitFor(() => expect(sweptList(keys)).toBe(true));
  });

  it('sweeps the list prefix when a line is received', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useReceivePurchaseOrderLine(), { wrapper });

    result.current.mutate({ poId: 'po-1', lineId: 'ln-1', locationId: 'loc-1' });

    await waitFor(() => expect(repos.receiveLine).toHaveBeenCalled());
    await waitFor(() => expect(sweptList(keys)).toBe(true));
  });

  it('sweeps the list prefix when a whole delivery is received at once', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useReceivePurchaseOrderDelivery(), { wrapper });

    result.current.mutate({ poId: 'po-1', receipts: [{ lineId: 'ln-1', quantity: 2 }] });

    await waitFor(() => expect(repos.receiveLines).toHaveBeenCalled());
    await waitFor(() => expect(sweptList(keys)).toBe(true));
  });

  it('sweeps the list prefix when received stock is returned to the supplier', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useReturnPurchaseOrderLine(), { wrapper });

    result.current.mutate({ poId: 'po-1', lineId: 'ln-1', locationId: 'loc-1' });

    await waitFor(() => expect(repos.returnLine).toHaveBeenCalled());
    await waitFor(() => expect(sweptList(keys)).toBe(true));
  });

  it('sweeps the list prefix when a line is added', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useAddPurchaseOrderLine(), { wrapper });

    result.current.mutate({ poId: 'po-1', input: { orderedQty: 2 } });

    await waitFor(() => expect(repos.addLine).toHaveBeenCalled());
    await waitFor(() => expect(sweptList(keys)).toBe(true));
  });

  it('sweeps the list prefix when a line is removed', async () => {
    const { keys, wrapper } = trackedClient();
    const { result } = renderHook(() => useRemovePurchaseOrderLine(), { wrapper });

    result.current.mutate({ poId: 'po-1', lineId: 'ln-1' });

    await waitFor(() => expect(repos.removeLine).toHaveBeenCalled());
    await waitFor(() => expect(sweptList(keys)).toBe(true));
  });

  it('sweeps the list prefix on a status change, a create and a delete', async () => {
    const status = trackedClient();
    renderHook(() => useSetPurchaseOrderStatus(), { wrapper: status.wrapper }).result.current.mutate({
      id: 'po-1',
      status: 'ORDERED',
    });
    await waitFor(() => expect(sweptList(status.keys)).toBe(true));

    const created = trackedClient();
    renderHook(() => useCreatePurchaseOrder(), { wrapper: created.wrapper }).result.current.mutate({
      supplier: { supplierName: 'Alpha Supplies' },
    });
    await waitFor(() => expect(sweptList(created.keys)).toBe(true));

    const removed = trackedClient();
    renderHook(() => useDeletePurchaseOrder(), { wrapper: removed.wrapper }).result.current.mutate('po-1');
    await waitFor(() => expect(sweptList(removed.keys)).toBe(true));
  });
});
