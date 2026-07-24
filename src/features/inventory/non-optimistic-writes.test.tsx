/**
 * Non-optimistic item writes report their failure (issue #389).
 *
 * The image, custom-field and capability writes are fired fire-and-forget from their editors and
 * patch nothing optimistically, so a rejected write used to do nothing and say nothing — the tile
 * never appeared, the chip stayed put, the button read "Saved" — and the rational response was to
 * retry a write that was failing for a reason worth showing (a constraint, the storage hard stop,
 * `SQLITE_BUSY`). These tests pin the danger toast that now rides on each hook's `onError`, reusing
 * the same `useReportWriteFailure` seam the optimistic hooks use (#307).
 *
 * Strategy mirrors `mutations.test.tsx`: drive the real hooks through `renderHook` inside a real
 * `QueryClientProvider` + `ToastProvider`, with only the repository (and, for the image add, its
 * compression/OPFS pipeline) stubbed to reject. The assertion stays on the user-visible outcome.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, screen, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/foundry';
import { DbError } from '@/db/errors';

const imageRepo = { add: vi.fn(), remove: vi.fn() };
const categoryRepo = { setItemFieldValues: vi.fn() };
const itemRepo = { setCapability: vi.fn(), removeCapability: vi.fn() };

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getImageRepository: () => imageRepo,
  getCategoryRepository: () => categoryRepo,
  getItemRepository: () => itemRepo,
}));

// The image add-hook runs the §4.2.3 pipeline before the DB write; stub it to succeed so the test
// exercises the DB failure, not the compression path.
vi.mock('@/features/images/compression', () => ({
  processImageFile: vi.fn(async () => ({ fullRes: new Blob(), thumbnailBytes: new Uint8Array() })),
}));
vi.mock('@/features/images/full-res-policy', () => ({
  placeFullResImage: vi.fn(async () => ({ fullResOpfsPath: 'items/x.webp', fullResDowngradedAt: null })),
}));
vi.mock('@/features/images/opfs-images', () => ({ deleteImageFile: vi.fn(async () => {}) }));
vi.mock('@/state/stores/useStorageStore', () => ({
  useStorageStore: { getState: () => ({ tier: 'ok' }) },
}));

import { useAddItemImage, useRemoveItemImage } from './media';
import { useSetItemFieldValues } from './categories';
import { useSetCapability, useRemoveCapability } from './capabilities';

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
  for (const fn of [
    imageRepo.add,
    imageRepo.remove,
    categoryRepo.setItemFieldValues,
    itemRepo.setCapability,
    itemRepo.removeCapability,
  ]) {
    fn.mockReset();
  }
});

afterEach(() => vi.restoreAllMocks());

/** Each non-optimistic hook, the repository method it writes through, and the vars it takes. */
const CASES = [
  {
    name: 'useAddItemImage',
    repo: imageRepo,
    method: 'add' as const,
    hook: useAddItemImage,
    mutate: (m: any) => m({ itemId: 'item-1', file: new Blob() }),
    heading: 'Couldn’t add the photo',
  },
  {
    name: 'useRemoveItemImage',
    repo: imageRepo,
    method: 'remove' as const,
    hook: useRemoveItemImage,
    mutate: (m: any) => m({ id: 'img-1', itemId: 'item-1' }),
    heading: 'Couldn’t remove the photo',
  },
  {
    name: 'useSetItemFieldValues',
    repo: categoryRepo,
    method: 'setItemFieldValues' as const,
    hook: () => useSetItemFieldValues('item-1'),
    mutate: (m: any) => m({ 'field-1': 'value' }),
    heading: 'Couldn’t save the custom fields',
  },
  {
    name: 'useSetCapability',
    repo: itemRepo,
    method: 'setCapability' as const,
    hook: () => useSetCapability('item-1'),
    mutate: (m: any) => m({ key: 'voltage', value: '5' }),
    heading: 'Couldn’t save the capability',
  },
  {
    name: 'useRemoveCapability',
    repo: itemRepo,
    method: 'removeCapability' as const,
    hook: () => useRemoveCapability('item-1'),
    mutate: (m: any) => m('voltage'),
    heading: 'Couldn’t remove the capability',
  },
];

describe('non-optimistic item writes surface their failure', () => {
  it.each(CASES)('$name shows the failure reason when the write is rejected', async (testCase) => {
    (testCase.repo as any)[testCase.method].mockRejectedValue(
      // The developer-facing text `base.ts` throws under the storage hard stop.
      new DbError(
        'WRITE_SUSPENDED',
        'Storage is full (Hard Stop): new writes are suspended. Delete items or free space to continue.',
      ),
    );

    const { result } = renderHook(() => testCase.hook(), { wrapper });
    act(() => testCase.mutate(result.current.mutate as any));

    const toast = await screen.findByTestId('toast');
    expect(toast).toHaveTextContent(testCase.heading);
    // The hard stop is humanised from the error `code` (#311) — the raw jargon stays off screen.
    expect(toast).toHaveTextContent('Saving is paused because storage is nearly full.');
    expect(toast).not.toHaveTextContent('Hard Stop');
  });

  it('degrades to the generic non-optimistic line, keeping raw text off screen', async () => {
    // A bare `Error` carrying raw SQLite text: not humanisable to a `code`, and not an authored
    // sentence, so it falls through to the call site's fallback copy (#311).
    itemRepo.setCapability.mockRejectedValue(new Error('UNIQUE constraint failed: item_capabilities.key'));

    const { result } = renderHook(() => useSetCapability('item-1'), { wrapper });
    act(() => result.current.mutate({ key: 'voltage', value: '5' }));

    const toast = await screen.findByTestId('toast');
    // Not the optimistic "…has been undone" copy: nothing was undone, the write just didn't land.
    expect(toast).toHaveTextContent('Your change could not be saved.');
    expect(toast).not.toHaveTextContent('has been undone');
    expect(toast).not.toHaveTextContent('UNIQUE constraint');
  });

  it('stays silent when the write succeeds', async () => {
    itemRepo.removeCapability.mockResolvedValue(undefined);

    const { result } = renderHook(() => useRemoveCapability('item-1'), { wrapper });
    act(() => result.current.mutate('voltage'));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(screen.queryByTestId('toast')).toBeNull();
  });
});
