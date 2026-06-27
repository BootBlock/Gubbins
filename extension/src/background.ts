/**
 * Background service worker (spec §9.3) — the CORS-bypassing fetcher.
 *
 * The content script cannot reliably fetch a third-party supplier page from the
 * PWA's origin (CORS), so it delegates the network request here. With the manifest's
 * host permissions, the background worker fetches the raw HTML and returns the text
 * for the content script to parse with the shared Strategy parsers. Transport-level
 * failures are mapped to the §9.4.2 error taxonomy (`RATE_LIMITED`/`NETWORK_TIMEOUT`).
 *
 * Note: MV3 service workers have no DOM, so parsing happens in the content script
 * (which does) — keeping this worker tiny and dependency-free.
 */
import type { ScrapeErrorType } from '../../src/features/scraping/parsers/types';

interface FetchRequest {
  kind: 'FETCH';
  url: string;
}

type FetchResponse =
  | { ok: true; text: string }
  | { ok: false; errorType: ScrapeErrorType; reason: string };

const FETCH_TIMEOUT_MS = 15000;

declare const chrome: {
  runtime: {
    onMessage: {
      addListener: (
        cb: (message: unknown, sender: unknown, sendResponse: (r: FetchResponse) => void) => boolean | void,
      ) => void;
    };
  };
};

async function fetchPage(url: string): Promise<FetchResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    if (res.status === 429) return { ok: false, errorType: 'RATE_LIMITED', reason: 'Supplier returned HTTP 429 (rate limited).' };
    if (!res.ok) return { ok: false, errorType: 'NETWORK_TIMEOUT', reason: `Supplier returned HTTP ${res.status}.` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return {
      ok: false,
      errorType: 'NETWORK_TIMEOUT',
      reason: aborted ? 'Request timed out.' : `Network error: ${String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const req = message as Partial<FetchRequest> | null;
  if (req?.kind === 'FETCH' && typeof req.url === 'string') {
    void fetchPage(req.url).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  return false;
});
