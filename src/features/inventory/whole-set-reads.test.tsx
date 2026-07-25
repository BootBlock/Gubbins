/**
 * The two catalogue **lookup** reads must be unbounded (issue #148).
 *
 * `useLocations` and `useCategories` are not scrollable lists — they are the lookup tables the
 * pickers, facets and name resolution work from. Read through the strict page ceiling
 * (`MAX_PAGE_SIZE`, 100) they gave *wrong* answers rather than short ones once a catalogue grew
 * past a page: an item in the 101st location or category rendered as unassigned / uncategorised,
 * and neither could be offered as a move target or a filter. Both therefore go through their
 * repository's uncapped `listAll`.
 *
 * Strategy mirrors `queries.test.tsx`: spy on `useQuery` at the module boundary, then invoke the
 * captured `queryFn` directly against a stub repository. That pins *which* read the hook issues —
 * the thing that regressed — without standing up a query client or a database.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const useQuerySpy = vi.fn((_options?: unknown) => ({ data: undefined }));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: (options: unknown) => useQuerySpy(options) };
});

/** Stub repositories: `list` is the capped read neither hook may reach for. */
const repos = vi.hoisted(() => ({
  locationList: vi.fn(),
  locationListAll: vi.fn(),
  categoryList: vi.fn(),
  categoryListAll: vi.fn(),
}));

vi.mock('@/db/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db/repositories')>();
  return {
    ...actual,
    getLocationRepository: () => ({ list: repos.locationList, listAll: repos.locationListAll }),
    getCategoryRepository: () => ({ list: repos.categoryList, listAll: repos.categoryListAll }),
  };
});

import { useCategories } from './categories';
import { useLocations } from './queries';

type QueryOptions = { queryFn?: (context?: unknown) => Promise<{ rows: readonly unknown[] }> };

/** Render a hook and hand back the `queryFn` it passed to useQuery. */
function capturedQueryFn(hook: () => unknown): NonNullable<QueryOptions['queryFn']> {
  renderHook(hook);
  const options = (useQuerySpy.mock.calls.at(-1)?.[0] ?? {}) as QueryOptions;
  expect(options.queryFn).toBeTypeOf('function');
  return options.queryFn!;
}

/** More rows than the strict page ceiling would ever return. */
const manyRows = (prefix: string) =>
  Array.from({ length: 150 }, (_, i) => ({ id: `${prefix}-${i}`, name: `${prefix} ${i}` }));

beforeEach(() => {
  useQuerySpy.mockClear();
  for (const stub of Object.values(repos)) stub.mockReset();
});

describe('catalogue lookup reads are unbounded (#148)', () => {
  it('useLocations reads every location, never the capped page', async () => {
    const rows = manyRows('loc');
    repos.locationListAll.mockResolvedValue(rows);

    const page = await capturedQueryFn(() => useLocations())();

    expect(repos.locationList).not.toHaveBeenCalled();
    expect(page.rows).toHaveLength(rows.length);
    // The Page envelope every caller reads (`.rows`) is preserved, and reports no further pages.
    expect(page).toMatchObject({ limit: rows.length, offset: 0, hasMore: false });
  });

  it('useCategories reads every category, never the capped page', async () => {
    const rows = manyRows('cat');
    repos.categoryListAll.mockResolvedValue(rows);

    const page = await capturedQueryFn(() => useCategories())();

    expect(repos.categoryList).not.toHaveBeenCalled();
    expect(page.rows).toHaveLength(rows.length);
    expect(page).toMatchObject({ limit: rows.length, offset: 0, hasMore: false });
  });
});
