/**
 * Read **every** page of a paginated repository list into one array (issue #149).
 *
 * Repositories clamp every read to {@link MAX_PAGE_SIZE} (the strict §2.1 RPC ceiling), so a
 * caller that asks for one page and renders `rows` silently drops everything past row 100 —
 * the list looks complete, and nothing says otherwise. That is the right default for a browse
 * list (which pages instead), but it is wrong for a set that is **bounded by hand and read as
 * a whole**: a project's bill of materials, its expense ledger, a manual wishlist. Those feed
 * exports and on-screen totals, where a truncated read isn't a shorter list — it's a wrong
 * answer, quietly.
 *
 * This walks the pages until the set is exhausted, with a hard {@link ALL_PAGES_MAX_ROWS}
 * ceiling so a set that turns out not to be hand-bounded degrades into a reported truncation
 * rather than an unbounded read. Callers surface `truncated` — the point of this seam is that
 * nothing is cut short in silence.
 */
import { MAX_PAGE_SIZE } from '@/db/repositories/constants';

/**
 * Safety ceiling on a read-everything call. Generous enough that no hand-curated set reaches
 * it (a 10,000-line BOM is already far past what anyone types), but finite, so a caller that
 * points this at a table which grew without bound stops after 100 round trips and *says* it
 * stopped instead of walking a million rows.
 */
export const ALL_PAGES_MAX_ROWS = 10_000;

/** The slice of the repository `Page` envelope this seam needs — rows plus "is there more?". */
export interface PagedChunk<T> {
  readonly rows: readonly T[];
  readonly hasMore: boolean;
}

export interface AllPages<T> {
  readonly rows: readonly T[];
  /**
   * True when the {@link ALL_PAGES_MAX_ROWS} ceiling stopped the walk while the last page
   * read was still full — i.e. more rows may exist. Callers **must** surface this: it is the
   * one case where the returned set may be incomplete, and the whole point of reading
   * everything is that incompleteness is never silent.
   *
   * Deliberately conservative. A set whose size is an exact multiple of the ceiling really was
   * read whole, but a full final page is indistinguishable from a continuing one, so it is
   * reported as "there may be more" rather than claimed complete — hence the hedged copy.
   */
  readonly truncated: boolean;
}

/**
 * Walk `read` from offset 0 until it runs out of rows, concatenating every page.
 *
 * @param read One page of the underlying list — any repository method taking `{ limit, offset }`
 *   and returning the standard `Page` envelope.
 * @param options.pageSize Rows per round trip; clamped to {@link MAX_PAGE_SIZE}, which the
 *   repository would clamp to anyway.
 * @param options.maxRows Hard ceiling, defaulting to {@link ALL_PAGES_MAX_ROWS}.
 */
export async function readAllPages<T>(
  read: (params: { limit: number; offset: number }) => Promise<PagedChunk<T>>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<AllPages<T>> {
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(options.pageSize ?? MAX_PAGE_SIZE)));
  const maxRows = Math.max(1, Math.floor(options.maxRows ?? ALL_PAGES_MAX_ROWS));
  const rows: T[] = [];
  let offset = 0;

  for (;;) {
    const chunk = await read({ limit: pageSize, offset });
    rows.push(...chunk.rows);
    // A short page is the end of the set. An *empty* page ends the walk too, even where the
    // envelope still claims `hasMore` — advancing by zero would otherwise re-read the same
    // offset forever, and a spin is a worse failure than a missing row.
    if (!chunk.hasMore || chunk.rows.length === 0) return { rows, truncated: false };
    offset += chunk.rows.length;
    // `hasMore` was true, so stopping here genuinely leaves rows unread — say so.
    if (rows.length >= maxRows) return { rows, truncated: true };
  }
}
