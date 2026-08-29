/**
 * Shared request/pagination bounds for both the legacy paths and the versioned API.
 *
 * Kept in their own module so `server.ts` (legacy) and `api/v1.ts` (versioned) import the
 * same numbers without a circular dependency. All are abuse guards: a bounded `q`, and a
 * hard ceiling on page size so a list endpoint can never be coerced into dumping the whole
 * inventory in one response.
 */

/** Hard cap on the `q` parameter length — an abuse guard against pathological queries. */
export const MAX_QUERY_LENGTH = 200;

/** Default page size for list endpoints when `limit` is omitted. */
export const DEFAULT_PAGE_LIMIT = 50;

/**
 * Hard ceiling on a list endpoint's page size, regardless of the requested `limit`. Mirrors
 * the repositories' own `MAX_PAGE_SIZE` clamp, so the API never asks the DB for more than the
 * repository would serve anyway.
 */
export const MAX_PAGE_LIMIT = 100;

/**
 * Hard cap on how many distinct fields a single `fields`/`include` selection may name — an
 * abuse guard so a pathological query can't request an absurd projection. Comfortably above
 * the whole item vocabulary (~33 fields), so it never bites a legitimate caller.
 */
export const MAX_SELECTED_FIELDS = 100;

/** Hard cap on `$orderby` terms — an abuse guard against an absurdly long sort key. */
export const MAX_ORDERBY_TERMS = 8;

/** Hard cap on the raw `$filter` string length — an abuse guard against a pathological filter. */
export const MAX_FILTER_LENGTH = 512;

// There is deliberately no row cap on the CSV export any more (issue #533). It existed to stop a
// `.csv` pull buffering an unbounded result set, which it did by truncating at 100,000 rows — and
// truncating in silence, so a larger catalogue exported a prefix and said nothing. The export now
// streams a keyset-paged walk (`items-csv.ts`), holding one page rather than the whole document,
// so the memory it was guarding no longer grows with the answer and the guard has nothing left to
// buy. Do not reinstate one without a way for the response to say it applied.
