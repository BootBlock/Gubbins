/**
 * Shared HTTP response helpers for the bridge (legacy + versioned API).
 *
 * Two error envelopes coexist deliberately:
 *
 *   - **Legacy** (the unversioned `/health`, `/search`, `/where` paths the Home Assistant
 *     integration depends on): a flat `{ "error": "<message>" }` — byte-for-byte what the
 *     bridge has always returned, so that contract never regresses.
 *   - **v1** (everything under `/api/v1`): a structured `{ "error": { "code", "message" } }`
 *     so third-party consumers can branch on a stable machine-readable `code`.
 *
 * Both are written by the same {@link sendJson}; {@link sendError} just picks the shape
 * from the `v1` flag. No PII is ever placed in a message (CLAUDE.md / security checklist).
 */
import type { ServerResponse } from 'node:http';
import type { CacheValidators } from './conditional.ts';

/** Stable, machine-readable error codes for the v1 envelope. */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  // The token was valid but its owner's role does not permit this route — HTTP 403. Distinct
  // from `unauthorized` on purpose: "I don't know who you are" and "I know exactly who you are
  // and the answer is no" call for different fixes, and conflating them would send an operator
  // hunting for a bad token when the actual problem is a role (issue #79).
  | 'forbidden'
  | 'not_found'
  | 'method_not_allowed'
  | 'too_many_requests'
  | 'snapshot_unavailable'
  // A POST whose `Content-Type` is not JSON — HTTP 415. The body is never parsed, so a form
  // encoding or `text/plain` is refused rather than silently read as JSON.
  | 'unsupported_media_type'
  // A well-formed write that the domain rejected (e.g. quantity below zero, wrong tracking
  // mode) — HTTP 422. Only reachable when the opt-in write endpoints are enabled.
  | 'unprocessable'
  // A pushed snapshot exceeded the configured size cap — HTTP 413. Only reachable when the
  // opt-in snapshot-ingest endpoint (GUBBINS_BRIDGE_ALLOW_PUSH=on) is enabled.
  | 'payload_too_large'
  // A genuine scale that could not be read — HTTP 409. Only reachable when the opt-in Home
  // Assistant read (GUBBINS_BRIDGE_HA=on) is enabled. Two distinct codes because they need
  // different words in front of the user: hardware/integration versus a sensor not reporting a
  // number. An entity that isn't a scale is answered as a `404`, not one of these (issue #179).
  | 'scale_unavailable'
  | 'scale_not_a_number'
  // The bridge could not talk to Home Assistant, or was refused by it — HTTP 502/404. Likewise
  // only reachable when the Home Assistant read is enabled.
  | 'home_assistant_unreachable'
  | 'home_assistant_unauthorised'
  | 'home_assistant_error'
  | 'internal_error';

/**
 * Seconds a client should wait before retrying a `503 snapshot_unavailable`. Short, because the
 * snapshot watcher hydrates within a debounce of the file appearing — this is "try again in a
 * moment", not a back-off schedule.
 */
export const SNAPSHOT_RETRY_AFTER_SEC = 5;

/** Write a JSON response with no-store caching and optional extra headers. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

/** Write a `text/plain` response — used by the OData `/$count` path (a bare integer). */
export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** Write an `application/xml` response — used by the OData `$metadata` (CSDL) document. */
export function sendXml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/**
 * Write a `text/csv` response as a downloadable attachment — used by the `items.csv` export.
 * The `filename` is a fixed, safe literal (never user input), so no escaping is required.
 */
export function sendCsv(res: ServerResponse, status: number, body: string, filename: string): void {
  res.writeHead(status, {
    'content-type': 'text/csv; charset=utf-8',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${filename}"`,
  });
  res.end(body);
}

/**
 * `Cache-Control` for a feed response that carries validators (issue #363).
 *
 * `no-cache` does **not** mean "don't cache" — it means "store it, but revalidate with the origin
 * before every reuse", which is exactly the contract the validators make good on: the subscriber
 * keeps its copy and each poll costs a conditional request instead of a full re-render. `private`
 * keeps that copy to the subscribing client: a feed carries personal inventory (item names,
 * borrowers, locations) behind a bearer token, so no shared or intermediary cache may hold one.
 */
export const FEED_CACHE_CONTROL = 'private, no-cache';

/**
 * The caching headers for a feed response: the validators plus the revalidate-every-time
 * `Cache-Control` when the bridge has a validator to offer, and the historical `no-store`
 * when it does not (no loaded snapshot ⇒ no honest basis for one).
 */
function cacheHeaders(validators: CacheValidators | undefined): Record<string, string> {
  if (validators === undefined) return { 'cache-control': 'no-store' };
  return {
    'cache-control': FEED_CACHE_CONTROL,
    etag: validators.etag,
    'last-modified': validators.lastModified,
  };
}

/**
 * Write a `text/calendar` (iCalendar / RFC 5545) response — used by the calendar subscription
 * feed. `inline` (not an attachment) so a calendar client that fetches the subscription URL
 * renders it rather than offering it as a download. Pass `validators` so a polling client can
 * revalidate its copy (see {@link cacheHeaders}); omit them and the response stays uncacheable.
 */
export function sendCalendar(
  res: ServerResponse,
  status: number,
  body: string,
  validators?: CacheValidators,
): void {
  res.writeHead(status, {
    'content-type': 'text/calendar; charset=utf-8',
    ...cacheHeaders(validators),
    'content-disposition': 'inline; filename="gubbins.ics"',
  });
  res.end(body);
}

/**
 * Write a syndication-feed response (RSS / Atom / JSON Feed). `inline` (not an attachment) so a
 * feed reader that fetches the subscription URL renders it rather than downloading it. The
 * `contentType` names the exact feed media type (e.g. `application/rss+xml`); `validators` let a
 * polling reader revalidate rather than refetch.
 */
export function sendFeed(
  res: ServerResponse,
  status: number,
  body: string,
  contentType: string,
  validators?: CacheValidators,
): void {
  res.writeHead(status, {
    'content-type': `${contentType}; charset=utf-8`,
    ...cacheHeaders(validators),
  });
  res.end(body);
}

/**
 * Write a Prometheus/OpenMetrics text-exposition response. The `text/plain; version=0.0.4` content
 * type is the Prometheus exposition format a scrape accepts directly; `validators` let a client
 * that does revalidate skip the whole projection (a Prometheus scrape simply ignores them).
 */
export function sendMetrics(
  res: ServerResponse,
  status: number,
  body: string,
  validators?: CacheValidators,
): void {
  res.writeHead(status, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    ...cacheHeaders(validators),
  });
  res.end(body);
}

/**
 * Write a bodyless `304 Not Modified` — the answer to a conditional poll whose cached copy is
 * still current. RFC 9110 §15.4.5 requires a 304 to repeat the header fields that guide cache
 * use (the validators and `Cache-Control`), so the client's stored copy is refreshed with the
 * same terms it would have got from a `200`.
 */
export function sendNotModified(res: ServerResponse, validators: CacheValidators): void {
  res.writeHead(304, cacheHeaders(validators));
  res.end();
}

/**
 * Write an error response in whichever envelope the request path calls for: the
 * structured `{ error: { code, message } }` for v1, or the flat `{ error: message }` for
 * the legacy paths. The `code` is ignored for the legacy shape (kept identical to the
 * historical contract); the human `message` is shared, so wording stays in one place.
 */
export function sendError(
  res: ServerResponse,
  status: number,
  code: ApiErrorCode,
  message: string,
  options: { v1: boolean; headers?: Readonly<Record<string, string>> },
): void {
  const body = options.v1 ? { error: { code, message } } : { error: message };
  const headers = options.headers ?? {};
  // RFC 9110 §15.6.4 recommends `Retry-After` on a 503. Every 503 the bridge emits means the
  // same thing — no snapshot hydrated yet — and the watcher re-hydrates as soon as the file
  // lands, so a short fixed delay is the honest answer. An explicit header still wins.
  const withRetry: Record<string, string> =
    status === 503 && headers['retry-after'] === undefined
      ? { 'retry-after': String(SNAPSHOT_RETRY_AFTER_SEC), ...headers }
      : { ...headers };
  sendJson(res, status, body, withRetry);
}
