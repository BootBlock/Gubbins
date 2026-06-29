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
