/**
 * Background service worker (spec §9.3) — the CORS-bypassing fetcher.
 *
 * The content script cannot reliably fetch a third-party supplier page from the
 * PWA's origin (CORS), so it delegates the network request here. With the manifest's
 * host permissions, the background worker fetches the raw HTML and returns the text
 * for the content script to parse with the shared Strategy parsers. Transport-level
 * failures are mapped to the §9.4.2 error taxonomy via the shared, unit-tested pure
 * {@link classifyHttpStatus} (`RATE_LIMITED`/`BLOCKED`/`NOT_FOUND`/`SERVER_ERROR`); a
 * transport-level failure with no response stays `NETWORK_TIMEOUT`. A *supplier* URL this
 * worker's own allow-list refuses before any request is `UNSUPPORTED_SITE`, since it is a
 * link the user chose; the lookup and data-lookup gates build their own URLs from an
 * allow-listed host, so a refusal there is a fault rather than a choice and stays `BLOCKED`.
 *
 * Every request is also checked against its *sender* (issue #493): only the content script
 * running on a Gubbins PWA page may drive a fetch or claim a queued active-tab payload, and only
 * the scraper injected into a genuine Amazon tab may report one. The browser fills in the
 * sender's URL, so a page cannot claim to be the app.
 *
 * Note: MV3 service workers have no DOM, so parsing happens in the content script
 * (which does) — keeping this worker tiny and dependency-free.
 */
import type {
  ProductLookupResultPayload,
  ScrapeErrorPayload,
  ScrapeErrorType,
  ScrapeResultPayload,
} from '../../src/features/scraping/protocol';
import { classifyHttpStatus } from '../../src/features/scraping/scrape-errors';
import {
  classifySupplierUrl,
  isAllowedDataLookupUrl,
  isAllowedLookupUrl,
  URL_REFUSAL_REASONS,
} from '../../src/features/scraping/parsers/suppliers';
import { buildProductLookupUrl, parseOpenFoodFactsProduct } from '../../src/features/scraping/product-lookup';
import { GUBBINS_APP_URL_PATTERNS, isGubbinsAppUrl } from '../../src/features/scraping/app-origins';
import { isAmazonHost } from '../../src/features/inventory/asin';
import { parseGtin } from '../../src/features/scanner/gtin';
import { assertExhaustive } from '../../src/lib/exhaustive';

interface FetchRequest {
  kind: 'FETCH';
  url: string;
}

/** A keyless barcode → product lookup request (recommendation point 2). */
interface LookupRequest {
  kind: 'LOOKUP';
  gtin: string;
}

/** A category data-lookup fetch (issue #616) — an open-database URL built by the PWA. */
interface DataFetchRequest {
  kind: 'DATA_FETCH';
  url: string;
}

/** Every request this worker serves on behalf of the app's content script. */
type BackgroundRequest = FetchRequest | LookupRequest | DataFetchRequest;

type FetchResponse = { ok: true; text: string } | { ok: false; errorType: ScrapeErrorType; reason: string };

type LookupResponse =
  | { ok: true; product: ProductLookupResultPayload }
  | { ok: false; errorType: ScrapeErrorType; reason: string };

/** The raw body of a data-lookup fetch — parsed by the PWA's own provider, never here. */
type DataFetchResponse =
  { ok: true; body: string } | { ok: false; errorType: ScrapeErrorType; reason: string };

const FETCH_TIMEOUT_MS = 15000;

/** The active-tab scrape outcome the injected {@link ./active-tab-scrape} bundle sends back. */
type ActiveTabOutcome = { ok: true; payload: ScrapeResultPayload } | { ok: false; error: ScrapeErrorPayload };

/** Minimal `chrome.tabs.Tab` shape we rely on. */
interface Tab {
  id?: number;
  url?: string;
}

/**
 * Minimal `chrome.runtime.MessageSender` shape — who sent a runtime message.
 *
 * `url` is the document URL of the frame that sent it, and is populated for a content script
 * without the broad `tabs` permission (`tab.url` is not, so it is only a fallback). It is set
 * by the browser, not by the page, which is what makes it usable as an identity check.
 */
interface MessageSender {
  tab?: Tab;
  url?: string;
}

/** The URL the browser attributes a runtime message to, if it gave us one. */
function senderUrl(sender: MessageSender): string | undefined {
  return sender.url ?? sender.tab?.url;
}

/**
 * Did this runtime message come from a Gubbins PWA page (issue #493)?
 *
 * The privileged worker fetches on behalf of whoever asks it, so "whoever asks it" has to be
 * checked rather than assumed. Only the content script the manifest injects into the app may
 * drive `FETCH`/`LOOKUP`/`DATA_FETCH` or claim a queued active-tab payload; the Amazon
 * scraper injected on a user gesture has its own check ({@link isForeignAmazonSender}).
 */
function isAppSender(sender: MessageSender): boolean {
  return isGubbinsAppUrl(senderUrl(sender));
}

/**
 * Is this message *not* from a genuine Amazon marketplace tab?
 *
 * Phrased as a refusal rather than an approval on purpose: the only thing that ever sends an
 * `ACTIVE_TAB_SCRAPE` is the bundle this worker injects itself, and only into a tab whose host
 * {@link scrapeAmazonTab} already checked. A sender URL the browser did not attribute therefore
 * proves nothing suspicious, and refusing it would break the user's Amazon import for the sake of
 * an attacker who cannot reach this message anyway. A sender URL that *is* attributed, and is not
 * an Amazon marketplace, is a different matter.
 */
function isForeignAmazonSender(sender: MessageSender): boolean {
  const url = senderUrl(sender);
  if (url === undefined) return false;
  try {
    return !isAmazonHost(new URL(url).hostname);
  } catch {
    return true;
  }
}

declare const chrome: {
  runtime: {
    onInstalled: { addListener: (cb: () => void) => void };
    onMessage: {
      addListener: (
        cb: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (r: FetchResponse | LookupResponse | DataFetchResponse) => void,
        ) => boolean | void,
      ) => void;
    };
  };
  action: { onClicked: { addListener: (cb: (tab: Tab) => void) => void } };
  contextMenus: {
    create: (props: {
      id: string;
      title: string;
      contexts: readonly string[];
      documentUrlPatterns?: readonly string[];
    }) => void;
    removeAll: (cb?: () => void) => void;
    onClicked: { addListener: (cb: (info: { menuItemId: string }, tab?: Tab) => void) => void };
  };
  scripting: {
    executeScript: (opts: { target: { tabId: number }; files: readonly string[] }) => Promise<unknown>;
  };
  tabs: {
    query: (q: { url: readonly string[] }) => Promise<Tab[]>;
    sendMessage: (tabId: number, message: unknown) => Promise<unknown>;
  };
  storage: {
    session: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
    };
  };
};

async function fetchPage(url: string): Promise<FetchResponse> {
  // The privileged worker's own allowlist gate (§9 hardening): only ever fetch an https
  // URL on a registered supplier domain, so a page driving the bridge can't turn the
  // extension into a fetch proxy for an arbitrary origin. This is defence-in-depth above
  // the manifest's host_permissions. The refusal is ours, not the supplier's — it is
  // reported as UNSUPPORTED_SITE rather than BLOCKED, which would claim a remote block and
  // advise a retry that can never succeed (issue #667).
  const refusal = classifySupplierUrl(url);
  if (refusal !== null) {
    return { ok: false, errorType: 'UNSUPPORTED_SITE', reason: URL_REFUSAL_REASONS[refusal] };
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

/**
 * Resolve a retail barcode (GTIN) to a product via the open, key-less database
 * (recommendation point 2). The GTIN is re-validated here (never trust the page that drove
 * the bridge), the URL is built from it and gated by the extension's own lookup allowlist,
 * and the JSON body is parsed by the shared pure {@link parseOpenFoodFactsProduct}. A barcode
 * the database doesn't carry is a clean `NOT_FOUND`, mapped through the same §9.4.2 taxonomy.
 */
async function fetchProduct(gtin: string): Promise<LookupResponse> {
  const normalised = parseGtin(gtin);
  if (normalised === null) {
    return { ok: false, errorType: 'NOT_FOUND', reason: 'Not a valid product barcode.' };
  }
  const url = buildProductLookupUrl(normalised);
  // Defence-in-depth over host_permissions: only ever fetch the allow-listed lookup host.
  if (!isAllowedLookupUrl(url)) {
    return { ok: false, errorType: 'BLOCKED', reason: 'Lookup host is not allowed.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    const failure = classifyHttpStatus(res.status);
    if (failure) return { ok: false, errorType: failure.errorType, reason: failure.reason };
    const parsed = parseOpenFoodFactsProduct(await res.text(), normalised);
    if (!parsed.ok) return { ok: false, errorType: 'NOT_FOUND', reason: parsed.reason };
    return { ok: true, product: parsed.payload };
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

/**
 * Fetch one **category data-lookup** URL (issue #616) and return its raw body.
 *
 * The URL is built by the PWA's provider descriptor, so the parsing stays there — this worker
 * only performs the request the page cannot always make itself. Gated by the extension's own
 * data-lookup allow-list before the call, the same defence-in-depth `fetchPage` applies above the
 * manifest's `host_permissions`: a page driving the bridge cannot turn this into a fetch proxy for
 * an arbitrary origin, and an off-list target is reported as a refusal (`BLOCKED`).
 *
 * `credentials: 'omit'` matters here as much as for a scrape: an open database must never see the
 * user's cookies for its own site.
 */
async function fetchDataUrl(url: string): Promise<DataFetchResponse> {
  if (!isAllowedDataLookupUrl(url)) {
    return { ok: false, errorType: 'BLOCKED', reason: 'URL is not an allowed data-lookup host.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    });
    const failure = classifyHttpStatus(res.status);
    if (failure) return { ok: false, errorType: failure.errorType, reason: failure.reason };
    return { ok: true, body: await res.text() };
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

// ---------------------------------------------------------------------------
// Active-tab Amazon enrichment (Path A2)
// ---------------------------------------------------------------------------
//
// The user triggers a scrape of the Amazon tab they are viewing (toolbar click or the
// "Add to Gubbins" context menu). We inject the `active-tab-scrape` bundle into that tab
// under the `activeTab` permission — NOT via a host fetch, so Amazon stays off the
// background-fetch allow-list (that path is the declined, ToS-hostile A1). The injected
// bundle parses the live DOM with the shared §9 parser and posts the outcome back here;
// we route it to an open Gubbins PWA tab, or queue it for the next one that opens.

const CONTEXT_MENU_ID = 'gubbins-add-from-amazon';

/**
 * Amazon marketplaces the context menu is offered on (a *display* filter only — it grants
 * no host access; the toolbar button works on any marketplace and validates on click). Kept
 * in step with the marketplaces `isAmazonHost` recognises; a page on any of them offers the
 * menu, and the click handler re-validates the host before injecting.
 */
const AMAZON_MENU_PATTERNS = [
  '*://*.amazon.com/*',
  '*://*.amazon.co.uk/*',
  '*://*.amazon.de/*',
  '*://*.amazon.fr/*',
  '*://*.amazon.it/*',
  '*://*.amazon.es/*',
  '*://*.amazon.nl/*',
  '*://*.amazon.se/*',
  '*://*.amazon.pl/*',
  '*://*.amazon.ca/*',
  '*://*.amazon.com.au/*',
  '*://*.amazon.com.br/*',
  '*://*.amazon.com.mx/*',
  '*://*.amazon.co.jp/*',
  '*://*.amazon.in/*',
] as const;

const QUEUE_KEY = 'gubbins:activeTabQueue';

/** How many undelivered active-tab scrapes the worker will hold for the next PWA tab. */
const MAX_QUEUED_SCRAPES = 20;

interface QueuedScrape {
  requestId: string;
  outcome: ActiveTabOutcome;
}

async function readQueue(): Promise<QueuedScrape[]> {
  try {
    const stored = await chrome.storage.session.get(QUEUE_KEY);
    const list = stored[QUEUE_KEY];
    return Array.isArray(list) ? (list as QueuedScrape[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: readonly QueuedScrape[]): Promise<void> {
  try {
    // Bounded: a payload may be kept rather than cleared when the app would not understand it,
    // and every scrape taken while no PWA tab is open is appended here regardless, so without a
    // limit this grows for the whole browser session. The oldest go first — a scrape the user
    // triggered an hour ago is the one they have given up on.
    const capped = queue.length > MAX_QUEUED_SCRAPES ? queue.slice(-MAX_QUEUED_SCRAPES) : queue;
    await chrome.storage.session.set({ [QUEUE_KEY]: capped });
  } catch {
    /* session storage unavailable — a queued payload is best-effort */
  }
}

/**
 * Push one already-correlated scrape to a specific PWA tab; resolves false if it can't.
 *
 * "Can't" covers two cases. The send may fail outright (no content script in that tab), or the
 * content script may *refuse* — it answers `{ delivered: false }` when the app on its page speaks
 * a wire generation that would not understand an active-tab payload (issue #664). Without the
 * refusal a payload posted into an app that discards it still counts as delivered, and the caller
 * then clears it from the queue: the user's scrape is lost with no trace on either side. Only an
 * explicit `false` refuses, so a reply of any other shape still reads as delivered.
 */
async function sendToTab(tabId: number, item: QueuedScrape): Promise<boolean> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, {
      kind: 'DELIVER_ACTIVE_TAB',
      requestId: item.requestId,
      outcome: item.outcome,
    })) as { delivered?: boolean } | undefined;
    return reply?.delivered !== false;
  } catch {
    // The tab has no ready Gubbins content script (not the PWA, or not yet injected).
    return false;
  }
}

/**
 * Route a fresh active-tab outcome to every open Gubbins PWA tab; if none can receive it,
 * queue it so the next PWA tab to announce itself (`PWA_READY`) gets it. A fresh
 * extension-generated `requestId` lets the PWA dedupe a payload delivered to several tabs.
 */
async function deliverToPwa(outcome: ActiveTabOutcome): Promise<void> {
  const item: QueuedScrape = { requestId: crypto.randomUUID(), outcome };
  let delivered = false;
  try {
    const tabs = await chrome.tabs.query({ url: GUBBINS_APP_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      // The query filter already narrows to the app, but a tab whose URL we can read is
      // re-checked here: delivery carries the scraped payload, so it goes to the Gubbins app
      // or nowhere (issue #493). A tab with no readable URL is left to the content script's
      // own self-check, which is the only thing that answers a `DELIVER_ACTIVE_TAB`.
      if (tab.url !== undefined && !isGubbinsAppUrl(tab.url)) continue;
      if (await sendToTab(tab.id, item)) delivered = true;
    }
  } catch {
    /* tabs query failed — fall through to queueing */
  }
  if (!delivered) await writeQueue([...(await readQueue()), item]);
}

/**
 * Flush any queued scrapes to a freshly-ready PWA tab, keeping back anything it would not take.
 *
 * A tab that refuses a payload (an app that would not understand it — see {@link sendToTab}) must
 * not have it cleared out from under it: the PWA updates itself, so the *next* `PWA_READY` from
 * that same tab is what finally delivers it (issue #664).
 *
 * A tab announces itself before the app has stated its generation, so a flush is answered on the
 * benefit of the doubt and this runs as it always did. The retention matters for the other caller
 * of {@link sendToTab} — a live delivery into a tab that turns it down.
 */
async function flushQueueTo(tabId: number): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;
  const undelivered: QueuedScrape[] = [];
  for (const item of queue) if (!(await sendToTab(tabId, item))) undelivered.push(item);
  await writeQueue(undelivered);
}

/** Inject the active-tab scraper into the user's Amazon tab (explicit-gesture only). */
async function scrapeAmazonTab(tab: Tab): Promise<void> {
  if (tab.id === undefined || !tab.url) return;
  let host: string;
  try {
    host = new URL(tab.url).hostname;
  } catch {
    return;
  }
  // Never inject anywhere but a genuine Amazon marketplace page (defence-in-depth over the
  // context-menu display filter and the activeTab grant).
  if (!isAmazonHost(host)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['active-tab-scrape.js'] });
  } catch {
    // Injection can fail on a page the browser forbids scripting (e.g. an interstitial);
    // surface it to the PWA as a typed error so the user isn't left wondering.
    await deliverToPwa({
      ok: false,
      error: { domain: host, error_type: 'BLOCKED', reason: 'Could not read this Amazon tab.' },
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Re-create the single context-menu item idempotently on install/update.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Add to Gubbins',
      contexts: ['page', 'link', 'selection'],
      documentUrlPatterns: AMAZON_MENU_PATTERNS,
    });
  });
});

chrome.action.onClicked.addListener((tab) => {
  void scrapeAmazonTab(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID && tab) void scrapeAmazonTab(tab);
});

/**
 * Read an inbound runtime message as a bag of unknown fields, or `null` if it is not an object.
 *
 * Anything on the page can send a runtime message, so the payload is genuinely `unknown` and
 * {@link asBackgroundRequest} narrows it field by field. Describing it as unknown fields is what
 * makes those `typeof` guards mean something: the fields were previously typed by
 * `message as Partial<FetchRequest & LookupRequest & DataFetchRequest>`, and because the three
 * `kind` literals are mutually exclusive that intersection reduces to `never` — so the cast
 * typed nothing at all, and nothing noticed because the extension was never type-checked
 * (issue #557).
 */
function asMessageBag(message: unknown): Record<string, unknown> | null {
  return typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : null;
}

/**
 * Narrow a message bag to one of the three {@link BackgroundRequest}s, or `null` if it is none.
 *
 * This is where the untrusted fields become typed ones: a request is rebuilt from the values
 * that passed their `typeof` check rather than asserted over the bag, so the union the handler
 * switches on describes data that was actually validated.
 */
function asBackgroundRequest(bag: Record<string, unknown> | null): BackgroundRequest | null {
  if (bag === null) return null;
  const { kind, url, gtin } = bag;
  if (kind === 'FETCH' && typeof url === 'string') return { kind, url };
  if (kind === 'LOOKUP' && typeof gtin === 'string') return { kind, gtin };
  if (kind === 'DATA_FETCH' && typeof url === 'string') return { kind, url };
  return null;
}

/** The refusal returned to a sender that is not the Gubbins app (issue #493). */
const FOREIGN_SENDER: FetchResponse = {
  ok: false,
  errorType: 'BLOCKED',
  reason: 'Request did not come from Gubbins.',
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const bag = asMessageBag(message);
  const fromApp = isAppSender(sender);
  const request = asBackgroundRequest(bag);
  if (request !== null) {
    if (!fromApp) {
      sendResponse(FOREIGN_SENDER);
      return false;
    }
    switch (request.kind) {
      case 'FETCH':
        void fetchPage(request.url).then(sendResponse);
        return true; // keep the message channel open for the async response
      case 'LOOKUP':
        void fetchProduct(request.gtin).then(sendResponse);
        return true;
      case 'DATA_FETCH':
        void fetchDataUrl(request.url).then(sendResponse);
        return true;
      default:
        // A request kind added to the union without a case here would otherwise be dropped in
        // silence; the guard makes that a compile error (issue #355).
        assertExhaustive(request);
        return false;
    }
  }
  // The injected active-tab bundle reporting a live-DOM scrape outcome (Path A2). It runs on the
  // Amazon tab, not the app, so it is checked against the marketplace hosts instead.
  if (bag?.kind === 'ACTIVE_TAB_SCRAPE' && bag.outcome) {
    // Shape-checked by the injected bundle that produced it, not here: it is our own code, and
    // `isForeignAmazonSender` is what decides whether to believe this message at all.
    if (!isForeignAmazonSender(sender)) void deliverToPwa(bag.outcome as ActiveTabOutcome);
    return false; // fire-and-forget
  }
  // A Gubbins PWA tab announcing it is ready to receive queued scrapes. Verified against the
  // app's own origin: a queued payload is handed to the *first* tab that says PWA_READY, so
  // trusting the claim would let any injected page collect a scrape it never triggered (#493).
  if (bag?.kind === 'PWA_READY' && sender.tab?.id !== undefined && fromApp) {
    void flushQueueTo(sender.tab.id);
    return false;
  }
  return false;
});
