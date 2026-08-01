/**
 * The on-card custom-field read is scoped to the fields the cards actually draw (issue #560).
 *
 * `useItemFieldValues` runs for a virtualised list's whole **resident window** — up to
 * `MAX_LIST_PAGES` pages of items, re-keyed as the user scrolls. Asking it for the items alone
 * returned each item's *entire* stored field set, so a card showing one short `TEXT` field also
 * dragged every unshown `LONG_TEXT` — and every unshown `IMAGE` field's base64 payload, bounded
 * only by `MAX_FIELD_IMAGE_BYTES` — across the worker's structured-clone boundary. The fix is
 * that the caller names its fields, so this pins *what the hook asks for*, which is the thing
 * that regressed.
 *
 * Strategy mirrors `whole-set-reads.test.tsx`: spy on `useQueries` at the module boundary and
 * inspect the query descriptors the hook passes, invoking a captured `queryFn` against a stub
 * repository — no query client, no database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

interface QueryDescriptor {
  readonly queryKey: readonly unknown[];
  readonly queryFn: () => Promise<unknown>;
  readonly enabled: boolean;
}

const useQueriesSpy = vi.fn((_options?: unknown) => ({ data: undefined }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQueries: (options: unknown) => useQueriesSpy(options) };
});

const repo = vi.hoisted(() => ({ getItemFieldValues: vi.fn() }));

vi.mock('@/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories')>();
  return { ...actual, getCategoryRepository: () => repo };
});

import { useItemFieldValues } from './categories';

const ITEMS = ['item-a', 'item-b'];

/** Render the hook and hand back the query descriptors it passed to `useQueries`. */
function capturedQueries(itemIds: readonly string[], fieldIds: readonly string[]): QueryDescriptor[] {
  renderHook(() => useItemFieldValues(itemIds, fieldIds));
  const options = (useQueriesSpy.mock.calls.at(-1)?.[0] ?? {}) as { queries?: QueryDescriptor[] };
  return options.queries ?? [];
}

beforeEach(() => {
  useQueriesSpy.mockClear();
  repo.getItemFieldValues.mockReset();
  repo.getItemFieldValues.mockResolvedValue(new Map());
});

describe('on-card custom-field values are read for the shown fields only (#560)', () => {
  it('asks the repository for just the chosen fields, not the items alone', async () => {
    const queries = capturedQueries(ITEMS, ['field-cover', 'field-title']);

    expect(queries).toHaveLength(1);
    await queries[0]!.queryFn();
    expect(repo.getItemFieldValues).toHaveBeenCalledWith(ITEMS, ['field-cover', 'field-title']);
  });

  it('marks the read disabled when no custom field is shown, so the window is never fetched', () => {
    const queries = capturedQueries(ITEMS, []);

    // `enabled` is the whole mechanism — React Query owns "don't run the queryFn" — so this is
    // the only fact this seam decides. Asserting the stubbed repository went untouched would
    // prove nothing here: the mocked `useQueries` never runs a descriptor's `queryFn` either way.
    expect(queries).toHaveLength(1);
    expect(queries[0]!.enabled).toBe(false);
  });

  it('keys on the field *set*, so reordering the card fields does not re-key the window', () => {
    const [first] = capturedQueries(ITEMS, ['field-title', 'field-cover']);
    const [reordered] = capturedQueries(ITEMS, ['field-cover', 'field-title']);

    // Same fields, drawn in the other order: the values fetched are identical, and re-keying
    // here would throw away the whole resident window's cache for a purely visual change.
    expect(reordered!.queryKey).toEqual(first!.queryKey);
  });

  it('keys separately for a different field set, so a narrower cache entry cannot answer it', () => {
    const [narrow] = capturedQueries(ITEMS, ['field-title']);
    const [wider] = capturedQueries(ITEMS, ['field-title', 'field-cover']);

    expect(wider!.queryKey).not.toEqual(narrow!.queryKey);
  });
});
