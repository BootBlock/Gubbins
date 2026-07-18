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
import { searchItems, whereIs, type LookupObserver } from './query.ts';
import type { RateLimiter } from './rate-limit.ts';
import { sendError, sendJson, sendMetrics } from './api/respond.ts';
import { readQueryParam, readResultLimit } from './api/params.ts';
import { API_V1_BASE, handleApiV1, isApiV1Path, pathAllowsUrlToken } from './api/v1.ts';
import { projectMetrics } from './feeds/metrics.ts';
import { formatMetrics } from './feeds/metrics-format.ts';
import type { WriteOperation } from './write.ts';
import { PushError, type PushSummary } from './push.ts';
import type { ItemDetailDto } from './api/dto.ts';
import type { HaClient } from './homeassistant/client.ts';

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

/** The read-only SSE event stream path (`GET /api/v1/events`); opt-in, present only when events are enabled. */
export const API_V1_EVENTS_PATH = `${API_V1_BASE}/events`;

/**
 * The opt-in **event stream** capability (`GUBBINS_BRIDGE_EVENTS=on`, or implied by
 * `GUBBINS_BRIDGE_WEBHOOKS=on`). Its presence is the runtime gate: when absent, `GET
 * /api/v1/events` is a `404` (the feature is invisible). `handleConnection` upgrades the
 * request to a long-lived `text/event-stream` — see `events/sse.ts`. Strictly read-only.
 */
export interface EventStreamCapability {
  readonly handleConnection: (req: IncomingMessage, res: ServerResponse, url: URL) => void;
}

/**
 * The opt-in **Home Assistant read** capability (`GUBBINS_BRIDGE_HA=on`). Its presence is the
 * runtime gate: when absent, the `/api/v1/scale/*` endpoints are a `404` (the feature is
 * invisible). Unlike every other capability here it reads from *outside* the snapshot — it calls
 * Home Assistant — so it needs no `BridgeServerState` and works before a snapshot has loaded.
 */
export interface ScaleCapability {
  /**
   * Narrowed to the two reads the endpoints actually serve: the client's startup `probe` is a
   * composition-root concern, and nothing reachable over HTTP should be able to trigger it.
   */
  readonly client: Pick<HaClient, 'listScaleEntities' | 'readScale'>;
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
  /**
   * The opt-in read-only event-stream capability (`GUBBINS_BRIDGE_EVENTS=on`, or implied by
   * `GUBBINS_BRIDGE_WEBHOOKS=on`). Omit to keep `GET /api/v1/events` a `404` (the SSE stream is
   * then unavailable). Read-only — it never mutates inventory.
   */
  readonly events?: EventStreamCapability;
  /**
   * The opt-in Home Assistant read capability (`GUBBINS_BRIDGE_HA=on`). Omit to keep the
   * `/api/v1/scale/*` endpoints a `404` (the scale reading is then unavailable to the PWA).
   */
  readonly scale?: ScaleCapability;
  /**
   * The opt-in resolved-lookup observer (`GUBBINS_BRIDGE_LOOKUP_EVENTS=on`). When present, each
   * `where` lookup that resolves publishes one read-triggered `lookup.resolved` event through the
   * usual sinks. Omit (the default) and lookups emit nothing at all.
   */
  readonly lookup?: LookupObserver;
}

/**
 * The base a request-line path is resolved against. An origin-form request line carries only the
 * path, so the base has to come from the `Host` header — without it every absolute URL the bridge
 * emits (the feed's `<link rel="self">`, the home link) would claim `localhost` no matter which
 * address the caller actually reached, and two readers on different ports would see identical
 * URLs. Falls back to `localhost` when the header is absent or not a usable authority (HTTP/1.0
 * clients may omit it), which only restores today's behaviour.
 *
 * The header is client-supplied, so it is never trusted beyond URL construction: it selects no
 * resource, is not logged, and reaches the feed body only through `escapeXml`. Reflecting it is
 * safe here because every response is `cache-control: no-store` — there is no shared cache for a
 * forged authority to poison.
 *
 * The scheme is always `http:` — the bridge serves plain HTTP on the LAN and deliberately does not
 * infer TLS from `X-Forwarded-Proto`, which is just another header a client can set. Behind a
 * TLS-terminating proxy the emitted links will say `http`.
 */
export function requestBase(hostHeader: string | undefined): string {
  // Anything beyond a bare `host[:port]` — userinfo, a path, a query, a fragment, a backslash —
  // is a malformed or hostile header rather than an authority; don't try to salvage it.
  if (hostHeader === undefined || !/^[^/?#@\\]+$/.test(hostHeader)) return 'http://localhost';
  try {
    return new URL(`http://${hostHeader}`).origin;
  } catch {
    return 'http://localhost';
  }
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
  const url = new URL(req.url ?? '/', requestBase(req.headers.host));
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

    if (!isAuthorised(req, options.token, url)) {
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
      // Every POST body the bridge accepts is JSON. A declared non-JSON type is refused with
      // `415` (RFC 9110 §15.5.16) rather than being parsed as JSON anyway — an HTML form post
      // reaching a write endpoint should fail loudly. A *missing* `Content-Type` is still
      // allowed: RFC 9110 §8.3 lets the recipient infer one, and a bodyless POST sends none.
      if (!isJsonContentType(req.headers['content-type'])) {
        req.resume();
        sendError(res, 415, 'unsupported_media_type', 'Body must be application/json', { v1: true });
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
        streamable: options.events !== undefined,
        scale: options.scale,
        body,
      });
      return;
    }

    // GET: no body to consume — drain anything sent so the socket closes cleanly.
    req.resume();

    // The SSE event stream is a long-lived response that needs the raw request (socket + close
    // events), so it is handled here rather than through the res-only v1 router. When events are
    // not enabled this falls through and the router answers 404 (the feature is invisible).
    if (options.events && url.pathname === API_V1_EVENTS_PATH) {
      options.events.handleConnection(req, res, url);
      return;
    }

    if (v1) {
      await handleApiV1(res, url, {
        method: 'GET',
        getState: options.getState,
        write: options.write,
        push: options.push,
        streamable: options.events !== undefined,
        scale: options.scale,
        lookup: options.lookup,
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
      case '/metrics':
        await handleMetrics(res, options);
        return;
      default:
        sendError(res, 404, 'not_found', 'Not found', { v1: false });
    }
  } catch (err) {
    // Never surface internals (SQL, paths, stack traces) to a *caller* — but do log the
    // message server-side (stdout/journal only, never the response), so an unexpected 500
    // is diagnosable from the logs rather than a silent, unexplained failure. No item data
    // or secrets pass through this path — only Error#message from our own code.
    console.error(`Internal error handling ${req.method} ${url.pathname}:`, err);
    if (!res.headersSent) sendError(res, 500, 'internal_error', 'Internal error', { v1 });
    else res.end();
  }
}

/**
 * Whether a request's `Content-Type` names a JSON media type. Accepts `application/json` and the
 * `+json` structured suffix (RFC 6839), with any parameters (`; charset=utf-8`) ignored, and
 * treats an absent header as acceptable — see the call site for why.
 */
function isJsonContentType(header: string | undefined): boolean {
  if (header === undefined) return true;
  const type = header.split(';', 1)[0]!.trim().toLowerCase();
  if (type.length === 0) return true;
  return type === 'application/json' || type.endsWith('+json');
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
    // The legacy flat `{ error }` envelope, same as every other unversioned error — `ok: false`
    // here would make /health the one legacy path with a bespoke error shape.
    sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: false });
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
async function handleSearch(res: ServerResponse, options: BridgeServerOptions, url: URL): Promise<void> {
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

/**
 * `GET /metrics` — a Prometheus/OpenMetrics text-exposition of the aggregate inventory counts
 * (items, low/out-of-stock, locations, per-location fullness). A read-only projection through the
 * app repositories (see `feeds/metrics.ts`), the same bearer token as every other endpoint. It
 * lives at the root `/metrics` (the Prometheus convention) rather than under `/api/v1`. Auth is
 * header-only here (a Prometheus scrape config can send an `Authorization: Bearer` header or read
 * it from a file), so — unlike the feeds/calendar — no `?token=` is accepted; on a trusted
 * loopback a scrape job can also share the token via its own config.
 */
async function handleMetrics(res: ServerResponse, options: BridgeServerOptions): Promise<void> {
  const state = options.getState();
  if (state === null) {
    sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: false });
    return;
  }
  sendMetrics(res, 200, formatMetrics(await projectMetrics(state.driver)));
}

/** `GET /where?q=` — the "where is X?" answer plus a spoken sentence. */
async function handleWhere(res: ServerResponse, options: BridgeServerOptions, url: URL): Promise<void> {
  const q = readQueryParam(res, url, false);
  if (q === null) return;

  const state = options.getState();
  if (state === null) {
    sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: false });
    return;
  }

  sendJson(res, 200, await whereIs(state.driver, q, { observer: options.lookup }));
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

/**
 * Constant-time bearer-token check. The token normally arrives as an `Authorization: Bearer …`
 * header. A missing/malformed header is unauthorised — **except** on the read-only subscription
 * paths (the calendar feed `GET /api/v1/calendar.ics` and the syndication feeds
 * `GET /api/v1/activity.{rss,atom,json}`), where the token may instead be supplied as a `?token=`
 * query parameter, because a calendar / feed client subscribing by URL cannot send an auth header.
 * That weaker token-in-URL posture (URLs get logged by proxies / browser history) is deliberately
 * scoped to just those read-only feed paths (see `pathAllowsUrlToken`); everything else — including
 * `/metrics` — requires the header.
 */
function isAuthorised(req: IncomingMessage, token: string, url: URL): boolean {
  const header = req.headers.authorization;
  const prefix = 'Bearer ';
  if (typeof header === 'string' && header.startsWith(prefix)) {
    if (constantTimeEqual(header.slice(prefix.length).trim(), token)) return true;
  }
  if (pathAllowsUrlToken(url.pathname)) {
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null && constantTimeEqual(queryToken, token)) return true;
  }
  return false;
}

/** Length-safe constant-time string comparison (avoids leaking the token via timing). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
