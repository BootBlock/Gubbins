/**
 * Pure state machine for the §9 extension bridge (spec §9.3 execution flow).
 *
 * Split out from the React context (mirroring the scanner queue's pure reducer) so
 * the EXTENSION_READY gating and the in-flight SCRAPE_REQUEST → SCRAPE_RESULT/
 * SCRAPE_ERROR lifecycle are unit-tested without a DOM or `postMessage`. The context
 * only translates validated messages (already vetted by {@link parseExtensionMessage})
 * into these actions.
 */
import type { ScrapeErrorPayload, ScrapeResultPayload } from './protocol';

export type BridgeStatus = 'IDLE' | 'SCRAPING' | 'SUCCESS' | 'ERROR';

export interface BridgeState {
  /** True once an EXTENSION_READY has been received — gates the "Scrape" button (§9.3). */
  readonly ready: boolean;
  readonly status: BridgeStatus;
  readonly result: ScrapeResultPayload | null;
  readonly error: ScrapeErrorPayload | null;
}

export const initialBridgeState: BridgeState = {
  ready: false,
  status: 'IDLE',
  result: null,
  error: null,
};

export type BridgeAction =
  | { type: 'READY' }
  | { type: 'REQUEST' }
  | { type: 'RESULT'; payload: ScrapeResultPayload }
  | { type: 'ERROR'; payload: ScrapeErrorPayload }
  | { type: 'RESET' };

export function bridgeReducer(state: BridgeState, action: BridgeAction): BridgeState {
  switch (action.type) {
    case 'READY':
      // Idempotent: a re-broadcast just confirms readiness, never disturbs a scrape.
      return state.ready ? state : { ...state, ready: true };
    case 'REQUEST':
      return { ...state, status: 'SCRAPING', result: null, error: null };
    case 'RESULT':
      // Ignore a stray result that arrives when we are not awaiting one.
      if (state.status !== 'SCRAPING') return state;
      return { ...state, status: 'SUCCESS', result: action.payload, error: null };
    case 'ERROR':
      if (state.status !== 'SCRAPING') return state;
      return { ...state, status: 'ERROR', error: action.payload, result: null };
    case 'RESET':
      return { ...state, status: 'IDLE', result: null, error: null };
    default:
      return state;
  }
}
