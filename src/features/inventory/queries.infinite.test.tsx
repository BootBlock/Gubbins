/**
 * Wiring for `useInventoryItems`' keyset pagination (issue #172): the `getNextPageParam` /
 * `getPreviousPageParam` closures must derive the next/previous **cursor** from a page — advancing
 * the running absolute index by the rows returned, and stopping (returning `undefined`) at each end.
 *
 * Strategy mirrors `queries.test.tsx`: spy on `useInfiniteQuery` at the module boundary, capture the
 * options the hook hands it, and invoke the page-param closures directly with synthetic pages. No
 * database or real query runs — this pins the cursor arithmetic, not the fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const useInfiniteQuerySpy = vi.fn((_options?: unknown) => ({ data: undefined }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useInfiniteQuery: (options: unknown) => useInfiniteQuerySpy(options) };
});

import { useInventoryItems } from './queries';

type PageLike = {
  hasMore: boolean;
  offset: number;
  limit: number;
  rows: readonly unknown[];
  startCursor?: readonly (string | number | null)[];
  endCursor?: readonly (string | number | null)[];
};

type InfiniteOptions = {
  initialPageParam?: unknown;
  maxPages?: number;
  getNextPageParam?: (lastPage: PageLike) => unknown;
  getPreviousPageParam?: (firstPage: PageLike) => unknown;
};

function capturedOptions(): InfiniteOptions {
  renderHook(() => useInventoryItems());
  const call = useInfiniteQuerySpy.mock.calls.at(-1);
  return (call?.[0] ?? {}) as InfiniteOptions;
}

const page = (over: Partial<PageLike>): PageLike => ({
  hasMore: false,
  offset: 0,
  limit: 5,
  rows: [],
  ...over,
});

beforeEach(() => useInfiniteQuerySpy.mockClear());

describe('useInventoryItems — keyset page params', () => {
  it('starts with no cursor (the first page seeks nothing, at absolute index 0)', () => {
    expect(capturedOptions().initialPageParam).toBeNull();
  });

  it('bounds the resident window with maxPages', () => {
    expect(typeof capturedOptions().maxPages).toBe('number');
  });

  it('advances forward by the rows returned, seeking after the last endCursor', () => {
    const next = capturedOptions().getNextPageParam!(
      page({ hasMore: true, offset: 10, endCursor: [0, 'Widget', 'id-5'], rows: [1, 2, 3, 4, 5] }),
    );
    expect(next).toEqual({ cursor: [0, 'Widget', 'id-5'], direction: 'forward', startIndex: 15 });
  });

  it('stops paging forward when the last page is not full', () => {
    expect(capturedOptions().getNextPageParam!(page({ hasMore: false, endCursor: [1] }))).toBeUndefined();
  });

  it('stops paging forward when there is no cursor (an empty page carries none)', () => {
    expect(
      capturedOptions().getNextPageParam!(page({ hasMore: true, endCursor: undefined })),
    ).toBeUndefined();
  });

  it('seeks backward before the first startCursor, one page-worth earlier', () => {
    const prev = capturedOptions().getPreviousPageParam!(
      page({ offset: 10, limit: 5, startCursor: [0, 'Anchor', 'id-2'] }),
    );
    expect(prev).toEqual({ cursor: [0, 'Anchor', 'id-2'], direction: 'backward', startIndex: 5 });
  });

  it('clamps the backward start index at 0 and stops at the top of the list', () => {
    // A window whose first page is at offset 3 (< limit) clamps to 0 rather than going negative.
    expect(capturedOptions().getPreviousPageParam!(page({ offset: 3, limit: 5, startCursor: [1] }))).toEqual({
      cursor: [1],
      direction: 'backward',
      startIndex: 0,
    });
    // The very first page (offset 0) has nothing before it.
    expect(capturedOptions().getPreviousPageParam!(page({ offset: 0, startCursor: [1] }))).toBeUndefined();
  });
});
