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
import { isAmazonHost } from '../../src/features/inventory/asin';
import { parseGtin } from '../../src/features/scanner/gtin';

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

declare const chrome: {
  runtime: {
    onInstalled: { addListener: (cb: () => void) => void };
    onMessage: {
      addListener: (
        cb: (
          message: unknown,
          sender: { tab?: Tab },
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

/** Content-script match patterns for the Gubbins PWA — where a payload may be delivered. */
const PWA_URL_PATTERNS = ['http://localhost/*', 'http://127.0.0.1/*', 'https://*.github.io/*'] as const;

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
    await chrome.storage.session.set({ [QUEUE_KEY]: queue });
  } catch {
    /* session storage unavailable — a queued payload is best-effort */
  }
}

/** Push one already-correlated scrape to a specific PWA tab; resolves false if it can't. */
async function sendToTab(tabId: number, item: QueuedScrape): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      kind: 'DELIVER_ACTIVE_TAB',
      requestId: item.requestId,
      outcome: item.outcome,
    });
    return true;
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
    const tabs = await chrome.tabs.query({ url: PWA_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      if (await sendToTab(tab.id, item)) delivered = true;
    }
  } catch {
    /* tabs query failed — fall through to queueing */
  }
  if (!delivered) await writeQueue([...(await readQueue()), item]);
}

/** Flush any queued scrapes to a freshly-ready PWA tab, then clear the queue. */
async function flushQueueTo(tabId: number): Promise<void> {
  const queue = await readQueue();
  if (queue.length === 0) return;
  for (const item of queue) await sendToTab(tabId, item);
  await writeQueue([]);
}

/** Inject the active-tab scraper into the user's Amazon tab (explicit-gesture only). */
async function scrapeAmazonTab(tab: Tab): Promise<void> {
  if (tab.id === undefined || !tab.url) return;
  let host = '';
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const req = message as Partial<FetchRequest & LookupRequest & DataFetchRequest> | null;
  if (req?.kind === 'FETCH' && typeof req.url === 'string') {
    void fetchPage(req.url).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (req?.kind === 'LOOKUP' && typeof req.gtin === 'string') {
    void fetchProduct(req.gtin).then(sendResponse);
    return true;
  }
  if (req?.kind === 'DATA_FETCH' && typeof req.url === 'string') {
    void fetchDataUrl(req.url).then(sendResponse);
    return true;
  }
  // The injected active-tab bundle reporting a live-DOM scrape outcome (Path A2).
  const active = message as { kind?: string; outcome?: ActiveTabOutcome } | null;
  if (active?.kind === 'ACTIVE_TAB_SCRAPE' && active.outcome) {
    void deliverToPwa(active.outcome);
    return false; // fire-and-forget
  }
  // A Gubbins PWA tab announcing it is ready to receive queued scrapes.
  if (active?.kind === 'PWA_READY' && sender.tab?.id !== undefined) {
    void flushQueueTo(sender.tab.id);
    return false;
  }
  return false;
});
