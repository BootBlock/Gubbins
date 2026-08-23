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
import { emptyAst } from '@/db/search/ast';

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
import { inventoryKeys } from './queries';

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
      // The message `base.ts` actually throws: developer-facing, jargon-laden and untranslated.
      new DbError(
        'WRITE_SUSPENDED',
        'Storage is full (Hard Stop): new writes are suspended. Delete items or free space to continue.',
      ),
    );

    const { result } = renderHook(() => testCase.hook(), { wrapper });
    act(() => (result.current.mutate as any)(testCase.vars));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(testCase.heading);
    // The storage hard stop is highly actionable, so it is humanised from the error's `code`
    // (issue #311) rather than passed through — a `DbError` carries raw, untranslated text.
    expect(toast).toHaveTextContent('Saving is paused because storage is nearly full.');
    expect(toast).not.toHaveTextContent('Hard Stop');
  });

  it('keeps a repository’s own sentence when it wrote one for the user', async () => {
    // Humanising must not clobber better copy: a repository that authors a specific message under
    // a constraint code (the `AttachmentRepository` pattern) still reaches the user verbatim.
    repo.update.mockRejectedValue(new DbError('SQLITE_CONSTRAINT', 'Enter a valid URL (http or https).'));

    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Enter a valid URL (http or https).');
  });

  it('humanises a raw constraint violation into a sentence naming the field', async () => {
    repo.update.mockRejectedValue(new DbError('SQLITE_CONSTRAINT', 'UNIQUE constraint failed: tags.name'));

    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('That tag name is already in use.');
    expect(toast).not.toHaveTextContent('UNIQUE constraint');
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
      // The message `base.ts` actually throws: developer-facing, jargon-laden and untranslated.
      new DbError(
        'WRITE_SUSPENDED',
        'Storage is full (Hard Stop): new writes are suspended. Delete items or free space to continue.',
      ),
    );

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper });
    act(() => {
      for (let i = 0; i < 8; i += 1) result.current.mutate({ id: 'item-1', delta: 1 });
    });

    await screen.findByTestId('toast');
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(screen.getAllByTestId('toast')).toHaveLength(1);
  });

  it('says the outcome is unknown, not that the write failed, when the database times out', async () => {
    // A `WORKER_TIMEOUT` is the one error that establishes nothing: the worker never answered, and
    // nothing cancels the request, so it may still commit. Every heading here names a verb that
    // didn't happen, and the humanised body used to end "Try again" — the instruction that turns
    // an append-only write into two of the same event (issue #554).
    repo.update.mockRejectedValue(
      new DbError('WORKER_TIMEOUT', 'The database did not answer a "execute" request within 30000ms.'),
    );

    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent('Not sure whether that saved');
    expect(toast).toHaveTextContent('Check before making the change again');
    expect(toast).not.toHaveTextContent('Couldn’t update the item');
    expect(toast).not.toHaveTextContent('Try again');
  });

  it('stays silent when the write succeeds', async () => {
    repo.update.mockResolvedValue({ id: 'item-1' });

    const { result } = renderHook(() => useUpdateItem(), { wrapper });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});

/**
 * The optimistic patch writes the item's **detail** slice as well as the lists, so the snapshot
 * that guards it has to cover the detail slice too (issue #295). Without that, an in-flight
 * `useItem(id)` refetch resolves over the optimistic value — the card snaps back the moment the
 * user taps ± — and a failed write leaves the detail cache holding a number that never happened
 * for as long as the burst lasts, because the rapid-tap adjusts skip their compensating
 * invalidation until the last write settles.
 */
describe('optimistic item writes guard the detail cache', () => {
  const DETAIL_KEY = inventoryKeys.item('item-1');
  const CACHED = { id: 'item-1', name: 'Widget', quantity: 10 };

  /** A wrapper whose client the test can inspect, seeded with a cached detail slice. */
  function withClient() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(DETAIL_KEY, CACHED);
    return {
      client,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    };
  }

  it('rolls the detail slice back when the write fails', async () => {
    // Rejected on demand rather than immediately, so the optimistic value is observable in
    // between — otherwise the final assertion could pass without any patch ever landing.
    let failWrite = () => {};
    repo.adjustQuantity.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failWrite = () => reject(new DbError('SQLITE_BUSY', 'database is locked'));
        }),
    );
    const { client, wrapper: local } = withClient();

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', delta: 5 }));
    await waitFor(() => expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 15 }));

    act(() => failWrite());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(DETAIL_KEY)).toEqual(CACHED);
  });

  it('a failed tap mid-burst keeps the other taps’ optimistic patches (issue #300)', async () => {
    // Three +1 taps queue optimistically (10 → 13). The middle one fails. The rollback must
    // invert only that tap (13 → 12), not restore a snapshot taken when the tap started — which
    // was captured *after* an earlier tap patched and so would drop a later tap's still-valid +1,
    // showing a quantity that reflects neither the database nor the user's input.
    const gates: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
    repo.adjustQuantity.mockImplementation(
      () => new Promise<void>((resolve, reject) => gates.push({ resolve: () => resolve(), reject })),
    );
    const { client, wrapper: local } = withClient();

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => {
      result.current.mutate({ id: 'item-1', delta: 1 });
      result.current.mutate({ id: 'item-1', delta: 1 });
      result.current.mutate({ id: 'item-1', delta: 1 });
    });
    await waitFor(() => expect(gates).toHaveLength(3));
    await waitFor(() => expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 13 }));

    // The middle tap is rejected; the first and last land in the database.
    act(() => gates[1].reject(new DbError('SQLITE_BUSY', 'database is locked')));
    act(() => {
      gates[0].resolve();
      gates[2].resolve();
    });

    // Only the failed tap's +1 is undone. The old snapshot-restore reverted to 11 (dropping the
    // last tap) — the two surviving taps must remain, so the cache reads 12, not 11 or 10.
    await waitFor(() => expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 12 }));
  });

  it('keeps the optimistic patch when the database times out (issue #554)', async () => {
    // The worker processes one request at a time and nothing cancels a timed-out one, so a
    // `WORKER_TIMEOUT` may well be a write that lands moments later. Reverting would show the
    // user the pre-write value and call it settled, only for the next read to contradict it —
    // so the patch stays put, and `onSettled`'s invalidation is what reconciles.
    let failWrite = () => {};
    repo.adjustQuantity.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failWrite = () =>
            reject(
              new DbError(
                'WORKER_TIMEOUT',
                'The database did not answer a "execute" request within 30000ms.',
              ),
            );
        }),
    );
    const { client, wrapper: local } = withClient();

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', delta: 5 }));
    await waitFor(() => expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 15 }));

    act(() => failWrite());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 15 });
  });

  it('cancels an in-flight detail fetch so it cannot clobber the optimistic value', async () => {
    repo.adjustQuantity.mockResolvedValue(undefined);
    const { client, wrapper: local } = withClient();

    // A background refetch already outstanding when the user taps, resolving to the pre-tap
    // quantity — exactly the response that used to land on top of the optimistic patch.
    let settleRefetch = () => {};
    const refetch = client.fetchQuery({
      queryKey: DETAIL_KEY,
      queryFn: () => new Promise((resolve) => (settleRefetch = () => resolve(CACHED))),
    });

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', delta: 5 }));
    await waitFor(() => expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 15 }));

    act(() => settleRefetch());
    await refetch.catch(() => {});
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Still the optimistic value: the stale fetch was cancelled, not merely raced.
    expect(client.getQueryData(DETAIL_KEY)).toMatchObject({ quantity: 15 });
  });
});

/**
 * While the Visual Builder drives the Inventory list, the rows on screen come from the AST
 * search's cache, not the plain item list's (issue #622). The optimistic patch used to match the
 * list keys alone, so in that one mode a ± tap wrote the new quantity to the database and left
 * the number on the card exactly where it was — which reads as a broken control rather than a
 * stale cache, and invites the user to tap again, each tap a real write.
 */
describe('optimistic item writes reach the Visual-Builder result pages (#622)', () => {
  const AST = emptyAst();
  const RESULTS_KEY = inventoryKeys.astSearch(AST, null, null);
  const COUNT_KEY = inventoryKeys.astCount(AST, null);

  /** One resident page of AST results holding the item the test taps ± on. */
  function seededPage() {
    return {
      pages: [
        {
          rows: [
            { id: 'item-0', name: 'Other', quantity: 3 },
            { id: 'item-1', name: 'Widget', quantity: 10 },
          ],
          total: 2,
          offset: 0,
          limit: 50,
          hasMore: false,
        },
      ],
      pageParams: [0],
    };
  }

  function withAstClient() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(RESULTS_KEY, seededPage());
    // The count caches a bare number, not `InfiniteData`. It must stay outside the patch — the
    // updater would crash on it — which is why it carries its own key segment.
    client.setQueryData(COUNT_KEY, 2);
    return {
      client,
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      ),
    };
  }

  /** Read the tapped row back out of the cached result pages. */
  function tappedRow(client: QueryClient) {
    const data = client.getQueryData<{ pages: Array<{ rows: Array<{ id: string; quantity: number }> }> }>(
      RESULTS_KEY,
    );
    return data?.pages[0].rows.find((row) => row.id === 'item-1');
  }

  it('moves the tapped card’s quantity, leaving the other rows and the count alone', async () => {
    repo.adjustQuantity.mockResolvedValue(undefined);
    const { client, wrapper: local } = withAstClient();

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', delta: 5 }));

    await waitFor(() => expect(tappedRow(client)).toMatchObject({ quantity: 15 }));
    const data = client.getQueryData<{ pages: Array<{ rows: Array<{ id: string; quantity: number }> }> }>(
      RESULTS_KEY,
    );
    expect(data?.pages[0].rows[0]).toMatchObject({ id: 'item-0', quantity: 3 });
    expect(client.getQueryData(COUNT_KEY)).toBe(2);
  });

  it('reaches a location-scoped search’s pages too, and still leaves its count alone (#626)', async () => {
    // The sidebar's selected location is a key segment of its own, so a scoped search caches
    // under a different key than the inventory-wide one. The optimistic patch matches result
    // pages by prefix *and length*, so a segment added there has to be counted — miss it and the
    // ± tap silently stops moving the card again, exactly as in #622.
    const scopedResults = inventoryKeys.astSearch(AST, null, 'loc-garage');
    const scopedCount = inventoryKeys.astCount(AST, 'loc-garage');
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(scopedResults, seededPage());
    client.setQueryData(scopedCount, 2);
    const local = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    );

    repo.adjustQuantity.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', delta: 5 }));

    await waitFor(() => {
      const data = client.getQueryData<{
        pages: Array<{ rows: Array<{ id: string; quantity: number }> }>;
      }>(scopedResults);
      expect(data?.pages[0].rows.find((row) => row.id === 'item-1')).toMatchObject({ quantity: 15 });
    });
    expect(client.getQueryData(scopedCount)).toBe(2);
  });

  it('rolls the result page back when the write fails', async () => {
    let failWrite = () => {};
    repo.adjustQuantity.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failWrite = () => reject(new DbError('SQLITE_BUSY', 'database is locked'));
        }),
    );
    const { client, wrapper: local } = withAstClient();

    const { result } = renderHook(() => useAdjustQuantity(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', delta: 5 }));
    await waitFor(() => expect(tappedRow(client)).toMatchObject({ quantity: 15 }));

    act(() => failWrite());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(tappedRow(client)).toMatchObject({ quantity: 10 });
  });

  it('patches an edited item’s fields on the card behind the detail dialog', async () => {
    // The detail dialog's own slice always refreshed; the card underneath it kept the pre-edit
    // name, because it was rendered from these pages.
    repo.update.mockResolvedValue({ id: 'item-1' });
    const { client, wrapper: local } = withAstClient();

    const { result } = renderHook(() => useUpdateItem(), { wrapper: local });
    act(() => result.current.mutate({ id: 'item-1', input: { name: 'Renamed' } }));

    await waitFor(() => expect(tappedRow(client)).toMatchObject({ name: 'Renamed' }));
  });
});
