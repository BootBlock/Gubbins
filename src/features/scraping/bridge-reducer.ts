/**
 * Pure state machine for the §9 extension bridge (spec §9.3 execution flow).
 *
 * Split out from the React context (mirroring the scanner queue's pure reducer) so
 * the EXTENSION_READY gating and the in-flight scrape lifecycle are unit-tested
 * without a DOM or `postMessage`. The context only translates validated messages
 * (already vetted by {@link parseExtensionMessage}) into these actions.
 *
 * **Concurrency (§9 multi-scrape).** Scrapes are tracked in a map keyed by the
 * `requestId` stamped on the originating `SCRAPE_REQUEST`, so several can be in flight
 * at once and each `SCRAPE_RESULT`/`SCRAPE_ERROR` is routed to the request that started
 * it. A result/error whose id is unknown (stale, already-cleared, or never-requested)
 * is ignored — cross-talk between concurrent scrapes is structurally impossible.
 */
import type { ProductLookupResultPayload, ScrapeErrorPayload, ScrapeResultPayload } from './protocol';

/** Lifecycle of a single tracked scrape. */
export type ScrapeRequestStatus = 'SCRAPING' | 'SUCCESS' | 'ERROR';

/** One correlated scrape — its id, the URL it targets, and its current outcome. */
export interface ScrapeRequestState {
  readonly id: string;
  readonly url: string;
  readonly status: ScrapeRequestStatus;
  readonly result: ScrapeResultPayload | null;
  readonly error: ScrapeErrorPayload | null;
}

/**
 * An **unsolicited** active-tab scrape delivered by the extension (Path A2). Unlike a
 * scrape or lookup, the PWA never requested it — the user triggered it from the browser
 * chrome while on their Amazon tab — so it arrives already settled (a SUCCESS payload or a
 * typed error), keyed by the extension's correlation id purely to dedupe re-delivery.
 */
export interface IncomingScrapeState {
  readonly id: string;
  readonly status: 'SUCCESS' | 'ERROR';
  readonly result: ScrapeResultPayload | null;
  readonly error: ScrapeErrorPayload | null;
}

/** Lifecycle of a single tracked product lookup (recommendation point 2). */
export type ProductLookupStatus = 'LOOKING_UP' | 'SUCCESS' | 'ERROR';

/** One correlated barcode lookup — its id, the GTIN it targets, and its current outcome. */
export interface ProductLookupState {
  readonly id: string;
  readonly gtin: string;
  readonly status: ProductLookupStatus;
  readonly result: ProductLookupResultPayload | null;
  readonly error: ScrapeErrorPayload | null;
}

/**
 * What the extension told us about itself in its `EXTENSION_READY` (issue #664).
 *
 * Kept so a capability can be gated on the generation the peer actually speaks rather than on
 * "a peer exists", and so a support report has something to name — otherwise "the lookup button
 * does nothing" has no way to reach its cause.
 */
export interface BridgePeer {
  /** The extension's own build version, when it announced one (diagnostics only). */
  readonly version: string | null;
  /** The wire generation it speaks — see `PROTOCOL_VERSION`. Never null: a silent hello is assumed. */
  readonly protocol: number;
}

export interface BridgeState {
  /** True once an EXTENSION_READY has been received — gates the bridge affordances (§9.3). */
  readonly ready: boolean;
  /** The announcing peer, or null while none has announced itself. */
  readonly peer: BridgePeer | null;
  /** In-flight and recently-finished scrapes, keyed by `requestId`. */
  readonly requests: Readonly<Record<string, ScrapeRequestState>>;
  /** In-flight and recently-finished product lookups, keyed by `requestId` (point 2). */
  readonly lookups: Readonly<Record<string, ProductLookupState>>;
  /** Unsolicited active-tab scrapes pushed by the extension (Path A2), keyed by id. */
  readonly incoming: Readonly<Record<string, IncomingScrapeState>>;
}

export const initialBridgeState: BridgeState = {
  ready: false,
  peer: null,
  requests: {},
  lookups: {},
  incoming: {},
};

export type BridgeAction =
  | { type: 'READY'; peer: BridgePeer }
  | { type: 'REQUEST'; id: string; url: string }
  | { type: 'RESULT'; id: string; payload: ScrapeResultPayload }
  | { type: 'ERROR'; id: string; payload: ScrapeErrorPayload }
  | { type: 'CLEAR'; id: string }
  | { type: 'LOOKUP_REQUEST'; id: string; gtin: string }
  | { type: 'LOOKUP_RESULT'; id: string; payload: ProductLookupResultPayload }
  | { type: 'LOOKUP_ERROR'; id: string; payload: ScrapeErrorPayload }
  | { type: 'LOOKUP_CLEAR'; id: string }
  | { type: 'INCOMING_RESULT'; id: string; payload: ScrapeResultPayload }
  | { type: 'INCOMING_ERROR'; id: string; payload: ScrapeErrorPayload }
  | { type: 'INCOMING_CLEAR'; id: string };

/**
 * Resolve a finished outcome onto a tracked request in a keyed map, or ignore an
 * unknown/stale id. Only a request still in its `pending` status may transition — a
 * result for an unknown, already-settled or already-cleared id is a stale/foreign echo
 * and is dropped. Shared by scrapes and lookups so the correlation rule lives in one place.
 */
function settle<S extends { readonly status: string }>(
  map: Readonly<Record<string, S>>,
  id: string,
  pending: string,
  patch: Partial<S>,
): Readonly<Record<string, S>> {
  const current = map[id];
  if (!current || current.status !== pending) return map;
  return { ...map, [id]: { ...current, ...patch } };
}

/** Remove a key from a map, returning the same reference when the key is absent. */
function drop<S>(map: Readonly<Record<string, S>>, id: string): Readonly<Record<string, S>> {
  if (!(id in map)) return map;
  const next = { ...map };
  delete next[id];
  return next;
}

/** Reseat the scrapes map, preserving the state's identity when it did not change. */
function withRequests(state: BridgeState, requests: BridgeState['requests']): BridgeState {
  return requests === state.requests ? state : { ...state, requests };
}

/** Reseat the lookups map, preserving the state's identity when it did not change. */
function withLookups(state: BridgeState, lookups: BridgeState['lookups']): BridgeState {
  return lookups === state.lookups ? state : { ...state, lookups };
}

/**
 * Insert an already-settled incoming active-tab scrape, ignoring a **re-delivered** id.
 * The extension may push the same payload to more than one open PWA tab (or re-push after
 * a `PWA_READY` handshake), so a first-write-wins insert keeps a single review prompt per
 * scrape rather than stacking duplicates.
 */
function addIncoming(state: BridgeState, id: string, entry: IncomingScrapeState): BridgeState {
  if (id in state.incoming) return state;
  return { ...state, incoming: { ...state.incoming, [id]: entry } };
}

export function bridgeReducer(state: BridgeState, action: BridgeAction): BridgeState {
  switch (action.type) {
    case 'READY': {
      // The content script announces itself several times over (§9.3), so a re-broadcast must
      // never disturb a request — but it may still *correct* what we know about the peer, which
      // matters when the user reloads a rebuilt extension into a live tab. Identity is preserved
      // when nothing actually changed, so the common repeat costs no re-render.
      const same =
        state.ready &&
        state.peer !== null &&
        state.peer.protocol === action.peer.protocol &&
        state.peer.version === action.peer.version;
      return same ? state : { ...state, ready: true, peer: action.peer };
    }
    case 'REQUEST':
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.id]: { id: action.id, url: action.url, status: 'SCRAPING', result: null, error: null },
        },
      };
    case 'RESULT':
      return withRequests(
        state,
        settle(state.requests, action.id, 'SCRAPING', {
          status: 'SUCCESS',
          result: action.payload,
          error: null,
        }),
      );
    case 'ERROR':
      return withRequests(
        state,
        settle(state.requests, action.id, 'SCRAPING', {
          status: 'ERROR',
          result: null,
          error: action.payload,
        }),
      );
    case 'CLEAR':
      return withRequests(state, drop(state.requests, action.id));
    case 'LOOKUP_REQUEST':
      return {
        ...state,
        lookups: {
          ...state.lookups,
          [action.id]: { id: action.id, gtin: action.gtin, status: 'LOOKING_UP', result: null, error: null },
        },
      };
    case 'LOOKUP_RESULT':
      return withLookups(
        state,
        settle(state.lookups, action.id, 'LOOKING_UP', {
          status: 'SUCCESS',
          result: action.payload,
          error: null,
        }),
      );
    case 'LOOKUP_ERROR':
      return withLookups(
        state,
        settle(state.lookups, action.id, 'LOOKING_UP', {
          status: 'ERROR',
          result: null,
          error: action.payload,
        }),
      );
    case 'LOOKUP_CLEAR':
      return withLookups(state, drop(state.lookups, action.id));
    case 'INCOMING_RESULT':
      return addIncoming(state, action.id, {
        id: action.id,
        status: 'SUCCESS',
        result: action.payload,
        error: null,
      });
    case 'INCOMING_ERROR':
      return addIncoming(state, action.id, {
        id: action.id,
        status: 'ERROR',
        result: null,
        error: action.payload,
      });
    case 'INCOMING_CLEAR': {
      const incoming = drop(state.incoming, action.id);
      return incoming === state.incoming ? state : { ...state, incoming };
    }
    default:
      return state;
  }
}

/** Count of scrapes still awaiting an outcome (for UI "N scraping…" affordances). */
export function pendingScrapeCount(state: BridgeState): number {
  let n = 0;
  for (const id in state.requests) if (state.requests[id]!.status === 'SCRAPING') n += 1;
  return n;
}
