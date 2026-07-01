/**
 * Local, read-only HTTP server (Phase HA-3; generic v1 API added later).
 *
 * A minimal `node:http` server — **stdlib only, no framework** (the HA-3 dependency
 * decision; matches CLAUDE.md's "minimal dependency surface" rule). It exposes two
 * surfaces over the same query core and the same auth + rate limit:
 *
 *   - **Legacy paths** (the shipped contract the Home Assistant integration depends on):
 *       GET /health   → { ok, itemCount, snapshotGeneratedAt }
 *       GET /search?q=&limit=  → { query, matches: ItemMatch[] }
 *       GET /where?q=          → { query, matches: WhereIsMatch[], spoken }
 *   - **Versioned API** under `/api/v1` (see `api/v1.ts`): the same three as aliases, plus
 *       items / locations / categories / capabilities and `openapi.json`.
 *
 * Strictly read-only: every request runs through the query core / repositories, whose only
 * SQL is the parameterised `parseASTtoSQL` — there is no write path reachable from here.
 * Every request must carry the shared bearer token; anything else is a 401. The current
 * database is read through an injected {@link BridgeServerState} accessor so the watcher can
 * swap it atomically underneath a live server, and so tests can drive the server in-process
 * with a hydrated fixture driver. Error envelopes are path-aware: legacy paths keep the flat
 * `{ error }`; `/api/v1` uses the structured `{ error: { code, message } }`.
 */
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { emptyAst } from '@/db/search/ast.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { searchItems, whereIs } from './query.ts';
import type { RateLimiter } from './rate-limit.ts';
import { sendError, sendJson } from './api/respond.ts';
import { readQueryParam, readResultLimit } from './api/params.ts';
import { API_V1_BASE, handleApiV1, isApiV1Path } from './api/v1.ts';
import type { WriteOperation } from './write.ts';
import { PushError, type PushSummary } from './push.ts';
import type { ItemDetailDto } from './api/dto.ts';

/** Whole-request timeout: a slow or stuck client is dropped rather than tying up a slot. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Headers must arrive within this window (slow-loris guard). */
export const HEADERS_TIMEOUT_MS = 5_000;
/** Hard cap on a POST body (the write endpoints take a tiny `{ delta, note? }` object). */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * The opt-in write capability, present only when `GUBBINS_BRIDGE_ALLOW_WRITES=on`. Its presence
 * is the runtime gate: when absent, a POST to a write path is a `404` (the feature is simply not
 * there). `execute` round-trips through the §7.3 sync merge — see `write.ts`.
 */
export interface WriteCapability {
  readonly execute: (op: WriteOperation) => Promise<ItemDetailDto>;
}

/** The versioned snapshot-ingest path (the PWA "push to bridge"); POST-only, opt-in. */
export const API_V1_SNAPSHOT_PATH = `${API_V1_BASE}/snapshot`;

/**
 * The opt-in **snapshot ingest** capability, present only when `GUBBINS_BRIDGE_ALLOW_PUSH=on`
 * (and the source is a JSON snapshot). Its presence is the runtime gate: when absent, a POST to
 * `/api/v1/snapshot` is a `404` (the feature is invisible). `ingest` streams the body to disk,
 * validates it, and atomically replaces the snapshot the watcher serves — see `push.ts`.
 */
export interface PushCapability {
  readonly ingest: (body: AsyncIterable<Uint8Array>) => Promise<PushSummary>;
}

/** A parsed request body: a successfully-parsed JSON value, or a marker that parsing failed. */
export type ParsedBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/** The live database the server reads, swapped atomically by the watcher. */
export interface BridgeServerState {
  /** A ready, hydrated, read-only driver. */
  readonly driver: IDatabaseDriver;
  /** ISO-8601 string of the snapshot's `generatedAt`, or null if unknown. */
  readonly snapshotGeneratedAt: string | null;
}

export interface BridgeServerOptions {
  /** Shared bearer token required on every request. */
  readonly token: string;
  /**
   * Returns the current state, or null before the first snapshot has loaded (the server
   * then answers 503 rather than serving from a half-loaded DB).
   */
  readonly getState: () => BridgeServerState | null;
  /**
   * Optional per-client abuse guard. When present, each request is charged a token before
   * routing; an exhausted client gets `429 Too Many Requests` + `Retry-After`. Omit to
   * disable (e.g. when relying solely on the LAN/firewall).
   */
  readonly rateLimiter?: RateLimiter;
  /**
   * The opt-in write capability (`GUBBINS_BRIDGE_ALLOW_WRITES=on`). Omit to keep the bridge
   * strictly read-only — a POST then gets a `404` as if the write paths didn't exist.
   */
  readonly write?: WriteCapability;
  /**
   * The opt-in snapshot-ingest capability (`GUBBINS_BRIDGE_ALLOW_PUSH=on`). Omit to keep the
   * `POST /api/v1/snapshot` path a `404` (the PWA "push to bridge" is then unavailable).
   * Independent of {@link write}.
   */
  readonly push?: PushCapability;
}

/**
 * Build the read-only bridge HTTP server. Not yet listening — the caller binds it
 * (`server.listen(port, host)`); the request/headers timeouts are pre-set as abuse
 * guards.
 */
export function createBridgeServer(options: BridgeServerOptions): Server {
  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, options);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

/**
 * Route and answer a single request. Exported for in-process testing; the outer
 * try/catch guarantees a generic 500 (never a stack trace or DB internals) on any
 * unexpected failure, so nothing sensitive leaks to the caller or the logs. The rate
 * limit, method and auth guards run before routing, so both surfaces share them.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const v1 = isApiV1Path(url.pathname);
  // Allow GET everywhere; POST only for the versioned write/ingest endpoints (and only when one
  // of those opt-ins is enabled). Anything else is a 405.
  const allow = options.write || options.push ? 'GET, POST, OPTIONS' : 'GET, OPTIONS';

  // CORS: the bridge authenticates with a bearer token (never a cookie), so the token itself
  // — not the browser's same-origin policy — is the security boundary; a permissive origin is
  // safe here and is what lets the PWA (almost always a *different* origin: a dev server, the
  // GitHub-Pages build, etc.) call the bridge straight from the browser — in particular the
  // "push to bridge" feature, whose POST triggers a CORS preflight. Applied to every response,
  // including errors, so a browser can always read the body rather than swallowing it as an
  // opaque network failure.
  res.setHeader('Access-Control-Allow-Origin', '*');

  // A CORS preflight is a plain capability check the browser makes before the real request; it
  // carries no Authorization header (browsers deliberately omit it on preflights), so it must be
  // answered before the auth/rate-limit guards below, and never counted against the rate limit.
  if (req.method === 'OPTIONS') {
    req.resume();
    res.writeHead(204, {
      'access-control-allow-methods': allow,
      'access-control-allow-headers': 'Authorization, Content-Type',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  try {
    // Abuse guard first (before any work, including the token check), so a flood from one
    // client can't tie up the loop. Keyed by source IP; this is a backstop, not the
    // security boundary (the token is). The IP never leaves the process and is not logged.
    if (options.rateLimiter) {
      const decision = options.rateLimiter.check(clientKey(req));
      if (!decision.allowed) {
        req.resume();
        sendError(res, 429, 'too_many_requests', 'Too many requests', {
          v1,
          headers: { 'retry-after': String(decision.retryAfterSec) },
        });
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'POST') {
      req.resume();
      sendError(res, 405, 'method_not_allowed', 'Method not allowed', { v1, headers: { allow } });
      return;
    }

    if (!isAuthorised(req, options.token)) {
      req.resume();
      sendError(res, 401, 'unauthorized', 'Unauthorised', {
        v1,
        headers: { 'www-authenticate': 'Bearer' },
      });
      return;
    }

    if (req.method === 'POST') {
      // Writes/ingest live only under /api/v1; a POST to a legacy path is method-not-allowed.
      if (!v1) {
        req.resume();
        sendError(res, 405, 'method_not_allowed', 'Method not allowed', { v1: false, headers: { allow } });
        return;
      }
      // The snapshot-ingest endpoint streams a (potentially large) body straight to disk, so it
      // is handled before — and instead of — the small bounded JSON-body read the write
      // endpoints use. When push is not opted in it is a 404 (invisible).
      if (url.pathname === API_V1_SNAPSHOT_PATH) {
        await handlePush(req, res, options.push);
        return;
      }
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      await handleApiV1(res, url, {
        method: 'POST',
        getState: options.getState,
        write: options.write,
        push: options.push,
        body,
      });
      return;
    }

    // GET: no body to consume — drain anything sent so the socket closes cleanly.
    req.resume();

    if (v1) {
      await handleApiV1(res, url, {
        method: 'GET',
        getState: options.getState,
        write: options.write,
        push: options.push,
      });
      return;
    }

    switch (url.pathname) {
      case '/health':
        await handleHealth(res, options);
        return;
      case '/search':
        await handleSearch(res, options, url);
        return;
      case '/where':
        await handleWhere(res, options, url);
        return;
      default:
        sendError(res, 404, 'not_found', 'Not found', { v1: false });
    }
  } catch {
    // Never surface internals (SQL, paths, stack traces) to a caller.
    if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal error', { v1 });
    else res.end();
  }
}

/**
 * Read and JSON-parse a bounded request body. Caps the byte count (an abuse guard) and keeps
 * draining once the cap is hit so the socket still ends cleanly; an over-large or non-JSON body
 * yields `{ ok: false }` for the caller to turn into a `400`. An empty body parses to `{}`.
 */
async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    if (tooLarge) continue;
    total += chunk.length;
    if (total > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) return { ok: false };
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * `POST /api/v1/snapshot` — the opt-in PWA "push to bridge". Streams the body to disk and
 * atomically replaces the served snapshot (see `push.ts`); the watcher re-hydrates it. A `404`
 * when push is not opted in (the feature is invisible). A {@link PushError} maps to its status +
 * v1 error code; anything unexpected propagates to the caller's generic 500.
 */
async function handlePush(
  req: IncomingMessage,
  res: ServerResponse,
  push: PushCapability | undefined,
): Promise<void> {
  if (push === undefined) {
    req.resume();
    sendError(res, 404, 'not_found', 'Not found', { v1: true });
    return;
  }
  try {
    const summary = await push.ingest(req);
    sendJson(res, 200, { ok: true, formatVersion: summary.formatVersion, generatedAt: summary.generatedAt });
  } catch (err) {
    req.resume(); // drain any unconsumed body (e.g. the stream was aborted at the size cap)
    if (err instanceof PushError) {
      sendError(res, err.status, err.code, err.message, { v1: true });
      return;
    }
    throw err; // unexpected → the caller's generic 500
  }
}

/** `GET /health` — liveness plus a cheap snapshot summary. */
async function handleHealth(res: ServerResponse, options: BridgeServerOptions): Promise<void> {
  const state = options.getState();
  if (state === null) {
    sendJson(res, 503, { ok: false, error: 'Snapshot not loaded yet' });
    return;
  }
  // Count through the app's own search path (emptyAst → parseASTtoSQL), never bespoke SQL.
  const itemCount = await new ItemRepository(state.driver).countByAst(emptyAst('AND'));
  sendJson(res, 200, {
    ok: true,
    itemCount,
    snapshotGeneratedAt: state.snapshotGeneratedAt,
  });
}

/** `GET /search?q=&limit=` — compact item DTOs (limit clamped by the query core). */
async function handleSearch(
  res: ServerResponse,
  options: BridgeServerOptions,
  url: URL,
): Promise<void> {
  const q = readQueryParam(res, url, false);
  if (q === null) return;

  const state = options.getState();
  if (state === null) {
    sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: false });
    return;
  }

  const matches = await searchItems(state.driver, q, { limit: readResultLimit(url) });
  sendJson(res, 200, { query: q.trim(), matches });
}

/** `GET /where?q=` — the "where is X?" answer plus a spoken sentence. */
async function handleWhere(
  res: ServerResponse,
  options: BridgeServerOptions,
  url: URL,
): Promise<void> {
  const q = readQueryParam(res, url, false);
  if (q === null) return;

  const state = options.getState();
  if (state === null) {
    sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: false });
    return;
  }

  sendJson(res, 200, await whereIs(state.driver, q));
}

/**
 * Rate-limit key for a request: the source IP from the socket. We deliberately do **not**
 * trust `X-Forwarded-For` (it is client-supplied and trivially spoofable), so the limiter
 * can't be evaded by forging a header. Falls back to a single shared bucket when the
 * address is somehow unavailable.
 */
function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/** Constant-time bearer-token check. A missing/malformed header is simply unauthorised. */
function isAuthorised(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return constantTimeEqual(header.slice(prefix.length).trim(), token);
}

/** Length-safe constant-time string comparison (avoids leaking the token via timing). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
