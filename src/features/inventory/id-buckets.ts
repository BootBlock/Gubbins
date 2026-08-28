/**
 * Fixed-size id bucketing for the per-card batch reads (issue #169).
 *
 * The item-card tag and custom-field batches are fetched for the *resident window* of a
 * virtualised list — an array that grows by one page every time the user scrolls. Keying a
 * single query on the whole window makes every page load a brand-new key, so the batch
 * re-reads every resident id instead of just the new page, and each superseded key sits in
 * the cache until `gcTime` expires.
 *
 * Slicing the window into fixed-size buckets fixes both: because the window only ever grows
 * by appending, every completed bucket keeps the same ids — and therefore the same query key
 * — for the life of the scroll, so each id is read exactly once. Only the partially-filled
 * tail bucket re-keys as it fills.
 */
import { DEFAULT_PAGE_SIZE } from '@/db/repositories/constants';

/**
 * Ids per bucket. Deliberately *the page size*, not an independent constant — the alignment is
 * load-bearing twice over, and the two silently drifting apart would reintroduce the very
 * re-keying this seam exists to stop:
 *
 * - a window that grows a page at a time lands exactly on a bucket boundary, so not even the
 *   tail bucket re-keys; and
 * - once the list hits `MAX_LIST_PAGES` and starts trimming from the front, each trim drops
 *   exactly one whole bucket, so every surviving bucket keeps its ids (and its key) rather
 *   than being re-cut across the shifted window.
 */
export const ID_BUCKET_SIZE = DEFAULT_PAGE_SIZE;

/**
 * Slice `rows` into consecutive buckets of at most `size`. Order is preserved, so bucket *n*
 * holds the same entries however far the window has since grown.
 *
 * Generic over the element rather than fixed to `string`, because a caller that has the rows in
 * hand (the export's vault pass, which needs each bucket's items and not only their ids) would
 * otherwise have to re-derive the same slicing beside this one — and two slicings of the same
 * window is exactly what this seam exists to avoid.
 */
export function bucketIds<T>(rows: readonly T[], size: number = ID_BUCKET_SIZE): readonly (readonly T[])[] {
  if (size < 1) throw new RangeError(`bucketIds: size must be >= 1, got ${size}`);
  const buckets: (readonly T[])[] = [];
  for (let i = 0; i < rows.length; i += size) buckets.push(rows.slice(i, i + size));
  return buckets;
}

/**
 * Merge per-bucket result maps back into the single map the callers expect. Buckets are
 * disjoint slices of the window, so there are no keys to reconcile — later buckets simply
 * extend the map. Returns `undefined` while nothing has loaded, matching the single-query
 * shape the card renderers already handle; a partially-loaded window yields the buckets that
 * have arrived, so cards fill in as their page's read settles rather than all at once.
 */
export function mergeBucketMaps<V>(
  results: readonly (ReadonlyMap<string, V> | undefined)[],
): ReadonlyMap<string, V> | undefined {
  const loaded = results.filter((r): r is ReadonlyMap<string, V> => r !== undefined);
  if (loaded.length === 0) return undefined;
  if (loaded.length === 1) return loaded[0];
  const merged = new Map<string, V>();
  for (const map of loaded) for (const [key, value] of map) merged.set(key, value);
  return merged;
}
