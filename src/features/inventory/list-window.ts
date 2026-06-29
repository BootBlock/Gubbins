/**
 * Absolute-index windowing for the virtualised item list (spec §2.1).
 *
 * The inventory list pages through `useInfiniteQuery`, and each row carries a
 * thumbnail BLOB. To stop a deep scroll from retaining every page's blobs in the
 * TanStack cache (the one place the "scales to 100,000+ items" design leaked
 * memory), the infinite queries cap retained pages with `maxPages`. That turns the
 * resident `items` array into a *sliding window* over the full result set rather
 * than its prefix.
 *
 * A flat-array virtualizer indexed from 0 would jump every time a page is trimmed
 * off the front. Instead the virtualizer is driven in **absolute** index space:
 * virtual row 0 is always result item 0, even after the first page is evicted, so
 * row positions stay stable while pages are trimmed off either end. These pure
 * helpers map between an absolute virtual row and the resident window — no DOM,
 * clock or React dependency, so they unit-test directly.
 */

/**
 * Absolute number of virtual rows spanning everything loaded so far: the resident
 * window occupies absolute item indices `[firstItemIndex, firstItemIndex + residentCount)`,
 * and the row count is the absolute end rounded up to whole rows. Rows below the
 * window are not counted (the tail-trigger fetches the next page); rows *above* the
 * window (trimmed off the front) are still counted so their absolute positions —
 * and the scroll offset — never shift.
 */
export function listRowCount(
  firstItemIndex: number,
  residentCount: number,
  columns: number,
): number {
  if (columns <= 0) return 0;
  return Math.ceil((firstItemIndex + residentCount) / columns);
}

/** How an absolute virtual row maps onto the resident `items` array. */
export interface ResidentRow {
  /** Slice start into the resident array (clamped to `[0, residentCount]`). */
  readonly start: number;
  /** Slice end (exclusive) into the resident array (clamped to `[0, residentCount]`). */
  readonly end: number;
  /** True when the row has at least one resident item to render (`end > start`). */
  readonly resident: boolean;
  /**
   * True when the row begins before the resident window — i.e. it was trimmed off
   * the front. When the *first* rendered row is above the window, the list fetches
   * the previous page to refill the prefix (absolute positioning means the refill
   * slots in above without moving the viewport).
   */
  readonly aboveWindow: boolean;
}

/**
 * Resolve one absolute virtual row against the resident window. `columns` items map
 * to each row; the resident window holds `residentCount` items starting at absolute
 * index `firstItemIndex`.
 */
export function resolveListRow(
  rowIndex: number,
  columns: number,
  firstItemIndex: number,
  residentCount: number,
): ResidentRow {
  const absStart = rowIndex * columns;
  const absEnd = absStart + columns;
  const start = clamp(absStart - firstItemIndex, 0, residentCount);
  const end = clamp(absEnd - firstItemIndex, 0, residentCount);
  return {
    start,
    end,
    resident: end > start,
    aboveWindow: absStart < firstItemIndex,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
