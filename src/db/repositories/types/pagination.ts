/**
 * Pagination envelope shared by every paginated repository read (spec §2.1).
 */

export interface PageParams {
  readonly limit?: number;
  readonly offset?: number;
}

export interface Page<T> {
  readonly rows: readonly T[];
  readonly limit: number;
  readonly offset: number;
  /** True when another page may exist (a full page was returned). */
  readonly hasMore: boolean;
}
