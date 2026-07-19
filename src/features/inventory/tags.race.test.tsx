/**
 * Rapid tag entry neither drops nor resurrects a tag (issue #293).
 *
 * `setForItem` / `setForLocation` replace the owner's *whole* tag set, and the editor builds
 * that set from the query's data. Before the optimistic patch + serialised writes, a second
 * edit made inside the first write's refetch window rebuilt from the pre-edit snapshot: two
 * quick additions dropped the first, two quick removals brought the first one back.
 *
 * Strategy: drive the real bound wrappers with a fake repository whose writes only complete
 * when the test releases them — that is the race, held open deliberately. The assertion is on
 * what the repository was finally asked to store, i.e. what the user would find on reload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** The owner's stored tag set, and the gates holding each in-flight write open. */
let stored: string[] = [];
let pending: (() => void)[] = [];

const write = async (_ownerId: string, names: readonly string[]) => {
  await new Promise<void>((resolve) => pending.push(resolve));
  stored = [...names];
};
const read = async () => stored.map((name) => ({ id: `t-${name}`, name, updatedAt: 0 }));

const repo = {
  setForItem: vi.fn(write),
  setForLocation: vi.fn(write),
  getForItem: vi.fn(read),
  getForLocation: vi.fn(read),
  listNames: vi.fn(async () => ({ rows: [], total: 0, limit: 100, offset: 0 })),
  suggest: vi.fn(async () => []),
};

vi.mock('@/db/repositories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/db/repositories')>()),
  getTagRepository: () => repo,
}));

import { TagEditor, LocationTagEditor } from './components/TagEditor';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Let every write that is currently in flight complete, then let the queue drain. */
async function releaseWrites() {
  const gates = pending;
  pending = [];
  for (const open of gates) open();
  await flush();
}

/** Drain repeatedly, since serialised writes only start once the one before them finishes. */
async function settle() {
  for (let i = 0; i < 5; i++) await releaseWrites();
}

/**
 * Commit one tag, then let React flush — two keystrokes are always separate event-loop turns,
 * so this is what "typed quickly" actually looks like. The write itself stays held open, which
 * is the window the bug lived in.
 */
async function commit(value: string) {
  const input = screen.getByRole('combobox', { name: 'Add a tag' });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await flush();
}

/**
 * One event-loop turn, as sits between any two real interactions. A full turn rather than a
 * microtask because React Query batches its observer notifications onto one — the cache patch
 * reaches the editor on the next turn, which is still long before the next keystroke.
 */
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Remove one chip, then let React flush — the counterpart of {@link commit}. */
async function removeChip(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `Remove tag ${name}` }));
  await flush();
}

beforeEach(() => {
  stored = [];
  pending = [];
  for (const fn of Object.values(repo)) fn.mockClear();
});

afterEach(cleanup);

describe('bound tag editors under rapid entry (issue #293)', () => {
  it('keeps both tags when a second is added before the first write settles', async () => {
    stored = ['alpha'];
    render(<TagEditor itemId="item-1" />, { wrapper });
    await screen.findByRole('button', { name: 'Remove tag alpha' });

    // The second commit happens while the first write is still in flight.
    await commit('fragile');
    await commit('heavy');
    await settle();

    await waitFor(() => expect([...stored].sort()).toEqual(['alpha', 'fragile', 'heavy']));
    expect(screen.getByRole('button', { name: 'Remove tag fragile' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove tag heavy' })).toBeTruthy();
  });

  it('does not resurrect the first tag when two are removed in quick succession', async () => {
    stored = ['alpha', 'beta', 'gamma'];
    render(<TagEditor itemId="item-1" />, { wrapper });
    await screen.findByRole('button', { name: 'Remove tag alpha' });

    await removeChip('alpha');
    await removeChip('beta');
    await settle();

    await waitFor(() => expect(stored).toEqual(['gamma']));
    expect(screen.queryByRole('button', { name: 'Remove tag alpha' })).toBeNull();
  });

  it('serialises the writes, so the older set can never land last', async () => {
    stored = [];
    render(<TagEditor itemId="item-1" />, { wrapper });
    await waitFor(() => expect(repo.getForItem).toHaveBeenCalled());

    await commit('one');
    await commit('two');
    // Only the first write is in flight; the second waits for it rather than racing it.
    await waitFor(() => expect(repo.setForItem).toHaveBeenCalledTimes(1));
    await settle();

    expect(repo.setForItem).toHaveBeenCalledTimes(2);
    expect(repo.setForItem.mock.calls.map(([, names]) => names)).toEqual([['one'], ['one', 'two']]);
  });

  it('re-reads once at the end, so the chips settle on the database rather than the patch', async () => {
    stored = [];
    render(<TagEditor itemId="item-1" />, { wrapper });
    await waitFor(() => expect(repo.getForItem).toHaveBeenCalledTimes(1));

    await commit('one');
    await commit('two');
    await settle();

    // The write queue holds the refetch back — only the last write invalidates — but it must
    // still happen, or the chips would sit on an optimistic patch nothing ever confirms.
    await waitFor(() => expect(repo.getForItem.mock.calls.length).toBeGreaterThan(1));
    expect(stored).toEqual(['one', 'two']);
  });

  it('applies the same protection to a location’s tags', async () => {
    stored = ['shelf'];
    render(<LocationTagEditor locationId="loc-1" />, { wrapper });
    await screen.findByRole('button', { name: 'Remove tag shelf' });

    await commit('cold');
    await commit('damp');
    await settle();

    // Sorted, because the stored order is the order the editor submitted them in and only the
    // membership matters — the repository reads the set back by name.
    await waitFor(() => expect([...stored].sort()).toEqual(['cold', 'damp', 'shelf']));
  });

  it('rolls the chips back to the server set when a write fails', async () => {
    stored = ['alpha'];
    repo.setForItem.mockImplementationOnce(async () => {
      throw new Error('write failed');
    });
    render(<TagEditor itemId="item-1" />, { wrapper });
    await screen.findByRole('button', { name: 'Remove tag alpha' });

    await commit('doomed');
    await settle();

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove tag doomed' })).toBeNull());
    expect(screen.getByRole('button', { name: 'Remove tag alpha' })).toBeTruthy();
    expect(stored).toEqual(['alpha']);
  });
});
