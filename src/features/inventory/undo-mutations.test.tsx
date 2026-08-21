import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/foundry';
import type { Item } from '@/db/repositories';

/**
 * The undo round trip for item writes (issue #131): a bulk edit hands back the plan that puts
 * the items it changed back, and replaying that plan drives the same repository methods the
 * forward edit used. `undo.test.ts` covers which fields a plan holds; this covers the two hooks
 * either side of it, against a stubbed repository.
 */

const items = {
  getManyById: vi.fn(),
  update: vi.fn(),
  move: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
};
const tags = { getForItem: vi.fn(), setForItem: vi.fn() };

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getItemRepository: () => items,
  getTagRepository: () => tags,
}));

import { useBulkEditItems, useUndoItemChanges } from './mutations';

const item = (id: string, over: Partial<Item> = {}): Item =>
  ({
    id,
    name: id,
    locationId: 'loc-old',
    categoryId: 'cat-old',
    condition: 'GOOD',
    isActive: true,
    ...over,
  }) as unknown as Item;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  for (const fn of [...Object.values(items), ...Object.values(tags)]) fn.mockReset();
  items.getManyById.mockResolvedValue(
    new Map([
      ['a', item('a')],
      ['b', item('b')],
    ]),
  );
  items.update.mockResolvedValue(undefined);
  items.move.mockResolvedValue(undefined);
  items.softDelete.mockResolvedValue(undefined);
  items.restore.mockResolvedValue(undefined);
  tags.getForItem.mockResolvedValue([]);
  tags.setForItem.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('useBulkEditItems — the undo plan it hands back', () => {
  it('captures each item\u2019s pre-edit values for the fields the spec changed', async () => {
    const { result } = renderHook(() => useBulkEditItems(), { wrapper });

    let outcome!: Awaited<ReturnType<typeof result.current.mutateAsync>>;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        ids: ['a', 'b'],
        spec: { location: { value: 'loc-new' }, category: { value: null } },
      });
    });

    expect(outcome.succeeded).toBe(2);
    expect(outcome.undo.steps).toEqual([
      { id: 'a', categoryId: 'cat-old', locationId: 'loc-old' },
      { id: 'b', categoryId: 'cat-old', locationId: 'loc-old' },
    ]);
  });

  it('leaves an item that failed mid-batch out of the plan, so Undo covers only what landed', async () => {
    items.move.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('nope');
    });
    const { result } = renderHook(() => useBulkEditItems(), { wrapper });

    let outcome!: Awaited<ReturnType<typeof result.current.mutateAsync>>;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        ids: ['a', 'b'],
        spec: { location: { value: 'loc-new' } },
      });
    });

    expect(outcome).toMatchObject({ succeeded: 1, failed: 1 });
    expect(outcome.undo.steps).toEqual([{ id: 'a', locationId: 'loc-old' }]);
  });

  it('reads the tag set only when the edit touches tags', async () => {
    const { result } = renderHook(() => useBulkEditItems(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ ids: ['a'], spec: { condition: { value: 'MINT' } } });
    });
    expect(tags.getForItem).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.mutateAsync({ ids: ['a'], spec: { tags: { mode: 'add', names: ['smd'] } } });
    });
    expect(tags.getForItem).toHaveBeenCalledWith('a');
  });
});

describe('useUndoItemChanges — replaying a plan', () => {
  it('routes each restored field through the repository method that owns it', async () => {
    const { result } = renderHook(() => useUndoItemChanges(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        steps: [
          { id: 'a', categoryId: 'cat-old', condition: 'GOOD', locationId: 'loc-old', isActive: true },
          { id: 'b', isActive: false, tagNames: ['smd'] },
        ],
      });
    });

    expect(items.update).toHaveBeenCalledWith('a', { categoryId: 'cat-old', condition: 'GOOD' });
    expect(items.move).toHaveBeenCalledWith('a', 'loc-old');
    expect(items.restore).toHaveBeenCalledWith('a');
    expect(items.softDelete).toHaveBeenCalledWith('b');
    expect(tags.setForItem).toHaveBeenCalledWith('b', ['smd']);
    // 'b' names no category or condition, so it must not be sent an empty update.
    expect(items.update).toHaveBeenCalledTimes(1);
  });

  it('restores a cleared category, rather than reading null as \u201cleave alone\u201d', async () => {
    const { result } = renderHook(() => useUndoItemChanges(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ steps: [{ id: 'a', categoryId: null }] });
    });
    expect(items.update).toHaveBeenCalledWith('a', { categoryId: null });
  });

  it('counts a per-item failure without abandoning the rest of the reversal', async () => {
    items.move.mockImplementation(async (id: string) => {
      if (id === 'a') throw new Error('nope');
    });
    const { result } = renderHook(() => useUndoItemChanges(), { wrapper });

    let outcome!: Awaited<ReturnType<typeof result.current.mutateAsync>>;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        steps: [
          { id: 'a', locationId: 'loc-old' },
          { id: 'b', locationId: 'loc-old' },
        ],
      });
    });

    expect(outcome).toEqual({ succeeded: 1, failed: 1 });
  });

  it('rejects with the real cause when nothing could be put back', async () => {
    items.move.mockRejectedValue(new Error('database is locked'));
    const { result } = renderHook(() => useUndoItemChanges(), { wrapper });

    await act(async () => {
      result.current.mutate({ steps: [{ id: 'a', locationId: 'loc-old' }] });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe('database is locked');
  });
});
