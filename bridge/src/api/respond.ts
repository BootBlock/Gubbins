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

/** Stable, machine-readable error codes for the v1 envelope. */
export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'method_not_allowed'
  | 'too_many_requests'
  | 'snapshot_unavailable'
  // A well-formed write that the domain rejected (e.g. quantity below zero, wrong tracking
  // mode) — HTTP 422. Only reachable when the opt-in write endpoints are enabled.
  | 'unprocessable'
  // A pushed snapshot exceeded the configured size cap — HTTP 413. Only reachable when the
  // opt-in snapshot-ingest endpoint (GUBBINS_BRIDGE_ALLOW_PUSH=on) is enabled.
  | 'payload_too_large'
  | 'internal_error';

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
  sendJson(res, status, body, options.headers ?? {});
}
