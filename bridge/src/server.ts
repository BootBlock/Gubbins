/**
 * Local, read-only HTTP server (Phase HA-3; generic v1 API added later).
 *
 * A minimal `node:http` server — **stdlib only, no framework** (the HA-3 dependency
 * decision; matches CLAUDE.md's "minimal dependency surface" rule). It exposes two
 * surfaces over the same query core and the same auth + rate limit:
 *
 *   - **Legacy paths** (the shipped contract the Home Assistant integration depends on):
 *       GET /health   → { ok, itemCount, snapshotGeneratedAt, + reload health }
 *       GET /search?q=&limit=  → { query, matches: ItemMatch[] }
 *       GET /where?q=          → { query, matches: WhereIsMatch[], spoken }
 *   - **Versioned API** under `/api/v1` (see `api/v1.ts`): the same three as aliases, plus
 *       items / locations / categories / capabilities and `openapi.json`.
 *
 * Every read is answerable by `HEAD` as well as `GET` (RFC 9110 §9.1) — the same handler runs and
 * its content is withheld, so a calendar or feed client that probes with `HEAD` before subscribing
 * sees the headers it expects rather than a `405` (see `api/head.ts`).
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
import { ItemRepository } from '@/db/repositories/ItemRepository.ts';
import { emptyAst } from '@/db/search/ast.ts';
import type { IDatabaseDriver } from '@/db/rpc/driver';
import { searchItems, whereIs, type LookupObserver } from './query.ts';
import type { RateLimiter } from './rate-limit.ts';
import { sendError, sendJson, sendMetrics, sendNotModified } from './api/respond.ts';
import { suppressResponseBody } from './api/head.ts';
import {
  cacheValidators,
  isNotModified,
  readConditionalHeaders,
  snapshotInstant,
  type ConditionalHeaders,
} from './api/conditional.ts';
import { readQueryParam, readResultLimit } from './api/params.ts';
import { API_V1_BASE, handleApiV1, isApiV1Path, isODataPath, pathAllowsUrlToken } from './api/v1.ts';
import { ODATA_VERSION } from './api/odata-service.ts';
import { isPermitted, resolveIdentity } from './identity.ts';
import { corsAllowOrigin, WILDCARD_ORIGINS, type AllowedOrigins } from './cors.ts';
import { EVENT_STREAM_CONTENT_TYPE } from './events/sse.ts';
import { SCALE_STREAM_CONTENT_TYPE } from './homeassistant/scale-stream.ts';
import { projectMetrics } from './feeds/metrics.ts';
import { formatMetrics } from './feeds/metrics-format.ts';
import type { WriteExecute } from './write.ts';
import { isValidIdempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH } from './idempotency.ts';
import { PushError, type PushSummary } from './push.ts';
import type { HaClient } from './homeassistant/client.ts';
import type { WebhookDeliveryLog, WebhookDeliveryRecord } from './events/webhook-log.ts';
import type { WebhookDeliveryTarget, WebhookSecrets } from './events/webhook-targets.ts';
import type { BridgeEvent } from './events/model.ts';
import { healthBody, type SnapshotHealthReport } from './snapshot-health.ts';

/** Whole-request timeout: a slow or stuck client is dropped rather than tying up a slot. */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Headers must arrive within this window (slow-loris guard). */
export const HEADERS_TIMEOUT_MS = 5_000;
/** Hard cap on a POST body (the write endpoints take a small, flat JSON object). */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * The opt-in write capability, present only when `GUBBINS_BRIDGE_ALLOW_WRITES=on`. Its presence
 * is the runtime gate: when absent, a POST to a write path is a `404` (the feature is simply not
 * there). `execute` round-trips through the §7.3 sync merge — see `write.ts`.
 */
export interface WriteCapability {
  /**
   * Apply one operation, attributing the resulting Activity-Ledger entry to `actorUserId` —
   * the owner of the token that authorised the request (issue #79, plan §1.3). The actor is a
   * required argument for the reason the plan gives at §2.4: a caller that forgets one should
   * fail to compile rather than quietly write everything as System, which is what the bridge
   * did when it had only a shared token to go on.
   *
   * `idempotencyKey` carries the caller's `Idempotency-Key` header when it sent one. A repeat of
   * a request under the same key is answered with the first one's result instead of being applied
   * again — the retry-after-timeout defence described in `idempotency.ts` (issue #567).
   */
  readonly execute: WriteExecute;
}

/** The versioned snapshot-ingest path (the PWA "push to bridge"); POST-only, opt-in. */
export const API_V1_SNAPSHOT_PATH = `${API_V1_BASE}/snapshot`;

/**
 * The opt-in **snapshot ingest** capability, present only when `GUBBINS_BRIDGE_ALLOW_PUSH=on`
 * (and the source is a JSON snapshot). Its presence is the runtime gate: when absent, a POST to
 * `/api/v1/snapshot` is a `404` (the feature is invisible). `ingest` streams the body to disk,
 * validates it, and merges it into the snapshot the watcher serves — writing the result
 * atomically (placed verbatim only when there is nothing to merge into) — see `push.ts`.
 */
export interface PushCapability {
  readonly ingest: (body: AsyncIterable<Uint8Array>) => Promise<PushSummary>;
}

/** The read-only SSE event stream path (`GET /api/v1/events`); opt-in, present only when events are enabled. */
export const API_V1_EVENTS_PATH = `${API_V1_BASE}/events`;

/**
 * The live scale-reading stream path (`GET /api/v1/scale/stream`); opt-in, present only when Home
 * Assistant reads are enabled. A *separate* stream from `/api/v1/events` on purpose — see the note
 * at the top of `homeassistant/scale-stream.ts`.
 */
export const API_V1_SCALE_STREAM_PATH = `${API_V1_BASE}/scale/stream`;

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
  /**
   * The live-reading stream behind `GET /api/v1/scale/stream` (issue #125). Like the event stream
   * it needs the raw request (socket + close events), so it is handled in `server.ts` rather than
   * through the res-only v1 router — see `homeassistant/scale-stream.ts`.
   *
   * Optional purely as a wiring seam: the composition root always supplies one when Home
   * Assistant reads are on, and a capability without it leaves the path falling through to the
   * router's `404`, exactly as an unknown sub-path under `/scale` does.
   */
  readonly stream?: ScaleStreamCapability;
}

/** The scale stream's half of {@link ScaleCapability} — an async handler, unlike the event hub's. */
export interface ScaleStreamCapability {
  readonly handleConnection: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
}

/**
 * The opt-in **webhook test-fire** capability (`GUBBINS_BRIDGE_WEBHOOKS=on`), backing
 * `POST /api/v1/webhooks/test` (webhooks plan §5.5). Its presence is the runtime gate: when absent
 * that path is a `404`, like every other opt-in capability.
 *
 * Gated on webhooks alone and **not** on `GUBBINS_BRIDGE_ALLOW_WRITES` — a test fire mutates no
 * inventory. It is, however, a request-forgery primitive held back only by the bearer token, which
 * is exactly why {@link deliver} must run the real deliverer (and therefore the real SSRF guard)
 * rather than issuing a request of its own.
 */
export interface WebhookTestCapability {
  /**
   * The named bridge-side secrets a subscription's `secret_ref` resolves against. Held here so the
   * endpoint resolves a target through the same shared mapping the delivery path uses; the values
   * themselves never leave the bridge.
   */
  readonly secrets: WebhookSecrets;
  /**
   * Deliver one event to exactly one target through the real delivery path, resolving **after** the
   * delivery has finished (delivery is otherwise fire-and-forget). Returns the delivery-log record
   * that was written, or `null` when the matcher excluded the event and nothing was sent.
   */
  readonly deliver: (
    target: WebhookDeliveryTarget,
    event: BridgeEvent,
    driver: IDatabaseDriver,
  ) => Promise<WebhookDeliveryRecord | null>;
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
  /**
   * Returns the current state, or null before the first snapshot has loaded (the server
   * then answers 503 rather than serving from a half-loaded DB).
   */
  readonly getState: () => BridgeServerState | null;
  /**
   * Reload health for `/health` (issue #312). A failed re-hydrate keeps the last good snapshot
   * live, so without this the bridge answers from data it knows is out of date while still
   * reporting `ok: true`. Omit and `/health` reports a never-failed snapshot — the shape stays
   * the same, so a consumer can always read the same fields.
   */
  readonly getSnapshotHealth?: () => SnapshotHealthReport;
  /**
   * This bridge's stable identity, reported by `/health` (issue #672). Omit and `/health` reports
   * `bridgeId: null` — the shape stays the same, so a consumer always reads the same fields. It is
   * an identifier, not a credential: see `bridge-id.ts`.
   */
  readonly bridgeId?: string;
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
  /**
   * The opt-in webhook delivery log (`GUBBINS_BRIDGE_WEBHOOKS=on`), served at
   * `GET /api/v1/webhooks/deliveries`. Omit to keep that path a `404`. The bridge cannot write
   * delivery outcomes back into the swapped-per-hydration snapshot, so this in-memory log read
   * over HTTP is the only way the app can see what its subscriptions did (webhooks plan §3.1).
   */
  readonly webhookDeliveries?: WebhookDeliveryLog;
  /**
   * The opt-in webhook test-fire capability (`GUBBINS_BRIDGE_WEBHOOKS=on`), served at
   * `POST /api/v1/webhooks/test`. Omit to keep that path a `404`.
   */
  readonly webhookTest?: WebhookTestCapability;
  /**
   * The CORS origin allow-list (issue #182): which browser origins may read a response.
   * Omit to keep the permissive wildcard (`Access-Control-Allow-Origin: *`) — the default for the
   * in-process test harness and any caller that has not opted into the allow-list. The real server
   * passes the resolved `GUBBINS_BRIDGE_ALLOWED_ORIGINS` policy, whose secure default is the hosted
   * app origin plus loopback (see `cors.ts`).
   */
  readonly allowedOrigins?: AllowedOrigins;
  /**
   * Internal hook, wired by {@link createBridgeServer}: invoked with a browser `Origin` the
   * allow-list refuses, so the operator gets a one-line hint to add it. Deduped and capped by the
   * factory; omit (the default in direct-`handleRequest` tests) to log nothing.
   */
  readonly onRefusedOrigin?: (origin: string) => void;
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
  // One-line, once-per-origin hint when the CORS allow-list refuses a browser request, so an
  // operator whose app is served from an origin they have not listed can tell *why* their "push to
  // bridge" fails silently rather than staring at an opaque browser error. Deduped by origin and
  // hard-capped so a hostile client spraying forged `Origin` headers cannot grow the set or the log.
  const warnedOrigins = new Set<string>();
  const onRefusedOrigin =
    options.onRefusedOrigin ??
    ((origin: string): void => {
      // Dedupe on the raw value (so a hostile spray of variants still can't exceed the cap), but log
      // a sanitised form: the `Origin` is attacker-controlled, so strip anything non-printable and
      // truncate to keep control characters / newlines out of the logs (no log forging).
      if (warnedOrigins.has(origin) || warnedOrigins.size >= MAX_WARNED_ORIGINS) return;
      warnedOrigins.add(origin);
      const safe = origin.replace(/[^\x21-\x7e]/g, '?').slice(0, 128);
      console.warn(
        `Bridge refused a cross-origin browser request from ${safe}. If this is your Gubbins ` +
          'app, add its origin to GUBBINS_BRIDGE_ALLOWED_ORIGINS (comma-separated) and restart.',
      );
    });
  const resolved: BridgeServerOptions = { ...options, onRefusedOrigin };
  const server = createHttpServer((req, res) => {
    void handleRequest(req, res, resolved);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

/** Cap on distinct refused origins we log, so a spray of forged `Origin` headers can't grow it. */
const MAX_WARNED_ORIGINS = 100;

/**
 * Read the optional `Idempotency-Key` request header: the key when one was sent and is
 * well-formed, `undefined` when none was sent, and `null` when what arrived is not a usable key.
 *
 * A malformed key is a `400` rather than being ignored, because ignoring it would leave the
 * caller believing its retry was protected when it was not — the one failure mode this feature
 * exists to prevent. Node joins repeated headers with a comma, which the key charset rejects, so
 * two conflicting keys are refused too.
 */
function readIdempotencyKey(raw: string | string[] | undefined): string | undefined | null {
  if (raw === undefined) return undefined;
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return isValidIdempotencyKey(trimmed) ? trimmed : null;
}

/**
 * Add one header name to `Access-Control-Expose-Headers`, keeping whatever is already listed.
 *
 * A cross-origin browser can only read the CORS-safelisted response headers unless the server
 * names the others here — so every custom header the bridge sets has to be added. Appending
 * (rather than setting) matters because they are stamped at different points in the request: the
 * OData version before the auth gate, the staleness marker and the idempotency-replay marker
 * after it, and a plain `setHeader` from a later one would silently drop the earlier.
 */
function exposeHeader(res: ServerResponse, name: string): void {
  const existing = res.getHeader('Access-Control-Expose-Headers');
  const listed = typeof existing === 'string' && existing.length > 0 ? existing.split(', ') : [];
  if (listed.includes(name)) return;
  res.setHeader('Access-Control-Expose-Headers', [...listed, name].join(', '));
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
  // Allow GET and HEAD everywhere; POST only for the versioned write/ingest endpoints (and only
  // when one of those opt-ins is enabled). Anything else is a 405.
  const allow =
    options.write || options.push || options.webhookTest ? 'GET, HEAD, POST, OPTIONS' : 'GET, HEAD, OPTIONS';

  // A HEAD is a GET whose content is withheld (RFC 9110 §9.3.2), so it takes the GET path
  // wholesale — same auth, same permissions, same handler — and `suppressResponseBody` turns
  // whatever that path writes into headers-only, keeping `Content-Length` accurate. Installed
  // before any guard can answer, so a bodyless `401`/`405`/`503` is bodyless too. `routedMethod`
  // is what everything downstream sees, which is what makes the two responses identical by
  // construction rather than by two code paths agreeing (issue #360).
  const isHead = req.method === 'HEAD';
  if (isHead) suppressResponseBody(res);
  const routedMethod = isHead ? 'GET' : (req.method ?? '');

  // OData Protocol §8.1.5 requires every response from an OData service to carry `OData-Version`,
  // and a client that doesn't see it treats the endpoint as not being an OData service at all.
  // Stamped once, for the whole sub-tree, *before* any guard can answer — so the `401`, `403`,
  // `429` and `503` that never reach a handler are as conformant as a routed read, by
  // construction rather than by every send site remembering (issue #361). Exposed to CORS for the
  // same reason the staleness marker below is: a cross-origin browser client cannot read a
  // response header it was not granted, so to one of those the header may as well not exist.
  if (isODataPath(url.pathname)) {
    res.setHeader('OData-Version', ODATA_VERSION);
    exposeHeader(res, 'OData-Version');
  }

  // CORS: the bridge authenticates with a bearer token (never a cookie), so the token itself
  // — not the browser's same-origin policy — is the security boundary, and letting the PWA (almost
  // always a *different* origin: a dev server, the GitHub-Pages build, etc.) call the bridge from
  // the browser — in particular the "push to bridge" POST, whose preflight this answers — is a
  // feature. But a blanket `*` also handed any web page the victim was viewing a scripting position
  // against a LAN bridge it could not otherwise route to (issue #182), so instead of `*` the bridge
  // reflects an allow-list: the hosted app origin plus loopback by default, extendable via
  // `GUBBINS_BRIDGE_ALLOWED_ORIGINS`. A granted origin is reflected on *every* response (including
  // errors) so the app can read error bodies; an ungranted browser origin gets no header at all —
  // every response reads as an opaque failure, so a hostile page can't tell a good token from a bad
  // one. A non-browser client sends no `Origin` and is unaffected. `Vary: Origin` because the
  // response now depends on the request's `Origin` (belt-and-braces beside the blanket `no-store`).
  const allowedOrigins = options.allowedOrigins ?? WILDCARD_ORIGINS;
  const corsOrigin = corsAllowOrigin(req.headers.origin, allowedOrigins);
  if (corsOrigin !== null) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    if (corsOrigin !== '*') res.setHeader('Vary', 'Origin');
  } else if (req.headers.origin !== undefined) {
    // A browser cross-origin request the allow-list won't grant — nudge the operator (once) so a
    // legitimately-served app that just isn't listed yet is easy to diagnose.
    options.onRefusedOrigin?.(req.headers.origin);
  }

  // A CORS preflight is a plain capability check the browser makes before the real request; it
  // carries no Authorization header (browsers deliberately omit it on preflights), so it must be
  // answered before the auth/rate-limit guards below, and never counted against the rate limit.
  if (req.method === 'OPTIONS') {
    req.resume();
    res.writeHead(204, {
      'access-control-allow-methods': allow,
      // `Idempotency-Key` is listed so a browser-side caller (the PWA, or a dashboard card) can
      // make its retries safe the same way the Home Assistant integration does — an unlisted
      // header is stripped by the browser rather than refused, so the key would silently vanish.
      'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
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

    if (routedMethod !== 'GET' && routedMethod !== 'POST') {
      req.resume();
      sendError(res, 405, 'method_not_allowed', 'Method not allowed', { v1, headers: { allow } });
      return;
    }

    // --- Identify the caller (issue #79, plan §1.3) ------------------------------------
    //
    // A token is per-user now, and the rows that resolve one arrive in the snapshot — so
    // unlike the old shared-token check this cannot be answered before the first snapshot has
    // loaded. A `503` there is the fail-closed answer: the bridge does not yet know who anyone
    // is, so it lets nobody in. (This is why the scale reads, which need no snapshot of their
    // own, nonetheless wait for one.)
    const presented = presentedToken(req, url);
    const authState = options.getState();
    if (authState === null) {
      req.resume();
      sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1 });
      return;
    }
    const identity = presented === null ? null : await resolveIdentity(authState.driver, presented);
    if (identity === null) {
      req.resume();
      sendError(res, 401, 'unauthorized', 'Unauthorised', {
        v1,
        headers: { 'www-authenticate': 'Bearer' },
      });
      return;
    }
    // Authenticated but not permitted: the token is real and its owner is known, their role
    // simply does not reach this route. The env capability flags are a separate, outer bound —
    // a route the operator disabled is still a 404 for everyone, however permissive the role.
    if (!isPermitted(identity, routedMethod, url.pathname)) {
      req.resume();
      sendError(res, 403, 'forbidden', 'Forbidden', { v1 });
      return;
    }

    // Snapshot-staleness marker on every authenticated read/write response (issue #394). `/health`
    // already carries the full reload tally, but a consumer of `/search`, `/where`, `/metrics` or
    // any `/api/v1` read otherwise learns nothing about staleness without separately polling
    // `/health` — so the same verdict is stamped once here, covering every read at a single point.
    // It is the boolean form of `/health`'s `snapshotStale`; a client wanting the counters still
    // reads `/health`. Set only *after* the auth + permission gates (so it never discloses to an
    // unauthenticated caller) and only when a reload-health accessor is wired, so its presence is
    // itself the signal that the bridge reports this at all. Because the value is a custom header,
    // it is also named in `Access-Control-Expose-Headers` — without that a cross-origin browser
    // (the PWA is almost always a different origin) is not allowed to read it back off the response.
    const staleHeaderHealth = options.getSnapshotHealth?.();
    if (staleHeaderHealth !== undefined) {
      res.setHeader('X-Gubbins-Snapshot-Stale', staleHeaderHealth.snapshotStale ? 'true' : 'false');
      exposeHeader(res, 'X-Gubbins-Snapshot-Stale');
    }

    if (routedMethod === 'POST') {
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
      // The write endpoints accept an optional idempotency key so a caller whose request timed
      // out can retry without double-applying a relative change (issue #567). Read after the
      // ingest branch above, which takes no key: a pushed snapshot replaces state rather than
      // moving it by a delta, so re-sending one converges on its own.
      const idempotencyKey = readIdempotencyKey(req.headers['idempotency-key']);
      if (idempotencyKey === null) {
        req.resume();
        sendError(
          res,
          400,
          'bad_request',
          `"Idempotency-Key" must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters of ` +
            'letters, digits or ".-_:+=/".',
          { v1: true },
        );
        return;
      }
      // Advertise the outcome header to a browser caller; without this the fetch response hides
      // it, and a page could not tell a fresh write from a replay.
      if (idempotencyKey !== undefined) exposeHeader(res, 'Idempotency-Replayed');
      const body = await readJsonBody(req, MAX_BODY_BYTES);
      await handleApiV1(res, url, {
        method: 'POST',
        actorUserId: identity.userId,
        idempotencyKey,
        getState: options.getState,
        getSnapshotHealth: options.getSnapshotHealth,
        bridgeId: options.bridgeId,
        write: options.write,
        push: options.push,
        streamable: options.events !== undefined,
        scale: options.scale,
        webhookDeliveries: options.webhookDeliveries,
        webhookTest: options.webhookTest,
        body,
      });
      return;
    }

    // GET/HEAD: no body to consume — drain anything sent so the socket closes cleanly.
    req.resume();

    // The SSE event stream is a long-lived response that needs the raw request (socket + close
    // events), so it is handled here rather than through the res-only v1 router. When events are
    // not enabled this falls through and the router answers 404 (the feature is invisible).
    if (options.events && url.pathname === API_V1_EVENTS_PATH) {
      // The one read a HEAD cannot simply borrow: opening the stream would register a client and
      // hold the response open forever, so the probe is answered directly — the media type the
      // stream serves, and nothing else. No `Content-Length`, because the content is unbounded
      // (RFC 9110 §9.3.2 excuses a header knowable only while generating it), and no `429` when the
      // hub is at capacity: a probe takes no slot, so it reports the endpoint, not the queue.
      if (isHead) {
        res.writeHead(200, { 'content-type': EVENT_STREAM_CONTENT_TYPE, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      options.events.handleConnection(req, res, url);
      return;
    }

    // The live scale stream is the same shape of long-lived response and, like the event stream,
    // needs the raw request — so it is handled here too rather than through the res-only router.
    // When Home Assistant reads are not enabled this falls through and the router answers 404.
    if (options.scale?.stream && url.pathname === API_V1_SCALE_STREAM_PATH) {
      // A HEAD is answered directly for the same reason the event stream's is: opening a stream
      // would take a client slot and hold the response open, so the probe reports the media type
      // the endpoint serves and nothing else. No `entity_id` is required or read here — a probe
      // asks whether the endpoint exists, not whether one particular sensor can be watched.
      if (isHead) {
        res.writeHead(200, { 'content-type': SCALE_STREAM_CONTENT_TYPE, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      await options.scale.stream.handleConnection(req, res, url);
      return;
    }

    // The polled subscription feeds (calendar, syndication, metrics) answer conditionally, so
    // every GET carries whatever validators the client cached — see `api/conditional.ts`.
    const conditional = readConditionalHeaders(req.headers);

    if (v1) {
      await handleApiV1(res, url, {
        method: 'GET',
        getState: options.getState,
        getSnapshotHealth: options.getSnapshotHealth,
        bridgeId: options.bridgeId,
        write: options.write,
        push: options.push,
        streamable: options.events !== undefined,
        scale: options.scale,
        lookup: options.lookup,
        webhookDeliveries: options.webhookDeliveries,
        conditional,
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
        await handleMetrics(res, options, conditional);
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
 * merges it into the served snapshot (see `push.ts`), writing the result atomically; the watcher
 * re-hydrates it. A `404`
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
  sendJson(
    res,
    200,
    healthBody(state.snapshotGeneratedAt, itemCount, options.getSnapshotHealth?.(), options.bridgeId),
  );
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
 *
 * The exposition is a pure projection of the snapshot, so it is answered conditionally like the
 * feeds (issue #363): a client that revalidates gets a `304` and the vault scan is skipped. A
 * Prometheus scrape sends no conditional header and is unaffected.
 */
async function handleMetrics(
  res: ServerResponse,
  options: BridgeServerOptions,
  conditional: ConditionalHeaders | undefined,
): Promise<void> {
  const state = options.getState();
  if (state === null) {
    sendError(res, 503, 'snapshot_unavailable', 'Snapshot not loaded yet', { v1: false });
    return;
  }
  const snapshotMs = snapshotInstant(state.snapshotGeneratedAt);
  const validators = snapshotMs === null ? undefined : cacheValidators(snapshotMs, 'metrics');
  if (validators !== undefined && isNotModified(conditional, validators)) {
    sendNotModified(res, validators);
    return;
  }
  sendMetrics(res, 200, formatMetrics(await projectMetrics(state.driver)), validators);
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
 * Extract the token a request presents, or `null` when it presents none.
 *
 * It normally arrives as an `Authorization: Bearer …` header. On the read-only subscription
 * paths (the calendar feed `GET /api/v1/calendar.ics` and the syndication feeds
 * `GET /api/v1/activity.{rss,atom,json}`) it may instead be supplied as a `?token=` query
 * parameter, because a calendar / feed client subscribing by URL cannot send an auth header.
 * That weaker token-in-URL posture (URLs get logged by proxies / browser history) is deliberately
 * scoped to just those read-only feed paths (see `pathAllowsUrlToken`); everything else —
 * including `/metrics` — requires the header.
 *
 * There is no constant-time compare here any more, and none is needed: the presented value is
 * not compared against a secret, it is hashed and looked up by index (see `identity.ts`). A hash
 * lookup reveals nothing about the stored value through timing, and the old shared-token compare
 * — the thing the constant-time guard protected — no longer exists.
 */
function presentedToken(req: IncomingMessage, url: URL): string | null {
  const header = req.headers.authorization;
  const prefix = 'Bearer ';
  if (typeof header === 'string' && header.startsWith(prefix)) {
    const value = header.slice(prefix.length).trim();
    if (value.length > 0) return value;
  }
  if (pathAllowsUrlToken(url.pathname)) {
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null && queryToken.length > 0) return queryToken;
  }
  return null;
}
