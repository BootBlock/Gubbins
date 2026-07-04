# Gubbins Supplier Scraper — companion extension

The optional companion browser extension for **Gubbins** (spec §9, Phase 8). It scrapes
supplier part data (MPN, manufacturer, description, price), looks up retail barcodes, and adds
items from the user's live Amazon tab, bridging all three to the PWA over the secure §9
Content-Script protocol. The PWA **feature-detects** the extension and degrades gracefully to
manual entry when it is absent — the extension is never required.

## Architecture (reuses the PWA's tested code)

| File | Role |
| --- | --- |
| `src/content-script.ts` | Page-side bridge on the Gubbins origins: broadcasts `EXTENSION_READY`, validates inbound messages with the shared `parseExtensionMessage` (origin + signature + Zod), parses fetched HTML with the shared Strategy parsers, posts `SCRAPE_RESULT`/`SCRAPE_ERROR`. Also receives active-tab scrapes routed from the background worker and posts them into the page as `ACTIVE_TAB_RESULT`/`ACTIVE_TAB_ERROR`. |
| `src/background.ts` | CORS-bypassing fetcher (MV3 service worker — no DOM, so parsing lives in a content script). Maps transport failures to the §9.4.2 error taxonomy. Also hosts the **active-tab** trigger (toolbar click / "Add to Gubbins" context menu): injects `active-tab-scrape.js` into the Amazon tab and routes the result to an open PWA tab (or queues it). |
| `src/active-tab-scrape.ts` | Injected into the user's **live Amazon tab** (Path A2) via `chrome.scripting.executeScript` under the `activeTab` permission; runs the shared `runParser` against the rendered DOM and messages the outcome back to the background worker. |
| `manifest.json` | MV3 manifest. Content script injects on the Gubbins origins; `host_permissions` allow **fetching** supplier pages; the `activeTab`/`scripting`/`contextMenus` permissions drive the Amazon active-tab flow **without** a broad host grant. |

The protocol schema (`src/features/scraping/protocol.ts`) and the Strategy parsers
(`src/features/scraping/parsers/`) are **shared with the PWA** and unit-tested there, so the
wire contract and DOM-drift handling cannot drift between the two halves.

### Amazon: active-tab only (Path A2), never background-fetched

Amazon aggressively defeats cookieless server-side fetches, so it is **deliberately absent**
from the background-fetch `host_permissions`. The Amazon parser only ever runs against the
DOM of the tab the user is already viewing, injected on an explicit gesture — the price is
present, the currency correct, and there is no bot challenge. See
`docs/todo/amazon-import_2026-07-03.md` for the full A2-vs-A1 decision.

## Build & load

```sh
npm run build:extension      # → extension/dist/ (git-ignored)
```

Then in Chrome/Edge: `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
select `extension/dist`. Open the Gubbins PWA; the "Scrape Supplier" control appears once
the content script announces itself. To add an Amazon item, open a product page and click the
Gubbins toolbar button (or the "Add to Gubbins" context-menu item), then confirm the pre-filled
add-item dialog back in the PWA.

> `host_permissions` is narrowed to exactly the supplier domains with a parser (pinned to the
> allow-list in `src/features/scraping/parsers/suppliers.ts` by `host-permissions.test.ts`, so
> it can never drift back to `<all_urls>`). Adding a background-fetch supplier is a one-file
> change — write the parser, register it, add its host (see `src/features/scraping/parsers/`).
> **Amazon is the exception:** it is active-tab only and never appears in `host_permissions`.
