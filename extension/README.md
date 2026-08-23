# Gubbins Supplier Scraper — companion extension

The optional companion browser extension for **Gubbins** (spec §9, Phase 8). It scrapes
supplier part data (MPN, manufacturer, description, price), looks up retail barcodes, and adds
items from the user's live Amazon tab, bridging all three to the PWA over the secure §9
Content-Script protocol. The PWA **feature-detects** the extension and degrades gracefully to
manual entry when it is absent — the extension is never required.

## Architecture (reuses the PWA's tested code)

| File | Role |
| --- | --- |
| `src/content-script.ts` | Page-side bridge on the Gubbins origins: broadcasts `EXTENSION_READY` (with the wire generation it speaks), validates inbound messages with the shared `parseExtensionMessage` (origin + signature + Zod), parses fetched HTML with the shared Strategy parsers, posts `SCRAPE_RESULT`/`SCRAPE_ERROR`. Also receives active-tab scrapes routed from the background worker and posts them into the page as `ACTIVE_TAB_RESULT`/`ACTIVE_TAB_ERROR`. |
| `src/background.ts` | CORS-bypassing fetcher (MV3 service worker — no DOM, so parsing lives in a content script). Maps transport failures to the §9.4.2 error taxonomy. Also hosts the **active-tab** trigger (toolbar click / "Add to Gubbins" context menu): injects `active-tab-scrape.js` into the Amazon tab and routes the result to an open PWA tab (or queues it). |
| `src/active-tab-scrape.ts` | Injected into the user's **live Amazon tab** (Path A2) via `chrome.scripting.executeScript` under the `activeTab` permission; runs the shared `runParser` against the rendered DOM and messages the outcome back to the background worker. |
| `manifest.json` | MV3 manifest. Content script injects on the Gubbins app pages only (see below); `host_permissions` allow **fetching** supplier pages; the `activeTab`/`scripting`/`contextMenus` permissions drive the Amazon active-tab flow **without** a broad host grant. |

The protocol schema (`src/features/scraping/protocol.ts`) and the Strategy parsers
(`src/features/scraping/parsers/`) are **shared with the PWA** and unit-tested there, so the
wire contract and DOM-drift handling cannot drift between the two halves.

### Wire versioning (issue #664)

The app and this extension are updated independently, so they routinely run a generation apart.
`PROTOCOL_VERSION` in `protocol.ts` is the wire generation, and each peer announces the one it
speaks — the extension in `EXTENSION_READY`, the app in its answering `APP_READY`. Each side then
gates a capability on the *other's* number (`peerSupports`) instead of on "a peer exists", so a
request that would be dropped in silence is never sent.

A build from before 1.7.0 announces no generation. Its version string is mapped back to one by
`LEGACY_BUILD_PROTOCOL`, which records what each of those builds actually shipped (1.2.0 → 2,
1.3.0 → 3, 1.4.0 → 4), so an old install is credited with exactly the capabilities it has. The
app's build number carries no such meaning, so an app that announces nothing is given the benefit
of the doubt instead: the content script holds an unsolicited active-tab payload back only when
the app has *told* it that it would not understand it, and the worker then keeps that payload
queued rather than clearing it.

**When you add a message kind:** add its capability to `PROTOCOL_CAPABILITY_VERSIONS`, bump
`PROTOCOL_VERSION` to that generation, and bump `manifest.json`'s `version` so a user can see
which build they have (the app shows it under Settings → Product lookup).

### Where the content script runs (issue #493)

Injection is pinned to the Gubbins app itself, path and all — the single source of truth is
`GUBBINS_APP_URL_PATTERNS` in `src/features/scraping/app-origins.ts`, which
`app-origins.test.ts` pins the manifest to:

```
https://bootblock.github.io/Gubbins/*
http://localhost/Gubbins/*
http://127.0.0.1/Gubbins/*
```

The earlier `https://*.github.io/*` + `http://localhost/*` patterns were far wider than they
read: a Chrome match pattern ignores the port, and `*.github.io` covers every GitHub Pages site
anyone publishes. Since the content script trusted `window.location.origin`, every one of those
pages was a trusted one — it could drive the scraper and receive the Amazon payloads the worker
delivers. An origin check is only worth as much as the set of pages the checking code runs in, so
the patterns are the fix; the page path is what narrows `localhost`, where a port cannot be
expressed.

Two checks back that up in code, so it never rests on the manifest alone: the content script
re-checks its own page with `isGubbinsAppUrl` before installing a single listener, and the
background worker checks the *sender* of every message the browser attributes — only an app page
may drive a fetch or claim a queued active-tab payload, and only a genuine Amazon tab may report
one.

**Self-hosting?** A deployment on your own address (see the repository `Dockerfile`) is
deliberately not covered by a wildcard — one that admitted your origin would admit every
unrelated site on it too. Adding it takes a **rebuild**, not a manifest edit: `isGubbinsAppUrl`
is compiled into `content-script.js`, so a widened `matches` in the built manifest only injects a
script that then refuses to install itself (and the worker would refuse its requests). Add your
deployment to `GUBBINS_APP_ORIGINS` in `src/features/scraping/app-origins.ts`, giving the base
path you built with — `/` for the `Dockerfile`'s default, `/gubbins/` for
`--build-arg GUBBINS_BASE_PATH=/gubbins/`:

```ts
{ scheme: 'https', host: 'gubbins.example.com', path: '/' },
```

Mirror the entry's pattern (`https://gubbins.example.com/*`) into `content_scripts[0].matches` in
`extension/manifest.json`, and add the same entry to the shipped-origins expectation in
`src/features/scraping/app-origins.test.ts` — that pin is what stops the list widening by
accident, so your own deployment has to be added to it deliberately. Then
`npm run build:extension` and reload the unpacked extension. Keep the entry as narrow as your
deployment allows: a `path` of `/` admits every page on that host, which is the right trade only
when the host serves nothing but Gubbins.

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
