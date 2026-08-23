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
 * the PWA uses — origin-verified, signature-checked, schema-valid. That origin check is
 * only worth anything because this script runs on the Gubbins app and nowhere else: the
 * manifest injects it on the `GUBBINS_APP_URL_PATTERNS` match patterns, and {@link isGubbinsAppUrl}
 * re-checks the page here before a single listener is installed (issue #493). An unrelated
 * page is therefore never injected into, and cannot post a message this script would read. A
 * message from another *window* on the app's own origin is dropped too — the app talks to itself.
 */
import {
  makeMessage,
  parseExtensionMessage,
  peerProtocolVersion,
  peerSupports,
  PROTOCOL_VERSION,
  type DataFetchRequestMessage,
  type ProtocolCapability,
  type ProductLookupRequestMessage,
  type ProductLookupResultPayload,
  type ScrapeErrorPayload,
  type ScrapeRequestMessage,
  type ScrapeResultPayload,
} from '../../src/features/scraping/protocol';
import { runParser } from '../../src/features/scraping/parsers/registry';
import { detectChallengePage } from '../../src/features/scraping/scrape-errors';
import { OPEN_FOOD_FACTS_HOST } from '../../src/features/scraping/product-lookup';
import { isGubbinsAppUrl } from '../../src/features/scraping/app-origins';
import type { ScrapeErrorType } from '../../src/features/scraping/protocol';

const VERSION = '1.7.0';
const trustedOrigins = [window.location.origin];

/**
 * The wire generation the PWA on this page speaks, learned from its `APP_READY` (issue #664).
 *
 * `null` means it has not said — an app build that predates negotiation, or one that has not
 * answered our hello yet. Unlike the extension's own version, an app build number says nothing
 * about the message set it knows, so there is nothing to recover it from.
 */
let appProtocol: number | null = null;

/**
 * May we hand the app a `capability`'s payload?
 *
 * Only *positive* knowledge that the app is too old holds a payload back. An app that has said
 * nothing is given the benefit of the doubt, because refusing it would break the active-tab
 * import for every app build that predates negotiation — a real loss traded for a hypothetical
 * one. What this does remove is the case the app told us about.
 */
function appSupports(capability: ProtocolCapability): boolean {
  return appProtocol === null || peerSupports(appProtocol, capability);
}

/**
 * Tell the background worker this Gubbins tab can receive queued active-tab scrapes.
 *
 * Sent twice on purpose. The first goes out with the rest of the handshake, so an app that never
 * answers a hello still collects its queue exactly as before. The second goes out when the app
 * *does* answer, because only then is {@link appProtocol} known — a flush before that would
 * decide what the app can read from no information at all, and the queue is cleared of whatever
 * it hands over.
 */
function announceTabReady(): void {
  void chrome.runtime.sendMessage({ kind: 'PWA_READY' }).catch(() => undefined);
}

/** Record the generation the app announced, flushing the worker's queue the first time. */
function learnApp(protocol: number): void {
  const first = appProtocol === null;
  appProtocol = protocol;
  if (first) announceTabReady();
}

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
  post(makeMessage('EXTENSION_READY', { version: VERSION, protocol: PROTOCOL_VERSION }));
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

/**
 * Install the bridge — but only on a real Gubbins page (issue #493).
 *
 * The manifest already restricts injection to the app's own pages, so this is
 * defence-in-depth: a widened pattern, or a manifest a self-hoster edited too generously,
 * would otherwise silently hand an unrelated page a scraper it can drive and a channel the
 * worker delivers Amazon payloads to. Refusing here costs one comparison and keeps that
 * from ever depending on the manifest alone.
 */
function install(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    // The PWA posts to *itself*, so anything from another window is not the app asking, however
    // its origin reads. A GitHub Pages account serves all of its projects from one origin, so a
    // sibling project there could otherwise open the app and drive it by `postMessage` — the
    // last remnant of issue #493 that narrowing the injection patterns does not reach.
    if (event.source !== window) return;
    const msg = parseExtensionMessage(event.data, { origin: event.origin, trustedOrigins });
    // §9.1: only act on a validated *_REQUEST from the PWA; everything else is dropped/ignored.
    if (msg?.type === 'SCRAPE_REQUEST') void handleScrape(msg);
    else if (msg?.type === 'PRODUCT_LOOKUP_REQUEST') void handleLookup(msg);
    else if (msg?.type === 'DATA_FETCH_REQUEST') void handleDataFetch(msg);
    // The app's answer to our hello (issue #664): remember the generation it speaks, so a payload
    // it would silently drop is held back rather than posted into the void. Nothing is posted back
    // — answering an `APP_READY` with an `EXTENSION_READY` would bounce the two forever.
    else if (msg?.type === 'APP_READY') learnApp(peerProtocolVersion(msg.payload));
  });

  /**
   * Receive an active-tab Amazon scrape the background worker routes to this PWA tab (Path A2)
   * and post it into the page as a validated ACTIVE_TAB_RESULT/ERROR — unless the app on this page
   * speaks a generation that would not understand it, in which case the worker is told so and
   * keeps the payload queued (issue #664). The extension generates
   * the correlation id (the PWA never requested this), which the PWA bridge uses to dedupe a
   * payload delivered to more than one open tab. The payload still passes through the same
   * `parseExtensionMessage` origin/shape validation on the PWA side — this only *posts* it.
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { kind?: string; requestId?: string; outcome?: ActiveTabOutcome } | null;
    if (msg?.kind !== 'DELIVER_ACTIVE_TAB' || typeof msg.requestId !== 'string' || !msg.outcome) return;
    // An app too old to know `ACTIVE_TAB_RESULT` drops it in silence (§9.1) and the worker, seeing
    // the send resolve, clears its queue — so the user's "Add to Gubbins" click is lost with no
    // trace on either side. Reporting the refusal instead makes the worker re-queue it, and the
    // PWA updates itself, so the next open collects it (issue #664).
    if (!appSupports('activeTab')) {
      sendResponse({ delivered: false });
      return false;
    }
    post(
      msg.outcome.ok
        ? makeMessage('ACTIVE_TAB_RESULT', msg.outcome.payload, msg.requestId)
        : makeMessage('ACTIVE_TAB_ERROR', msg.outcome.error, msg.requestId),
    );
    sendResponse({ delivered: true });
    return false;
  });

  // The PWA is a single-page app that may mount its listener slightly after we inject,
  // so announce readiness now and a couple more times shortly after (§9.3).
  announce();
  setTimeout(announce, 500);
  setTimeout(announce, 1500);

  // Tell the background worker this Gubbins tab is ready, so it can flush any active-tab
  // scrapes captured while no PWA tab was open (Path A2 "queue for the next open").
  announceTabReady();
}

if (isGubbinsAppUrl(window.location.href)) install();
