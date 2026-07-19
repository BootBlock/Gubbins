import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE } from '@/db/repositories/constants';
import { ID_BUCKET_SIZE, bucketIds, mergeBucketMaps } from './id-buckets';

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `id-${from + i}`);

describe('bucketIds', () => {
  it('returns no buckets for an empty window', () => {
    expect(bucketIds([])).toEqual([]);
  });

  it('slices into consecutive buckets of at most the bucket size', () => {
    expect(bucketIds(ids(5), 2)).toEqual([['id-0', 'id-1'], ['id-2', 'id-3'], ['id-4']]);
  });

  it('keeps every completed bucket identical as the window grows', () => {
    // The point of the seam (issue #169): appending a page must not re-key earlier buckets,
    // or each page re-reads the whole resident window.
    const first = bucketIds(ids(ID_BUCKET_SIZE * 2), ID_BUCKET_SIZE);
    const grown = bucketIds(ids(ID_BUCKET_SIZE * 3), ID_BUCKET_SIZE);
    expect(grown.slice(0, 2)).toEqual(first);
  });

  it('re-keys only the partly-filled tail bucket', () => {
    const before = bucketIds(ids(3), 2);
    const after = bucketIds(ids(4), 2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).not.toEqual(before[1]);
  });

  it('keeps every surviving bucket intact when the list trims a page off the front', () => {
    // `maxPages` trimming shifts the window rather than growing it. Because a bucket is a
    // page, a trim drops exactly one whole bucket and re-cuts none of the rest.
    const before = bucketIds(ids(ID_BUCKET_SIZE * 3), ID_BUCKET_SIZE);
    const trimmed = bucketIds(ids(ID_BUCKET_SIZE * 3, ID_BUCKET_SIZE), ID_BUCKET_SIZE);
    expect(trimmed.slice(0, 2)).toEqual(before.slice(1));
  });

  it('buckets by the page size, so a page load lands on a bucket boundary', () => {
    expect(ID_BUCKET_SIZE).toBe(DEFAULT_PAGE_SIZE);
  });

  it('rejects a bucket size below one', () => {
    expect(() => bucketIds(ids(3), 0)).toThrow(RangeError);
  });
});

describe('mergeBucketMaps', () => {
  it('is undefined while no bucket has loaded', () => {
    expect(mergeBucketMaps([undefined, undefined])).toBeUndefined();
    expect(mergeBucketMaps([])).toBeUndefined();
  });

  it('yields the buckets that have arrived while the rest are still loading', () => {
    const merged = mergeBucketMaps([new Map([['a', 1]]), undefined]);
    expect([...merged!]).toEqual([['a', 1]]);
  });

  it('merges disjoint buckets into one map', () => {
    const merged = mergeBucketMaps([
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
      new Map([['c', 3]]),
    ]);
    expect([...merged!]).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
  });
});
