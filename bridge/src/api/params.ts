/**
 * Request-parameter parsing shared by the legacy paths and the versioned API.
 *
 * Pure-ish helpers: each either returns a validated value or (for `q`) writes a 400 in the
 * correct error envelope and returns null so the caller can bail. Pagination is clamped to
 * the {@link MAX_PAGE_LIMIT} ceiling here, before any DB call.
 */
import type { ServerResponse } from 'node:http';
import { sendError } from './respond.ts';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, MAX_QUERY_LENGTH } from './limits.ts';

/**
 * Read and validate the required `q` parameter. Returns the raw string, or null after
 * having already sent a 400 (missing or over-length) in the `v1`-appropriate envelope.
 */
export function readQueryParam(res: ServerResponse, url: URL, v1: boolean): string | null {
  const q = url.searchParams.get('q');
  if (q === null || q.trim().length === 0) {
    sendError(res, 400, 'bad_request', 'Missing required query parameter "q"', { v1 });
    return null;
  }
  if (q.length > MAX_QUERY_LENGTH) {
    sendError(res, 400, 'bad_request', `Query too long (max ${MAX_QUERY_LENGTH} characters)`, {
      v1,
    });
    return null;
  }
  return q;
}

/**
 * Parse the optional result `limit` for the relevance search (the query core does the real
 * clamping to its own ceiling). Returns undefined when absent or non-numeric.
 */
export function readResultLimit(url: URL): number | undefined {
  const raw = url.searchParams.get('limit');
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Offset/limit pagination for the browse list endpoints, clamped to the API's bounds. */
export interface PageRequest {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Parse `limit`/`offset` for a list endpoint, clamping `limit` to `[1, MAX_PAGE_LIMIT]`
 * (defaulting to {@link DEFAULT_PAGE_LIMIT}) and `offset` to `>= 0`. Garbage falls back to
 * the defaults rather than erroring, so a malformed query still returns a sane first page.
 */
export function readPage(url: URL): PageRequest {
  return {
    limit: clampInt(url.searchParams.get('limit'), DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT),
    offset: clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
