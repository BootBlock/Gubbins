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
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import {
  bridgeReducer,
  initialBridgeState,
  pendingScrapeCount,
  type ScrapeRequestState,
} from './bridge-reducer';
import { makeMessage, parseExtensionMessage } from './protocol';

interface ScrapeBridgeValue {
  readonly ready: boolean;
  /** Tracked scrapes keyed by `requestId` — several may be in flight at once (§9). */
  readonly requests: Readonly<Record<string, ScrapeRequestState>>;
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
}

const ScrapeBridgeContext = createContext<ScrapeBridgeValue | null>(null);

export function ScrapeBridgeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(bridgeReducer, initialBridgeState);

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
        // SCRAPE_REQUEST is outbound-only from the PWA — ignore our own echo.
      }
    };

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

  const value = useMemo<ScrapeBridgeValue>(
    () => ({
      ready: state.ready,
      requests: state.requests,
      pendingCount: pendingScrapeCount(state),
      requestScrape,
      clear,
    }),
    [state, requestScrape, clear],
  );

  return <ScrapeBridgeContext.Provider value={value}>{children}</ScrapeBridgeContext.Provider>;
}

export function useScrapeBridge(): ScrapeBridgeValue {
  const value = useContext(ScrapeBridgeContext);
  if (!value) throw new Error('useScrapeBridge must be used within a ScrapeBridgeProvider.');
  return value;
}
