/**
 * Pagination envelope shared by every paginated repository read (spec §2.1).
 */

/** An opaque keyset cursor — one boundary row's ordering-column values (issue #172). */
export type Cursor = readonly (string | number | null)[];

export interface PageParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly rows: readonly T[];
  readonly limit: number;
  /**
   * The absolute index of this page's first row in the full result set. For an offset read it is
   * the SQL `OFFSET`; for a keyset (seek) read it is the running index carried in the cursor
   * pageParam — either way the virtualised list treats it as the row's absolute position, so the
   * infinite-scroll seam is identical whichever way the page was fetched (issue #172).
   */
  readonly offset: number;
  /** True when another page may exist (a full page was returned). */
  readonly hasMore: boolean;
  /**
   * Keyset cursors for the first / last row of this page (issue #172), populated only by reads
   * that support seeking (the item list). `getNextPageParam` seeks after `endCursor`;
   * `getPreviousPageParam` seeks before `startCursor`. Absent on an empty page and on reads that
   * only ever page by offset.
   */
  readonly startCursor?: Cursor;
  readonly endCursor?: Cursor;
}
