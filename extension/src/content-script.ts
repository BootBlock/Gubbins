/**
 * Content script (spec §9.1–§9.4) — the page-side half of the secure bridge.
 *
 * Injected into the Gubbins PWA, it (1) broadcasts EXTENSION_READY so the PWA
 * unlocks the "Scrape Supplier" button (§9.3), and (2) services SCRAPE_REQUEST
 * messages: it asks the background worker to fetch the supplier HTML (bypassing
 * CORS), parses it here with the **shared, unit-tested Strategy parsers** (this
 * context has a DOM; the service worker does not), and posts back a strictly-typed
 * SCRAPE_RESULT or an explicit SCRAPE_ERROR (§9.4.2).
 *
 * Every inbound message is validated through the same {@link parseExtensionMessage}
 * the PWA uses — origin-verified, signature-checked, schema-valid — so a hostile
 * page script cannot drive the scraper.
 */
import {
  makeMessage,
  parseExtensionMessage,
  type ProductLookupRequestMessage,
  type ProductLookupResultPayload,
  type ScrapeRequestMessage,
} from '../../src/features/scraping/protocol';
import { runParser } from '../../src/features/scraping/parsers/registry';
import { detectChallengePage } from '../../src/features/scraping/scrape-errors';
import { OPEN_FOOD_FACTS_HOST } from '../../src/features/scraping/product-lookup';
import type { ScrapeErrorType } from '../../src/features/scraping/protocol';

const VERSION = '1.2.0';
const trustedOrigins = [window.location.origin];

type FetchReply = { ok: true; text: string } | { ok: false; errorType: ScrapeErrorType; reason: string };
type LookupReply =
  | { ok: true; product: ProductLookupResultPayload }
  | { ok: false; errorType: ScrapeErrorType; reason: string };

declare const chrome: {
  runtime: {
    sendMessage: <R>(message: unknown) => Promise<R>;
  };
};

function post(message: unknown): void {
  window.postMessage(message, window.location.origin);
}

function announce(): void {
  post(makeMessage('EXTENSION_READY', { version: VERSION }));
}

async function handleScrape(msg: ScrapeRequestMessage): Promise<void> {
  const { url } = msg.payload;
  // Echo the request's correlation id on every reply so the PWA routes the outcome to
  // the scrape that started it — several may be in flight at once (§9 multi-scrape).
  const { requestId } = msg;
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch {
    /* domain stays empty */
  }

  try {
    const fetched = await chrome.runtime.sendMessage<FetchReply>({ kind: 'FETCH', url });
    if (!fetched.ok) {
      post(
        makeMessage(
          'SCRAPE_ERROR',
          { domain, error_type: fetched.errorType, reason: fetched.reason },
          requestId,
        ),
      );
      return;
    }
    // A 200-OK body can still be an anti-bot interstitial (Cloudflare/etc.). Flag it as a
    // precise CHALLENGE before parsing, so it never mis-marshals as a DOM_DRIFT (§9.4.2).
    const challenge = detectChallengePage(fetched.text);
    if (challenge) {
      post(
        makeMessage(
          'SCRAPE_ERROR',
          { domain, error_type: challenge.errorType, reason: challenge.reason },
          requestId,
        ),
      );
      return;
    }
    const doc = new DOMParser().parseFromString(fetched.text, 'text/html');
    const outcome = runParser(doc, url);
    post(
      outcome.ok
        ? makeMessage('SCRAPE_RESULT', outcome.payload, requestId)
        : makeMessage('SCRAPE_ERROR', outcome.error, requestId),
    );
  } catch (err) {
    post(
      makeMessage('SCRAPE_ERROR', { domain, error_type: 'NETWORK_TIMEOUT', reason: String(err) }, requestId),
    );
  }
}

/**
 * Service a barcode product lookup (recommendation point 2): delegate the JSON fetch +
 * parse to the background worker (no DOM needed, so it returns the typed payload directly)
 * and post back a strictly-typed PRODUCT_LOOKUP_RESULT or an explicit PRODUCT_LOOKUP_ERROR,
 * echoing the correlation id so the PWA routes the outcome to the lookup that started it.
 */
async function handleLookup(msg: ProductLookupRequestMessage): Promise<void> {
  const { gtin } = msg.payload;
  const { requestId } = msg;
  try {
    const looked = await chrome.runtime.sendMessage<LookupReply>({ kind: 'LOOKUP', gtin });
    post(
      looked.ok
        ? makeMessage('PRODUCT_LOOKUP_RESULT', looked.product, requestId)
        : makeMessage(
            'PRODUCT_LOOKUP_ERROR',
            { domain: OPEN_FOOD_FACTS_HOST, error_type: looked.errorType, reason: looked.reason },
            requestId,
          ),
    );
  } catch (err) {
    post(
      makeMessage(
        'PRODUCT_LOOKUP_ERROR',
        { domain: OPEN_FOOD_FACTS_HOST, error_type: 'NETWORK_TIMEOUT', reason: String(err) },
        requestId,
      ),
    );
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const msg = parseExtensionMessage(event.data, { origin: event.origin, trustedOrigins });
  // §9.1: only act on a validated *_REQUEST from the PWA; everything else is dropped/ignored.
  if (msg?.type === 'SCRAPE_REQUEST') void handleScrape(msg);
  else if (msg?.type === 'PRODUCT_LOOKUP_REQUEST') void handleLookup(msg);
});

// The PWA is a single-page app that may mount its listener slightly after we inject,
// so announce readiness now and a couple more times shortly after (§9.3).
announce();
setTimeout(announce, 500);
setTimeout(announce, 1500);
