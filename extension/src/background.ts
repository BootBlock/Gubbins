/**
 * Background service worker (spec §9.3) — the CORS-bypassing fetcher.
 *
 * The content script cannot reliably fetch a third-party supplier page from the
 * PWA's origin (CORS), so it delegates the network request here. With the manifest's
 * host permissions, the background worker fetches the raw HTML and returns the text
 * for the content script to parse with the shared Strategy parsers. Transport-level
 * failures are mapped to the §9.4.2 error taxonomy via the shared, unit-tested pure
 * {@link classifyHttpStatus} (`RATE_LIMITED`/`BLOCKED`/`NOT_FOUND`/`SERVER_ERROR`); a
 * transport-level failure with no response stays `NETWORK_TIMEOUT`.
 *
 * Note: MV3 service workers have no DOM, so parsing happens in the content script
 * (which does) — keeping this worker tiny and dependency-free.
 */
import type { ScrapeErrorType } from '../../src/features/scraping/protocol';
import { classifyHttpStatus } from '../../src/features/scraping/scrape-errors';
import { isAllowedSupplierUrl } from '../../src/features/scraping/parsers/suppliers';

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
  // The privileged worker's own allowlist gate (§9 hardening): only ever fetch an https
  // URL on a registered supplier domain, so a page driving the bridge can't turn the
  // extension into a fetch proxy for an arbitrary origin. This is defence-in-depth above
  // the manifest's host_permissions; a rejected target is reported as a refusal (BLOCKED).
  if (!isAllowedSupplierUrl(url)) {
    return { ok: false, errorType: 'BLOCKED', reason: 'URL is not an allowed supplier domain.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    // A received HTTP status maps to a precise §9.4.2 failure (429/4xx/5xx); a usable
    // 2xx classifies as null and we read the body. Only a transport failure with no
    // response (the catch below) is a genuine NETWORK_TIMEOUT.
    const failure = classifyHttpStatus(res.status);
    if (failure) return { ok: false, errorType: failure.errorType, reason: failure.reason };
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
