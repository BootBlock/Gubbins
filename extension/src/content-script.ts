/**
 * Content script (spec §9.1–§9.4) — the page-side half of the secure bridge.
 *
 * Injected into the Gubbins PWA, it (1) broadcasts EXTENSION_READY so the PWA
 * unlocks the "Scrape Supplier" button (§9.3), and (2) services SCRAPE_REQUEST
 * messages: it asks the background worker to fetch the supplier HTML (bypassing
 * CORS), parses it here with the **shared, unit-tested Strategy parsers** (this
 * context has a DOM; the service worker does not), and posts back a strictly-typed
 * SCRAPE_RESULT or an explicit SCRAPE_ERROR (§9.4.2). It also services
 * PRODUCT_LOOKUP_REQUEST (a barcode) and DATA_FETCH_REQUEST (a category data
 * lookup, issue #616) — the latter returning the **raw body**, because the
 * provider that knows how to read it lives in the PWA, not here.
 *
 * Every inbound message is validated through the same {@link parseExtensionMessage}
 * the PWA uses — origin-verified, signature-checked, schema-valid — so a hostile
 * page script cannot drive the scraper.
 */
import {
  makeMessage,
  parseExtensionMessage,
  type DataFetchRequestMessage,
  type ProductLookupRequestMessage,
  type ProductLookupResultPayload,
  type ScrapeErrorPayload,
  type ScrapeRequestMessage,
  type ScrapeResultPayload,
} from '../../src/features/scraping/protocol';
import { runParser } from '../../src/features/scraping/parsers/registry';
import { detectChallengePage } from '../../src/features/scraping/scrape-errors';
import { OPEN_FOOD_FACTS_HOST } from '../../src/features/scraping/product-lookup';
import type { ScrapeErrorType } from '../../src/features/scraping/protocol';

const VERSION = '1.4.0';
const trustedOrigins = [window.location.origin];

type FetchReply = { ok: true; text: string } | { ok: false; errorType: ScrapeErrorType; reason: string };
type LookupReply =
  | { ok: true; product: ProductLookupResultPayload }
  | { ok: false; errorType: ScrapeErrorType; reason: string };
type DataFetchReply = { ok: true; body: string } | { ok: false; errorType: ScrapeErrorType; reason: string };

/** An active-tab scrape outcome the background worker delivers to this PWA tab (Path A2). */
type ActiveTabOutcome = { ok: true; payload: ScrapeResultPayload } | { ok: false; error: ScrapeErrorPayload };

declare const chrome: {
  runtime: {
    sendMessage: <R>(message: unknown) => Promise<R>;
    onMessage: {
      addListener: (
        cb: (message: unknown, sender: unknown, sendResponse: (r?: unknown) => void) => boolean | void,
      ) => void;
    };
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

/**
 * Service a **category data lookup** fetch (issue #616): delegate the request to the background
 * worker (which holds the host permissions and its own allow-list gate) and post the **raw body**
 * back for the PWA's provider parser to read. Nothing is parsed here — the descriptor that built
 * the URL is the only thing that knows how to read the answer, and it lives in the PWA.
 *
 * The URL is echoed on the reply so the PWA can confirm the body belongs to the request it made,
 * on top of the correlation id.
 */
async function handleDataFetch(msg: DataFetchRequestMessage): Promise<void> {
  const { url } = msg.payload;
  const { requestId } = msg;
  let domain = '';
  try {
    domain = new URL(url).hostname;
  } catch {
    /* domain stays empty */
  }
  try {
    const fetched = await chrome.runtime.sendMessage<DataFetchReply>({ kind: 'DATA_FETCH', url });
    post(
      fetched.ok
        ? makeMessage('DATA_FETCH_RESULT', { url, body: fetched.body }, requestId)
        : makeMessage(
            'DATA_FETCH_ERROR',
            { domain, error_type: fetched.errorType, reason: fetched.reason },
            requestId,
          ),
    );
  } catch (err) {
    post(
      makeMessage(
        'DATA_FETCH_ERROR',
        { domain, error_type: 'NETWORK_TIMEOUT', reason: String(err) },
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
  else if (msg?.type === 'DATA_FETCH_REQUEST') void handleDataFetch(msg);
});

/**
 * Receive an active-tab Amazon scrape the background worker routes to this PWA tab (Path A2)
 * and post it into the page as a validated ACTIVE_TAB_RESULT/ERROR. The extension generates
 * the correlation id (the PWA never requested this), which the PWA bridge uses to dedupe a
 * payload delivered to more than one open tab. The payload still passes through the same
 * `parseExtensionMessage` origin/shape validation on the PWA side — this only *posts* it.
 */
chrome.runtime.onMessage.addListener((message) => {
  const msg = message as { kind?: string; requestId?: string; outcome?: ActiveTabOutcome } | null;
  if (msg?.kind !== 'DELIVER_ACTIVE_TAB' || typeof msg.requestId !== 'string' || !msg.outcome) return;
  post(
    msg.outcome.ok
      ? makeMessage('ACTIVE_TAB_RESULT', msg.outcome.payload, msg.requestId)
      : makeMessage('ACTIVE_TAB_ERROR', msg.outcome.error, msg.requestId),
  );
});

// The PWA is a single-page app that may mount its listener slightly after we inject,
// so announce readiness now and a couple more times shortly after (§9.3).
announce();
setTimeout(announce, 500);
setTimeout(announce, 1500);

// Tell the background worker this Gubbins tab is ready, so it can flush any active-tab
// scrapes captured while no PWA tab was open (Path A2 "queue for the next open").
void chrome.runtime.sendMessage({ kind: 'PWA_READY' }).catch(() => undefined);
