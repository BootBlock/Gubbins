/**
 * Active-tab scraper (Path A2) — injected into the user's **live Amazon tab** on demand.
 *
 * This is the one genuinely new capability the A2 phase adds. Everything else about Amazon
 * import reuses the existing §9 machinery; the only new thing is *where the Document comes
 * from*. The background worker injects this bundle (via `chrome.scripting.executeScript`
 * under the `activeTab` permission) into the tab the user is viewing, but only after an
 * explicit user gesture — a toolbar click or the "Add to Gubbins" context-menu item. It
 * runs against the fully-rendered, session-authenticated DOM the user already sees, so the
 * price is present and correct and there is no bot challenge (contrast the declined,
 * ToS-hostile Path A1 background fetch).
 *
 * It reuses the shared, unit-tested Strategy parsers ({@link runParser}) **verbatim** — they
 * already operate on a standard `Document` — and hands the typed outcome back to the
 * background worker, which routes it to an open Gubbins PWA tab (or queues it) over the
 * origin-verified §9 protocol. It never fetches, stores cookies, or reads anything but the
 * page's own DOM.
 */
import { runParser } from '../../src/features/scraping/parsers/registry';

declare const chrome: {
  runtime: { sendMessage: (message: unknown) => void };
};

/** The outcome shape the background worker forwards to the PWA (mirrors {@link ParseOutcome}). */
type ActiveTabOutcome =
  | { ok: true; payload: import('../../src/features/scraping/protocol').ScrapeResultPayload }
  | { ok: false; error: import('../../src/features/scraping/protocol').ScrapeErrorPayload };

(function scrapeActiveTab(): void {
  const url = window.location.href;
  let outcome: ActiveTabOutcome;
  try {
    // The live DOM is the user's real rendered page; runParser selects the Amazon parser by
    // host and derives the ASIN from the URL/#ASIN. A drift/parse failure returns a typed
    // §9.4.2 error rather than throwing — forwarded as-is so the PWA can explain it.
    const result = runParser(document, url);
    outcome = result.ok ? { ok: true, payload: result.payload } : { ok: false, error: result.error };
  } catch (err) {
    let domain = '';
    try {
      domain = new URL(url).hostname;
    } catch {
      /* domain stays empty */
    }
    outcome = { ok: false, error: { domain, error_type: 'DOM_DRIFT', reason: String(err) } };
  }
  chrome.runtime.sendMessage({ kind: 'ACTIVE_TAB_SCRAPE', outcome });
})();
