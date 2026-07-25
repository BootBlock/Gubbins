import { describe, expect, it, vi } from 'vitest';
import { ALL_PAGES_MAX_ROWS, readAllPages } from './read-all-pages';

/** A fake paginated repository read over a fixed array, using the real `hasMore` contract. */
function pagedReader<T>(all: readonly T[]) {
  return vi.fn(async ({ limit, offset }: { limit: number; offset: number }) => {
    const rows = all.slice(offset, offset + limit);
    return { rows, hasMore: rows.length === limit };
  });
}

describe('readAllPages', () => {
  it('returns an empty, untruncated result for an empty set', async () => {
    const read = pagedReader([]);
    await expect(readAllPages(read)).resolves.toEqual({ rows: [], truncated: false });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads a set smaller than one page in a single round trip', async () => {
    const read = pagedReader([1, 2, 3]);
    const result = await readAllPages(read, { pageSize: 10 });
    expect(result).toEqual({ rows: [1, 2, 3], truncated: false });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('walks every page of a set that spans several', async () => {
    const all = Array.from({ length: 250 }, (_, i) => i);
    const read = pagedReader(all);
    const result = await readAllPages(read, { pageSize: 100 });
    expect(result.rows).toEqual(all);
    expect(result.truncated).toBe(false);
    // 100 + 100 + 50 — the short third page ends the walk.
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('needs one extra read when the set is an exact multiple of the page size', async () => {
    // `hasMore` means "a full page came back", so an exactly-full final page can't be told
    // apart from a continuing one without asking once more.
    const all = Array.from({ length: 200 }, (_, i) => i);
    const read = pagedReader(all);
    const result = await readAllPages(read, { pageSize: 100 });
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('clamps the page size to the repository ceiling', async () => {
    const read = pagedReader(Array.from({ length: 10 }, (_, i) => i));
    await readAllPages(read, { pageSize: 5_000 });
    expect(read).toHaveBeenCalledWith({ limit: 100, offset: 0 });
  });

  it('reports truncation when the row ceiling stops it short', async () => {
    const all = Array.from({ length: 500 }, (_, i) => i);
    const read = pagedReader(all);
    const result = await readAllPages(read, { pageSize: 100, maxRows: 250 });
    // The ceiling bites between pages, so it stops on the first page that reaches it.
    expect(result.rows).toHaveLength(300);
    expect(result.truncated).toBe(true);
  });

  it('reports truncation conservatively when the ceiling lands on a full final page', async () => {
    const all = Array.from({ length: 200 }, (_, i) => i);
    const read = pagedReader(all);
    const result = await readAllPages(read, { pageSize: 100, maxRows: 200 });
    // Every row was in fact read, but the ceiling stopped the walk on a *full* page — which is
    // indistinguishable from a continuing one — so it reports "there may be more" rather than
    // claiming completeness it can't verify. The copy this drives is hedged for exactly this.
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('stops on an empty page even when the envelope still claims there is more', async () => {
    // A miscounted envelope must not spin: advancing by zero rows would re-read forever.
    const read = vi.fn(async () => ({ rows: [] as number[], hasMore: true }));
    const result = await readAllPages(read);
    expect(result).toEqual({ rows: [], truncated: false });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('defaults its ceiling to ALL_PAGES_MAX_ROWS', async () => {
    const all = Array.from({ length: ALL_PAGES_MAX_ROWS + 100 }, (_, i) => i);
    const result = await readAllPages(pagedReader(all));
    expect(result.rows).toHaveLength(ALL_PAGES_MAX_ROWS);
    expect(result.truncated).toBe(true);
  });
});
