/**
 * Setting an item's tags refreshes the on-card Tags field (issue #624).
 *
 * The detail dialog's tag editor reads `itemTags(itemId)`, while an item card reads the
 * batched `itemsTags(ids)` for its resident window. Those keys share no prefix, so the write
 * used to refresh the editor and leave the card showing the pre-edit chips — unlike the
 * custom-field sibling beside it, which sweeps `itemFieldValuesAll()`.
 *
 * Strategy: drive the real `useItemsTags` and `useSetItemTags` against a fake repository, and
 * assert the batched read is re-fetched with the new set after the write settles. Point
 * `useSetItemTags`'s sweep back at `itemTags` and this goes red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const ITEM_ID = 'item-1';

/** itemId → the tag names stored against it. */
let stored: string[] = [];

const repo = {
  setForItem: vi.fn(async (_itemId: string, names: readonly string[]) => {
    stored = [...names];
  }),
  getForItem: vi.fn(async () => stored.map((name) => ({ id: `t-${name}`, name, updatedAt: 0 }))),
  listForItems: vi.fn(async (itemIds: readonly string[]) =>
    itemIds.flatMap((itemId) => (itemId === ITEM_ID ? stored.map((name) => ({ itemId, name })) : [])),
  ),
};

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getTagRepository: () => repo,
}));

const { useItemsTags, useSetItemTags } = await import('./tags');

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The card's chips for the item under test, as the batched read currently reports them. */
function useCardAndEditor() {
  return { card: useItemsTags([ITEM_ID]), set: useSetItemTags(ITEM_ID) };
}

beforeEach(() => {
  stored = ['fragile'];
  vi.clearAllMocks();
});

describe('on-card Tags field after a tag write', () => {
  it('shows the new set once the write settles', async () => {
    const { result } = renderHook(useCardAndEditor, { wrapper });

    await waitFor(() => expect(result.current.card.data.get(ITEM_ID)).toEqual(['fragile']));

    await act(async () => {
      result.current.set.mutate(['fragile', 'heavy']);
    });

    await waitFor(() => expect(result.current.card.data.get(ITEM_ID)).toEqual(['fragile', 'heavy']));
  });
});
