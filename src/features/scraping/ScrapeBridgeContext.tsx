/**
 * Tier-3 PWA↔extension bridge (spec §2.1, §9.1–§9.3).
 *
 * Wires the secure `window.postMessage` bridge: every inbound message is funnelled
 * through the pure {@link parseExtensionMessage} (origin-verified, signature-checked,
 * schema-validated; invalid ⇒ silently dropped) and translated into actions for the
 * pure {@link bridgeReducer}. The provider is mounted once near the app root so the
 * EXTENSION_READY gate (`ready`) is known app-wide; the in-flight scrape lives here
 * too (only one scrape modal is open at a time), mirroring `ScannerQueueProvider`.
 *
 * The PWA must **feature-detect** the extension and degrade gracefully when absent
 * (§9.3) — until a trusted EXTENSION_READY arrives, `ready` stays false and the UI
 * never offers the Scrape button.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  bridgeReducer,
  initialBridgeState,
  pendingScrapeCount,
  type IncomingScrapeState,
  type ProductLookupState,
  type ScrapeRequestState,
} from './bridge-reducer';
import { makeMessage, parseExtensionMessage, type ScrapeErrorPayload } from './protocol';

interface ScrapeBridgeValue {
  readonly ready: boolean;
  /** Tracked scrapes keyed by `requestId` — several may be in flight at once (§9). */
  readonly requests: Readonly<Record<string, ScrapeRequestState>>;
  /** Tracked barcode product lookups keyed by `requestId` (recommendation point 2). */
  readonly lookups: Readonly<Record<string, ProductLookupState>>;
  /** Unsolicited active-tab scrapes pushed by the extension (Path A2), keyed by id. */
  readonly incoming: Readonly<Record<string, IncomingScrapeState>>;
  /** Number of scrapes still awaiting an outcome (for UI affordances). */
  readonly pendingCount: number;
  /**
   * Send a SCRAPE_REQUEST for a supplier URL across the bridge (§9.3). Returns the
   * generated `requestId` so the caller can track its own scrape among any concurrent
   * ones via {@link requests}.
   */
  readonly requestScrape: (url: string) => string;
  /** Drop a single finished (or abandoned) scrape by id. */
  readonly clear: (id: string) => void;
  /**
   * Send a PRODUCT_LOOKUP_REQUEST for a retail barcode (GTIN) across the bridge (point 2).
   * Returns the generated `requestId` so the caller can track its own lookup via {@link lookups}.
   */
  readonly requestLookup: (gtin: string) => string;
  /** Drop a single finished (or abandoned) product lookup by id. */
  readonly clearLookup: (id: string) => void;
  /** Drop a single handled (or dismissed) active-tab scrape by id (Path A2). */
  readonly clearIncoming: (id: string) => void;
  /**
   * Ask the extension to fetch one open-database URL and return its **raw body** (issue #616).
   *
   * The one bridge call that resolves a **promise** rather than settling into
   * {@link BridgeState}, and deliberately so: its caller is the pure lookup runner, which
   * serialises and rate-limits requests through a promise chain and has no render state to watch.
   * Every other bridge outcome ends up in a dialog, so reducer state is the right shape there;
   * this one is consumed and discarded.
   *
   * Resolves `null` when nothing answered — the extension is absent, it is an older build with no
   * `DATA_FETCH_REQUEST` handler, or it did not reply within {@link DATA_FETCH_TIMEOUT_MS}. That
   * is a *failure*, not an invitation to fetch directly instead: a silent fallback would cross to
   * the network on a path the user has not consented to.
   */
  readonly fetchDataUrl: (url: string) => Promise<DataFetchOutcome | null>;
}

/** The extension's answer to a {@link ScrapeBridgeValue.fetchDataUrl}. */
export type DataFetchOutcome =
  { readonly ok: true; readonly body: string } | { readonly ok: false; readonly error: ScrapeErrorPayload };

/**
 * How long to wait for the extension's reply before giving up on it.
 *
 * The bridge is `postMessage`-based, so a content script that never answers (an old extension
 * build with no `DATA_FETCH_REQUEST` handler, a worker the browser evicted) would otherwise leave
 * the caller hanging with no way to tell that from a slow network.
 */
export const DATA_FETCH_TIMEOUT_MS = 20_000;

/** One outstanding {@link ScrapeBridgeValue.fetchDataUrl}, awaiting its correlated reply. */
interface PendingDataFetch {
  readonly url: string;
  readonly settle: (outcome: DataFetchOutcome | null) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const ScrapeBridgeContext = createContext<ScrapeBridgeValue | null>(null);

export function ScrapeBridgeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(bridgeReducer, initialBridgeState);
  // Held in a ref rather than in state: resolving a promise is not a render, and putting these in
  // the reducer would re-render every bridge consumer for an outcome nothing displays.
  const pendingDataFetches = useRef(new Map<string, PendingDataFetch>());

  // Settle every outstanding data fetch on unmount, so an awaiting caller can never be left
  // hanging on a promise whose listener has gone.
  useEffect(() => {
    const pending = pendingDataFetches.current;
    return () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.settle(null);
      }
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // A content script posts in the *page's* own origin, so we trust only ourselves.
    const trustedOrigins = [window.location.origin];

    const onMessage = (event: MessageEvent) => {
      const msg = parseExtensionMessage(event.data, { origin: event.origin, trustedOrigins });
      if (!msg) return; // §9.1: invalid/foreign message silently dropped
      switch (msg.type) {
        case 'EXTENSION_READY':
          dispatch({ type: 'READY' });
          break;
        case 'SCRAPE_RESULT':
          // Correlate by requestId — the reducer ignores a stale/foreign id (§9).
          dispatch({ type: 'RESULT', id: msg.requestId, payload: msg.payload });
          break;
        case 'SCRAPE_ERROR':
          dispatch({ type: 'ERROR', id: msg.requestId, payload: msg.payload });
          break;
        case 'PRODUCT_LOOKUP_RESULT':
          dispatch({ type: 'LOOKUP_RESULT', id: msg.requestId, payload: msg.payload });
          break;
        case 'PRODUCT_LOOKUP_ERROR':
          dispatch({ type: 'LOOKUP_ERROR', id: msg.requestId, payload: msg.payload });
          break;
        case 'ACTIVE_TAB_RESULT':
          // Unsolicited (Path A2): insert directly, deduped by the extension's id.
          dispatch({ type: 'INCOMING_RESULT', id: msg.requestId, payload: msg.payload });
          break;
        case 'ACTIVE_TAB_ERROR':
          dispatch({ type: 'INCOMING_ERROR', id: msg.requestId, payload: msg.payload });
          break;
        case 'DATA_FETCH_RESULT':
          // Correlated by id *and* by URL: a body fetched from a different URL is not an answer to
          // this request, whatever id it echoes, and handing it to the provider's parser would be
          // worse than failing. Failed rather than ignored — our own extension answering the wrong
          // URL is a fault, and leaving the caller to sit out the 20s timeout would hide it.
          settleDataFetch(msg.requestId, (entry) =>
            entry.url === msg.payload.url ? { ok: true, body: msg.payload.body } : null,
          );
          break;
        case 'DATA_FETCH_ERROR':
          settleDataFetch(msg.requestId, () => ({ ok: false, error: msg.payload }));
          break;
        // *_REQUEST kinds are outbound-only from the PWA — ignore our own echo.
      }
    };

    /** Resolve one outstanding data fetch, ignoring an unknown or already-settled id. */
    function settleDataFetch(
      id: string,
      outcome: (entry: PendingDataFetch) => DataFetchOutcome | null,
    ): void {
      const entry = pendingDataFetches.current.get(id);
      if (entry === undefined) return;
      pendingDataFetches.current.delete(id);
      clearTimeout(entry.timer);
      entry.settle(outcome(entry));
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const requestScrape = useCallback((url: string) => {
    const id = crypto.randomUUID();
    dispatch({ type: 'REQUEST', id, url });
    window.postMessage(makeMessage('SCRAPE_REQUEST', { url }, id), window.location.origin);
    return id;
  }, []);

  const clear = useCallback((id: string) => dispatch({ type: 'CLEAR', id }), []);

  const requestLookup = useCallback((gtin: string) => {
    const id = crypto.randomUUID();
    dispatch({ type: 'LOOKUP_REQUEST', id, gtin });
    window.postMessage(makeMessage('PRODUCT_LOOKUP_REQUEST', { gtin }, id), window.location.origin);
    return id;
  }, []);

  const clearLookup = useCallback((id: string) => dispatch({ type: 'LOOKUP_CLEAR', id }), []);

  const clearIncoming = useCallback((id: string) => dispatch({ type: 'INCOMING_CLEAR', id }), []);

  const fetchDataUrl = useCallback((url: string) => {
    return new Promise<DataFetchOutcome | null>((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingDataFetches.current.delete(id);
        resolve(null);
      }, DATA_FETCH_TIMEOUT_MS);
      pendingDataFetches.current.set(id, { url, settle: resolve, timer });
      window.postMessage(makeMessage('DATA_FETCH_REQUEST', { url }, id), window.location.origin);
    });
  }, []);

  const value = useMemo<ScrapeBridgeValue>(
    () => ({
      ready: state.ready,
      requests: state.requests,
      lookups: state.lookups,
      incoming: state.incoming,
      pendingCount: pendingScrapeCount(state),
      requestScrape,
      clear,
      requestLookup,
      clearLookup,
      clearIncoming,
      fetchDataUrl,
    }),
    [state, requestScrape, clear, requestLookup, clearLookup, clearIncoming, fetchDataUrl],
  );

  return <ScrapeBridgeContext.Provider value={value}>{children}</ScrapeBridgeContext.Provider>;
}

export function useScrapeBridge(): ScrapeBridgeValue {
  const value = useContext(ScrapeBridgeContext);
  if (!value) throw new Error('useScrapeBridge must be used within a ScrapeBridgeProvider.');
  return value;
}
