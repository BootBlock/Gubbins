/**
 * Optimistic item writes report their rollback (issue #307).
 *
 * The optimistic hooks patch the cache immediately and restore it when the write fails. The
 * restore was previously the *entire* `onError`, so a rejected write looked like a UI glitch —
 * the item vanished and reappeared, the star un-starred itself, the gauge snapped back — and the
 * rational response was to retry a write that was failing for a reason worth showing. These tests
 * pin the report that now rides alongside the rollback, for every hook that patches optimistically.
 *
 * Strategy: drive the real hooks through `renderHook` inside a real `QueryClientProvider` +
 * `ToastProvider`, with only the repository stubbed to reject. That keeps the assertion on the
 * user-visible outcome (a danger toast carrying the reason) rather than on the shape of `onError`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/foundry';
import { DbError } from '@/db/errors';

const repo = {
  update: vi.fn(),
  move: vi.fn(),
  adjustQuantity: vi.fn(),
  adjustGauge: vi.fn(),
  softDelete: vi.fn(),
};

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getItemRepository: () => repo,
}));

import {
  useAdjustGauge,
  useAdjustQuantity,
  useMoveItem,
  useSoftDeleteItem,
  useUpdateItem,
} from './mutations';

function wrapper({ children }: { children: ReactNode }) {
  // Retries off so a rejected write settles once, immediately — the toast is the assertion,
  // not React Query's backoff.
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
  for (const fn of Object.values(repo)) fn.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Each optimistic hook, with the repository method it writes through and the vars it takes. */
const CASES = [
  {
    name: 'useUpdateItem',
    method: 'update' as const,
    hook: useUpdateItem,
    vars: { id: 'item-1', input: { name: 'Renamed' } },
    heading: 'Couldn’t update the item',
  },
  {
    name: 'useMoveItem',
    method: 'move' as const,
    hook: useMoveItem,
    vars: { id: 'item-1', locationId: 'loc-2' },
    heading: 'Couldn’t move the item',
  },
  {
    name: 'useAdjustQuantity',
    method: 'adjustQuantity' as const,
    hook: useAdjustQuantity,
    vars: { id: 'item-1', delta: 1 },
    heading: 'Couldn’t adjust the quantity',
  },
  {
    name: 'useAdjustGauge',
    method: 'adjustGauge' as const,
    hook: useAdjustGauge,
    vars: { id: 'item-1', adjustment: { delta: -5 } },
    heading: 'Couldn’t adjust the gauge',
  },
  {
    name: 'useSoftDeleteItem',
    method: 'softDelete' as const,
    hook: useSoftDeleteItem,
    vars: { id: 'item-1' },
    heading: 'Couldn’t delete the item',
  },
];

describe('optimistic item writes surface their rollback', () => {
  it.each(CASES)('$name shows the failure reason when the write is rejected', async (testCase) => {
    repo[testCase.method].mockRejectedValue(
      new DbError('WRITE_SUSPENDED', 'Not enough space to save this change.'),
    );

    const { result } = renderHook(() => testCase.hook(), { wrapper });
    act(() => (result.current.mutate as any)(testCase.vars));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(testCase.heading);
    // A DbError's message is written for the user — it is the actionable part, so it reaches them.
    expect(toast).toHaveTextContent('Not enough space to save this change.');
  });

  it('degrades to the generic line for an internal error, keeping raw text off screen', async () => {
    repo.update.mockRejectedValue(new Error('UNIQUE constraint failed: items.sku'));

    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    const toast = await screen.findByTestId('toast');
    // The user is still told the change did not stick, but is not shown untranslated SQL.
    expect(toast).toHaveTextContent('Your change has been undone.');
    expect(toast).not.toHaveTextContent('UNIQUE constraint');
  });

  it('coalesces a rapid burst of identical failures into one toast', async () => {
    // Quantity adjusts are explicitly rapid-tap; a persistent failure must not stack a toast
    // (and an assistive-tech announcement) per tap.
    repo.adjustQuantity.mockRejectedValue(
      new DbError('WRITE_SUSPENDED', 'Not enough space to save this change.'),
    );

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper });
    act(() => {
      for (let i = 0; i < 8; i += 1) result.current.mutate({ id: 'item-1', delta: 1 });
    });

    await screen.findByTestId('toast');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
  });

  it('stays silent when the write succeeds', async () => {
    repo.update.mockResolvedValue({ id: 'item-1' });

    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});
