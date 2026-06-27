# Gubbins Supplier Scraper — companion extension

The optional companion browser extension for **Gubbins** (spec §9, Phase 8). It scrapes
supplier part data (MPN, manufacturer, description, price) and bridges it to the PWA over
the secure §9 Content-Script protocol. The PWA **feature-detects** the extension and
degrades gracefully to manual entry when it is absent — the extension is never required.

## Architecture (reuses the PWA's tested code)

| File | Role |
| --- | --- |
| `src/content-script.ts` | Page-side bridge: broadcasts `EXTENSION_READY`, validates inbound messages with the shared `parseExtensionMessage` (origin + signature + Zod), parses fetched HTML with the shared Strategy parsers, posts `SCRAPE_RESULT`/`SCRAPE_ERROR`. |
| `src/background.ts` | CORS-bypassing fetcher (MV3 service worker — no DOM, so parsing lives in the content script). Maps transport failures to the §9.4.2 error taxonomy. |
| `manifest.json` | MV3 manifest. Content script injects on the Gubbins origins; `host_permissions` allow fetching supplier pages. |

The protocol schema (`src/features/scraping/protocol.ts`) and the Strategy parsers
(`src/features/scraping/parsers/`) are **shared with the PWA** and unit-tested there, so the
wire contract and DOM-drift handling cannot drift between the two halves.

## Build & load

```sh
npm run build:extension      # → extension/dist/ (git-ignored)
```

Then in Chrome/Edge: `chrome://extensions` → enable *Developer mode* → *Load unpacked* →
select `extension/dist`. Open the Gubbins PWA; the "Scrape Supplier" control appears once
the content script announces itself.

> The reference build uses a broad `<all_urls>` host permission and a generic structured-
> metadata parser plus a DigiKey example. A production build would narrow `host_permissions`
> to the suppliers it actually supports and add a parser per supplier (the Strategy pattern
> makes this a one-file change — see `src/features/scraping/parsers/`).
