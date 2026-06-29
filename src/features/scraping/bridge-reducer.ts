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
import type { ScrapeErrorPayload, ScrapeResultPayload } from './protocol';

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

export interface BridgeState {
  /** True once an EXTENSION_READY has been received — gates the "Scrape" button (§9.3). */
  readonly ready: boolean;
  /** In-flight and recently-finished scrapes, keyed by `requestId`. */
  readonly requests: Readonly<Record<string, ScrapeRequestState>>;
}

export const initialBridgeState: BridgeState = {
  ready: false,
  requests: {},
};

export type BridgeAction =
  | { type: 'READY' }
  | { type: 'REQUEST'; id: string; url: string }
  | { type: 'RESULT'; id: string; payload: ScrapeResultPayload }
  | { type: 'ERROR'; id: string; payload: ScrapeErrorPayload }
  | { type: 'CLEAR'; id: string };

/** Resolve a finished outcome onto the tracked request, or ignore an unknown/stale id. */
function settle(
  state: BridgeState,
  id: string,
  patch: Pick<ScrapeRequestState, 'status' | 'result' | 'error'>,
): BridgeState {
  const current = state.requests[id];
  // Only a scrape we are actively awaiting may transition — a result for an unknown,
  // already-settled or already-cleared id is a stale/foreign echo and is dropped.
  if (!current || current.status !== 'SCRAPING') return state;
  return { ...state, requests: { ...state.requests, [id]: { ...current, ...patch } } };
}

export function bridgeReducer(state: BridgeState, action: BridgeAction): BridgeState {
  switch (action.type) {
    case 'READY':
      // Idempotent: a re-broadcast just confirms readiness, never disturbs a scrape.
      return state.ready ? state : { ...state, ready: true };
    case 'REQUEST':
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.id]: { id: action.id, url: action.url, status: 'SCRAPING', result: null, error: null },
        },
      };
    case 'RESULT':
      return settle(state, action.id, { status: 'SUCCESS', result: action.payload, error: null });
    case 'ERROR':
      return settle(state, action.id, { status: 'ERROR', result: null, error: action.payload });
    case 'CLEAR': {
      if (!(action.id in state.requests)) return state;
      const next = { ...state.requests };
      delete next[action.id];
      return { ...state, requests: next };
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
