<p align="center">
  <img src=".github/assets/gubbins-banner.png" alt="Gubbins — a local-first, offline-capable PWA for tracking anything you own" width="100%" />
</p>

# Gubbins

[![Tests](https://github.com/BootBlock/Gubbins/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/BootBlock/Gubbins/actions/workflows/tests.yml?query=branch%3Amain)

## Use it

Gubbins runs entirely in your browser — **no install or local server required**.

1. Open **<https://bootblock.github.io/Gubbins/>**.
2. Start using it. All data is stored locally on your device (in the browser's OPFS); nothing is sent to a server.
3. *(Optional)* Click **Install** in your browser to add Gubbins as a standalone, offline-capable app.

> First load registers a service worker and may refresh once — this is expected (it enables the in-browser database). Your data lives in the browser profile you use, so use the same browser to find it again.

## About

A **local-first, offline-capable Progressive Web App** for tracking *anything* — electronics, 3D-printing supplies, tools, collections, household items, and general inventory. All data resides and is processed entirely within the user's browser/device.

> Status: **v0.3.0** (pre-release) — the master specification (phases 1–9) and the consolidation roadmap that followed it are implemented, so every feature listed below is built and usable. Development continues as issue-driven work: the open backlogs are the `🟢 ACTIVE` plans in [`docs/todo/`](docs/todo), alongside the trigger-gated items in `docs/dev/deferred-features.md`. While Gubbins is before **1.0**, database schema changes between updates are not migrated — an update may need your local data to be reset (back up first).

## Features

**Inventory**
- Track anything: items with categories, custom fields (eleven types, including image and file), weighted **capabilities**, quantities, photos, and attachments (a URL, or a pointer to a local file).
- Hierarchical, colour-coded locations with descriptions, per-location item counts, custom fields that nested locations can inherit, photos you can mark regions on, and optional dimensions so you can see how full a space is.
- Per-location stock ledger — quantities tracked independently at each location, with transfers between them.
- Batch / lot tracking beneath each location, with expiry dates and FEFO (first-expiry-first-out) consumption.
- Four tracking modes: **bulk** quantities, **serialised** one-of-a-kind units, a **consumable** gauge for what you measure rather than count, and **untracked** for presence alone.
- Parent/child **variants & SKUs** (sizes, colours, or values of one part) and **kits & bundles** with a live "how many can I build?" count.
- Tag items, relate or substitute one for another, grade an item's **condition**, and **remove** items you no longer track (restorable).
- Count by **weight** against a container tare, reading a live weight off a connected scale if you have one.
- Configurable low-stock thresholds with at-a-glance gauges, and a per-item history of stock moves, edits and lifecycle events.
- Browse as cards, a data grid, a table, a location map or a value treemap, paged or infinitely scrolled. Edit in bulk, duplicate an item, and do arithmetic (`2+3*4`) in any number field.

**Asset lifecycle**
- **Warranty** tracking with derived status, plus depreciation schedules and a replacement-value figure for insurance.
- Time- and usage-based **maintenance & servicing** schedules; a usage schedule can opt in to accrue checkout-hours from loans automatically, and can be scoped to the stock at one location.
- **Test & calibration** records for serialised items, and append-only **revaluations** for when something's worth changes.
- **Cycle counting** and reconciliation (bulk, serialised, per-location, and per-batch), including a guided audit-day walk.

**People, loans & bookings**
- **Contacts** — the people you lend to and borrow from.
- Check items out to a **contact**, a **project**, or a **location** (the van, the workshop) and back in — returning to their original location and lot — with overdue tracking, loan renewals, and a full audit trail.
- **Bookings** — reserve items over a date range, optionally against a contact, with overlapping reservations refused rather than merely flagged; cancel a booking, or convert it straight into a loan.

**Users & permissions** (opt-in)
- Multiple password-protected accounts behind a sign-in gate, off by default — switch it on and Gubbins asks who you are before it opens.
- Roles built from a permission matrix, so an account can be limited to what it may read or change.
- Per-account **API tokens** for the companion bridge — shown once, revocable, and scoped to that account's permissions.

**Search**
- Full-text search powered by SQLite FTS5 — each word matched as a prefix across names, descriptions, notes, MPNs, manufacturers, barcodes and serial numbers.
- **Visual search** — compose a query from pickers, or describe what you want in plain English ("at least 10", "not in the attic").
- A hybrid text syntax alongside it: `field:value` contains, `field=value` exact, `field>n` / `field<n` compares, dates, `tag:`, `has:field` presence, `cap:key>n`, negation (`-term` / `NOT`), `AND`/`OR`/parentheses, and around sixty field aliases.
- Capability-based search with best-match ranking.
- Save and recall named searches; mark items **favourite** to float them to the top of a list, or narrow to them with `fav:yes`.
- A global **command palette** (`Ctrl`/`⌘` + `/`) for jumping to any item or screen, with inline quick actions.

**Scanning & labels**
- Barcode/QR scanning via the native BarcodeDetector, with an off-thread `@zxing` WASM fallback; on older Safari the frame is captured on the main thread and still decoded off it.
- Adaptive frame-skip decode on the WASM path, selectable symbology, and an in-frame torch toggle and camera picker where the device offers them.
- **NFC** tap-to-scan, and writing a Gubbins tag from an item's code dialog.
- Scan an unknown barcode to look the product up online (opt-in), or add a new item already carrying that code.
- Continuous scan mode with batch actions (move-all, check-out-all), plus per-scan quantity, move and check-out actions.
- Printable labels for items **and** locations — QR, Code 128, or both — either as A4 sticker sheets (named stock presets or custom geometry) or as single die-cut / thermal labels at an exact size.
- Optional on-device **OCR**: photograph a receipt or product label and Gubbins proposes the price, date, MPN and serial for you to confirm.

**Purchasing & projects**
- **Projects** with bills of materials (BOM), component reservations, per-category budgets and an expense ledger, plus a picking worksheet ordered for the walk round your locations.
- **Suppliers** — a dictionary of who you buy from (renameable, with duplicates mergeable), holding each part's order code, pack size, minimum order quantity and price breaks, with a price-over-time history.
- **Purchase orders** with a draft → ordered → partial → received lifecycle, on-order and in-transit quantity tracking, partial / split line receipts into a chosen location and lot, and supplier returns.
- **Reorder** — shortfalls grouped by preferred supplier and sized from pack quantity, minimum order and price breaks, then raised as draft purchase orders or exported as a shopping list; plus a **wishlist** for things you only want.
- Project-scoped export vault sub-folders.

**Reports & insights**
- Valuation by category and location, consumption rate, stock-movement trends, and dead-stock detection.
- Spend and **sales & margin** analytics, ABC analysis, inventory turnover, stock aging, and valuation over time.
- Data-hygiene quality checks that surface incomplete records; most reports export as CSV (sales & margin is on-screen only).
- A printable **insurance / estate schedule** (room-by-room replacement values, exportable in several formats) and a branded, printable **parts catalogue**.

**Sales & disposals**
- Record items **sold or written off**, feeding the sales & margin report.

**Alerts, activity & agenda**
- A global **Activity** ledger of every change; an **Alerts** feed of everything needing attention (low stock, expiries, servicing due, warranty expiry) that can be snoozed or dismissed alert by alert; and an **Upcoming** agenda unifying everything due — booking returns, loan due-backs, servicing, warranty and expiry dates, and reorder points.
- Optional browser reminder notifications for expiries, servicing and warranty dates, raised by the service worker and deep-linking straight to the item.

**Supplier data scraping** (companion browser extension)
- Pull an MPN, manufacturer, description, supplier URL and live pricing off a product page into an item — every field reviewed before it is applied, so a value you typed is never silently overwritten.
- Parsers for DigiKey, Mouser, Farnell, LCSC, RS, Adafruit and SparkFun from a pasted URL, plus a generic metadata fallback; Amazon is read from the tab you already have open.
- One-click price refresh across every supplier row for an item, reporting the cheapest live price and why any row was skipped.
- Detailed error taxonomy plus CAPTCHA / challenge-page detection.
- Built from source and loaded unpacked into Chrome or Edge — see [`extension/README.md`](extension/README.md); it is not published to a store.

**Data, sync & resilience**
- Local-first and fully offline; an in-browser SQLite database (WASM + OPFS) is the single source of truth.
- Provider-agnostic cloud sync — a local **File System Access** folder or **Google Drive** (backend-less browser OAuth into an app-private folder) — with last-write-wins conflict resolution.
- Full database backup & restore: a portable `.zip` bundling a version-guarded JSON snapshot with an exact `.sqlite` copy, full-resolution images and device settings (each part optional), restored as a non-destructive **Merge** or an exact **Replace** — the destructive path guarded by an auto restore-point, an impact preview, a storage-quota warning, and a type-to-confirm gate. Restoring the full archive re-hydrates your images; a Safe Mode rescue path can export or import the raw `.sqlite` if the app won't start.
- Export to a Markdown vault, JSON, or CSV (items, reports, catalogue); a BOM, reorder list or insurance schedule also exports as TSV, Excel, Markdown or HTML. Exports are one-way — a vault is for reading elsewhere, not for restoring.
- Bulk import from pasted text or a file (CSV / TSV / semicolon-separated / JSON / Markdown or HTML tables / free-form lines), plus one-click **migration** from another inventory tool (see [below](#migrating-from-another-tool)).
- Outbound **webhooks** you configure in the app — event filters, custom headers, an HMAC-signed secret, a test fire, and a per-delivery log — delivered on your behalf by the companion bridge.
- Storage triage (history pruning and image downgrade) alongside database maintenance that compacts the file and sweeps orphaned images.
- Cross-device handling of unlinked local-file attachments.
- Optional Home Assistant / query bridge: ask a voice assistant where your items are — or push your whole dataset straight to it (see [below](#home-assistant--external-query-bridge-optional)).

**Interface & accessibility**
- Modular UI — around thirty optional modules, so you can hide pages and cross-cutting capabilities you don't use (Projects, Purchase orders, Suppliers, Contacts, Bookings, Reports, Maintenance, Scanner, Batches, Kits, Variants, Sales, Users, Sync, Webhooks, Home Assistant, and more) for a leaner app, per-device. Start from a curated preset in the skippable first-run chooser or fine-tune every module on the **Modules** screen; the underlying features stay fully functional and your data is untouched, so anything can be switched back on at any time. Turning a module off removes it everywhere — nav menu, dashboard tiles and widgets, command palette, item-detail tabs, and the Alerts/Upcoming feeds — with dependent features cascaded and confirmed.
- Customisable drag-and-drop dashboard widget board (keyboard-movable too), and item cards you can configure — which fields each card shows, in what order, the badge, and what a click does.
- An About screen with a lightweight cinematic starfield.
- Multi-language UI (English and German today) with per-key fallback to English, driven by your chosen locale.
- Dark / light / system-auto theming with sixteen accent colours or a custom brand hue, OLED and high-contrast switches, surface styles, a graded animation level, optional background weather, plus currency and locale formatting (base currency guessed on first run).
- Installable PWA with an offline indicator.
- Kiosk / tablet mode with screen wake-lock.
- Accessibility throughout: focus trapping, ARIA tree navigation, skip links, live regions, accessible form errors, and reduced-motion support.

## Migrating from another tool

Already running another inventory app? Open **Import items**, paste your export (or choose the
file), and pick your tool under **Import source**. Gubbins recognises each tool's export by its
column headers, so **Auto-detect** usually just works — or force a specific source. Each
migration is a pure field-mapping that runs *in front of* the normal import pipeline, so you get
the same live preview and per-row create/update/error status before anything is written.

| Source | How to export | Mapped to Gubbins |
| --- | --- | --- |
| **Homebox** | Tools → Export (the `HB.`-prefixed CSV) | name, description, quantity, location, manufacturer, model number → MPN, notes, purchase price → unit cost |
| **Grocy** | Products / Stock overview → export CSV | name, description, location, amount → quantity, barcode → identifier, min-stock → reorder point, price → unit cost |
| **Sortly** | Export → CSV (all items) | name, notes, quantity, price → unit cost, barcode → identifier, min level → reorder point, folder → location |
| **Snipe-IT** | Assets → Export → CSV | name, model number → MPN, manufacturer, location, purchase cost → unit cost, notes (quantity of 1 per asset) |
| **InvenTree** | Part list → Export → CSV | name, description, IPN → identifier, in-stock → quantity, minimum stock → reorder point, default location, notes |
| **LCSC** | Order details / cart → Export, or the LCSC BOM CSV | manufacturer part number → name, LCSC part number → SKU, description, manufacturer, order qty → quantity, unit price → unit cost |

Anything a source exports that has no clean Gubbins field — labels, tags, serial numbers, warranty
dates, and each tool's **category / group name** — is folded into that item's **notes** with a
clear "Imported from …" provenance line, so nothing is lost and no column is ever silently
mis-mapped. Categories are intentionally *not* auto-assigned (Gubbins categories are referenced by
id, with their own custom fields); assign them after the import from the folded provenance note.
Choose **Generic (spreadsheet / CSV)** to bypass a tool's mapper and map the columns yourself.

## Add to Gubbins from other apps

Once you've **installed Gubbins** as an app (use your browser's *Install* / *Add to Home Screen*),
your OS can hand content straight to it. Every one of these opens a **reviewable draft you confirm**
— Gubbins never adds or changes anything on its own from a share or a link.

- **Share to Gubbins.** From any app's share sheet (a browser, a photo, a note), pick **Gubbins**.
  A shared **link** opens a pre-filled *Add item* draft — the page title becomes the name and the
  supplier-scraper box is pre-loaded so you can enrich it in one tap; an Amazon listing
  additionally fills the MPN from its ASIN. Shared **text** seeds the name and notes; a shared
  **image** is attached to the item once you save. Review the draft and confirm to add it.
- **Open a file with Gubbins.** Choose *Open with → Gubbins* (or double-click) a `.csv`, `.tsv`,
  `.json`, `.md`, or `.txt` file and it drops straight into the **Import** tool's live preview.
- **Deep links.** A `web+gubbins://item/<id>` link (e.g. from a note) opens that item in Gubbins;
  `web+gubbins://add?title=…&url=…` opens a pre-filled draft.

Because Gubbins is serverless, the **service worker** handles the incoming share on-device — nothing
is uploaded anywhere. These entry points appear only after the app is installed.

## Home Assistant / external query bridge (optional)

Gubbins itself stays serverless and in-browser, so a web page can't host a LAN endpoint a
voice assistant could reach. To bridge that gap **without** breaking the local-first promise,
an **optional companion service** in [`bridge/`](bridge/README.md) runs **on your own hardware**
(a NUC, a Raspberry Pi, a NAS, or the Home Assistant host). It takes a copy of your inventory,
hydrates it into a headless SQLite database, and runs the app's *own* search code over it — so
you can ask *"Where are my M3 screws?"* and get the right answer. Nothing is sent to any cloud,
and the bridge is **not part of the PWA or the GitHub-Pages build** — it ships nothing to the
browser and is entirely opt-in.

### What it gives you

Example; if you were to ask Home Assistant (either by text, voice (including with Google Assistant/Gemini/Alexa/etc)) the following:

> Where are the M3 screws?

You would see/hear (supports voice via Google Assistant/Gemini/Alexa/etc):

> The M3 screws are located in the garage, in storage box 3.

Every HTTP surface is **bearer-token-protected**, **loopback-by-default**, and rate-limited, and a
token only reaches what its account's permissions allow. (The MCP server below is the exception —
it speaks stdio, so its boundary is the process that launches it.)

- **A read-only HTTP API** — `GET /health`, `/search?q=…`, `/where?q=…` plus a versioned
  `/api/v1` (items, locations, categories, capabilities, and single records by id) whose OpenAPI
  spec is served at `/api/v1/openapi.json`. Anything that speaks HTTP can query your inventory,
  and shape the response to exactly what it needs:
  - **Field selection** — ask for just the fields you want (`fields=name,unitCost` → only the
    price) or opt into extended ones (`include=capabilities,notes`).
  - **A familiar OData-style query subset** — `$select`/`$expand`/`$top`/`$skip`/`$orderby`, a
    constrained `$filter`, `$count`/`$search`, and a CSDL `$metadata` document (a convenience
    subset, not a full OData service).
  - **CSV export** — `GET /api/v1/items.csv` (honouring the same filter/sort/search), a
    refreshable pull you can point Excel / Power BI at.
- **A subscribable calendar** — `GET /api/v1/calendar.ics`, a read-only iCalendar feed of your
  time-bearing facts (loan due-backs, asset bookings, maintenance/service dates, warranty
  expiries) that Google / Apple / Outlook / Thunderbird / Home Assistant can **subscribe** to by
  URL, so they appear alongside your own events.
- **Syndication feeds & Prometheus metrics** — `GET /api/v1/activity.rss` (plus `.atom` and
  `.json` [JSON Feed]) render your recent activity log for any feed reader, and `GET /metrics`
  exposes aggregate inventory counts (items, low-/out-of-stock, per-location) in
  OpenMetrics/Prometheus format for a Grafana home-lab.
- **A Home Assistant integration** — a HACS-compatible custom component with a
  *"Where are my {item}?"* voice intent (it speaks the location back), a dashboard sensor, and
  **auto-discovery** so you usually don't even type the host/port.
- **An MCP server** — exposes the same read-only queries as tools to an LLM/agent (e.g. Claude),
  so an assistant can look things up for you.
- **Opt-in, off-by-default change events** — turn on outbound **webhooks**
  (`GUBBINS_BRIDGE_WEBHOOKS=on`, HMAC-signed, at-least-once with retries, with a delivery log and
  a test-fire endpoint) and/or a read-only **SSE stream** (`GUBBINS_BRIDGE_EVENTS=on`,
  `GET /api/v1/events`) so Slack / Discord / n8n / Node-RED / Home Assistant can react the moment
  stock moves — e.g. a "low stock" alert. An event never mutates inventory. Emitting an event for
  each *lookup* — i.e. what somebody searched for — is a separate opt-in again
  (`GUBBINS_BRIDGE_LOOKUP_EVENTS=on`), deliberately not implied by the flag above.
- **Opt-in, off-by-default MQTT publishing** — push your inventory into a home-automation stack.
  With `GUBBINS_BRIDGE_MQTT=on` the bridge connects **out** to your MQTT broker (Mosquitto, EMQX,
  the Home Assistant add-on, …) as a *client* — it opens no extra inbound port — and publishes a
  retained snapshot of your inventory (total items, low-stock / out-of-stock counts, a per-location
  item count) plus a live change event whenever stock moves. Turn on the `…_MQTT_DISCOVERY` sub-flag
  and it *also* emits Home Assistant MQTT-discovery messages, so **HA auto-creates the Gubbins
  sensors with no custom component at all** — an alternative to the integration above (you pick one).
  Anything that speaks MQTT (Node-RED, dashboards, automations) can then react to what's in your
  boxes. It's best-effort: if the broker is down the bridge just retries — your HTTP API is
  unaffected. Full topic list, config, and the HA recipe are in
  [`bridge/README.md` → MQTT publishing](bridge/README.md#mqtt-publishing-opt-in).
- **Two data sources** — point it at either the `gubbins-sync.json` your sync writes, *or* a raw
  exported `.sqlite` database; it auto-detects which.
- **Opt-in, off-by-default writes** — let an automation or voice command adjust an item's quantity
  or a consumable's gauge level (`GUBBINS_BRIDGE_ALLOW_WRITES=on`, over HTTP or MCP); changes
  round-trip through the app's own sync merge, so there's no drift.
- **Opt-in, off-by-default connection back to Home Assistant** — give the bridge an HA URL and a
  long-lived token (`GUBBINS_BRIDGE_HA=on`) and it calls HA *outbound* on the app's behalf,
  exposing your scale entities at `/api/v1/scale/*` so the app can read a live weight when
  counting by weight.
- **Opt-in, off-by-default "push to bridge"** — if you *don't* use folder sync, the app can POST
  its whole dataset straight to the bridge (`GUBBINS_BRIDGE_ALLOW_PUSH=on`), so no shared folder
  is needed at all.

Every opt-in above defaults **off** and is a separate, startup-logged choice; the
[Permission & security matrix](bridge/README.md#permission--security-matrix) is the single,
authoritative list of every `GUBBINS_BRIDGE_*` flag, what it exposes, whether it can write, and
where its secret lives.

### Setting it up

Gubbins has a guided walkthrough built in — open the **Home Assistant** screen in the app and it
steps you through the stages below, minting the token for you. Full instructions (Node / Docker /
systemd, every config option, the security model) are in [`bridge/README.md`](bridge/README.md);
the Home Assistant side is in [`homeassistant/README.md`](homeassistant/README.md). The short
version:

1. **Get the bridge a copy of your data.** Pick one:
   - **Folder sync** — in the app, open **Cloud Sync & backups**, connect a **Local folder**
     (e.g. inside a NAS mount or a synced drive), and **Sync now**. The bridge watches the
     `gubbins-sync.json` that lands there.
   - **Push to bridge** *(no shared folder needed)* — see [the next section](#pushing-your-data-to-the-bridge).
   - **Raw export** — export a `.sqlite` from **Cloud Sync & backups** and point the bridge at it.

2. **Run the bridge** on a machine that can see that data and that Home Assistant can reach. From
   a checkout of this repo (needs Node ≥ 24, or ≥ 22.16 LTS — but **not** any v23.x build; see
   [Requirements](bridge/README.md#requirements) — or use the Docker image):

   ```sh
   cp bridge/.env.example bridge/.env      # then edit bridge/.env (it is git-ignored)
   #  - GUBBINS_SNAPSHOT_PATH  → the gubbins-sync.json (or .sqlite) from step 1
   # There is no token to set here: callers authenticate with an API token minted in the app
   # (Users → an account → API tokens), which reaches the bridge with your synced data.
   node bridge/serve.mjs                    # starts on http://127.0.0.1:8787 (loopback by default)
   ```

   To let Home Assistant on another machine reach it, bind the LAN with
   `GUBBINS_BRIDGE_HOST=0.0.0.0` (a deliberate, logged choice) and optionally enable mDNS
   auto-discovery with `GUBBINS_BRIDGE_MDNS=on`.

3. **Add the Home Assistant integration.** Copy `custom_components/gubbins/` (at the repo root)
   into your HA config, or add this repo (`BootBlock/Gubbins`) as a HACS custom repository
   (category: *Integration*), restart HA, then add the
   **Gubbins** integration — it either auto-discovers the bridge or asks for its host, port, and
   an **API token** minted in the app under *Users → an account → API tokens* (the token is stored
   by HA, never in YAML). Alongside the voice intent it registers a `gubbins.search` service, an
   opt-in `gubbins.adjust_quantity` service, and an event you can trigger automations from. Wire the
   *"Where are my {item}?"* sentences into Assist as described in
   [`homeassistant/README.md`](homeassistant/README.md).

4. **Ask away.** *"Where are my M3 screws?"* / *"How many ESP32 boards do I have?"* — Assist speaks
   the location and quantity back.

### Pushing your data to the bridge

If you don't keep a shared sync folder, you can hand the snapshot straight to the bridge over your
local network instead:

1. Start the bridge with **`GUBBINS_BRIDGE_ALLOW_PUSH=on`** (and a JSON snapshot path — push is
   refused for a raw `.sqlite` source). Keep it on `127.0.0.1` if the app runs on the same machine,
   or bind the LAN (`GUBBINS_BRIDGE_HOST=0.0.0.0`) to push from another device.
2. In the app, open **Cloud Sync & backups → Push to bridge**, enter the bridge **URL**
   (e.g. `http://127.0.0.1:8787`) and the **token**, and press **Push now**. The URL and token are
   stored **only on that device** — never synced, never committed.
3. The bridge validates the snapshot, swaps it in atomically, and immediately serves the new data.
   Push again whenever you want the bridge to catch up — there's no shared folder to manage.

The body size is capped (default 64 MiB, tunable via `GUBBINS_BRIDGE_MAX_PUSH_BYTES` for
constrained hosts like a Pi on an SD card), and push uses the same token and rate limit as
everything else. Because the push comes from a browser, the bridge only accepts it from an origin
on its CORS allow-list — the hosted site and loopback by default, so a
[self-hosted](#self-hosting-with-docker-optional) app needs its own origin added via
`GUBBINS_BRIDGE_ALLOWED_ORIGINS`.

## Self-hosting with Docker (optional)

Gubbins can be served from your own hardware instead of GitHub Pages:

```bash
docker compose up -d       # then open http://localhost:8080/
```

**This does not change where your data lives.** Gubbins remains a local-first *browser* app —
your inventory stays in the browser's OPFS storage exactly as it does on the hosted site. The
container is stateless and holds no inventory, so self-hosting raises no storage ceiling, changes
no image compression, and stores no attachment files.

What it does buy you:

- **Real COOP/COEP response headers**, so the `coi-serviceworker` polyfill that GitHub Pages
  forces is no longer load-bearing for cross-origin isolation.
- **A configurable base path** — `docker build --build-arg GUBBINS_BASE_PATH=/gubbins/ .` — rather
  than the `/Gubbins/` that Pages requires. It is baked in at build time.
- **LAN or air-gapped hosting**, with no dependency on GitHub Pages. Note that a non-`localhost`
  address must be served over **HTTPS** (via a reverse proxy) or the browser withholds the secure
  context the database needs.

`docker compose --profile bridge up -d` additionally runs the optional
[bridge](#home-assistant--external-query-bridge-optional) alongside it. See
[`docs/wiki/Self-Hosting-with-Docker.md`](docs/wiki/Self-Hosting-with-Docker.md) for the
user-facing guide.

## Architecture at a glance

- **Language:** TypeScript · **Framework:** React + Vite
- **Database:** `@sqlite.org/sqlite-wasm` running on the **OPFS VFS** inside a dedicated Web Worker, compiled with **FTS5**. The SQLite database is the single source of truth.
- **State:** three tiers — TanStack Query (data/cache), Zustand (global UI/preferences/auth), React Context (ephemeral feature state).
- **Styling:** Tailwind CSS (v4) + shadcn/ui primitives (abstracted via `components/foundry`) + `lucide-react`.
- **Routing:** TanStack Router. **PWA:** `vite-plugin-pwa`.

## Locked implementation decisions

See **`docs/todo/done/_specification.md` §1.2** for the binding decisions (SQLite distribution, package manager, hosting, cloud-sync strategy) and the rationale behind them. The master specification is the absolute source of truth.

| Area | Decision |
| --- | --- |
| SQLite WASM | Official `@sqlite.org/sqlite-wasm` (FTS5 + OPFS VFS) |
| Package manager | **npm** |
| Hosting | **GitHub Pages** (`base: '/Gubbins/'` + `coi-serviceworker` for COOP/COEP); optionally [self-hosted](#self-hosting-with-docker-optional) |
| Cloud sync | Provider-agnostic interface with File System Access + Google Drive adapters (last-write-wins) |

## Development

**Quick start (Windows):** double-click **`Run.bat`**, or run **`.\Run.ps1`** in PowerShell. Either installs dependencies on first use, starts the app, and opens it at `http://127.0.0.1:5173/Gubbins/`. Pass `preview` (e.g. `Run.bat preview` / `.\Run.ps1 preview`) to build and serve the production bundle at `http://127.0.0.1:4173/Gubbins/` instead.

**Launcher options:** both `Run.bat` and `Run.ps1` accept the same optional parameters — pass them straight through (e.g. `Run.bat -Port 8080`, or `.\Run.ps1 -BindHost localhost`):

| Option | Default | What it does |
| --- | --- | --- |
| `preview` | — | Build the production bundle and serve *that* (real service worker + offline) instead of the hot-reload dev server. |
| `-BindHost <host>` | `127.0.0.1` | Host to bind and open. Use `localhost` to keep the `localhost` origin — Vite is then bound dual-stack for reliability, at the cost of a one-time Windows Firewall prompt and the dev server being visible on the LAN. `$env:GUBBINS_DEV_HOST` overrides the default. |
| `-Port <n>` | `5173` dev / `4173` preview | Serve on a specific port (falls back to the next free port only when auto-picking the default). |
| `-Browser <exe\|path\|none>` | OS default | Open the app in a specific browser, or `none` to suppress the auto-open. Overrides the legacy `$env:BROWSER`. |
| `-NoOpen` | off | Start the server without opening a browser — just print the URL (handy for headless boxes, scripting, or an already-open tab). |

> **Why `127.0.0.1` and not `localhost`?** On Windows `localhost` resolves to both `::1` (IPv6) and `127.0.0.1` (IPv4), but Vite binds only one of them; if the browser then tries the other first it gets a connection-refused "unable to connect" page and you have to reload. Binding *and* opening the same concrete address removes that race. Use `-BindHost localhost` if you specifically need the `localhost` origin (e.g. a Google OAuth redirect registered against it) — note that browser storage is per-origin, so the two hosts keep separate local data.

Or use npm directly:

```sh
npm install
npm run dev        # Vite dev server (cross-origin isolated for OPFS)
npm run build      # Type-check + production build
npm run preview    # Serve the production build (real service worker + offline)
npm run test       # Vitest
```

> **Git hooks:** `npm install` auto-wires a native pre-commit hook (`.githooks/`, via
> `core.hooksPath`) that scans staged changes for secrets and runs Prettier + ESLint on
> staged files. It adds no dependency; bypass a single commit with `git commit --no-verify`.

> **Node version:** the app's `engines` floor is **Node ≥ 24**. The app's `:memory:` test
> driver and the companion bridge both use `node:sqlite`, and Gubbins' schema needs its FTS5
> support — so the bridge accepts **Node ≥ 22.16** or **Node ≥ 24** (**not** any Node v23.x
> build; FTS5 was never backported to that line). The bridge additionally runs TypeScript
> directly via Node's built-in type-stripping. CI pins Node 25 for every job; use a recent
> Node locally if you intend to run `npm run test`.

> **Cross-origin isolation:** the high-performance SQLite OPFS VFS requires `SharedArrayBuffer`, which the browser only permits under COOP/COEP. The dev server sets these headers directly; production (GitHub Pages) relies on the `coi-serviceworker` polyfill.

> **Single tab:** OPFS enforces an exclusive write lock — Gubbins guards against multiple open tabs and shows a graceful overlay rather than crashing.

## AI-assisted development

AI tooling was used in the development of this software — and it is not merged unexamined.

Every change is audited before it lands, and again by the gates that guard `main`:

- **Multiple independent review passes.** A change is reviewed from several different angles — correctness, security, accessibility, performance, and the project's own conventions — by review passes separate from whatever produced the change, frequently several of them working independently. Findings are validated rather than taken at face value, and every accepted fix is re-verified before it is committed.
- **Automated gates on every push.** CI runs a credential scan over added lines, a type-check spanning both the app *and* the companion bridge, lint, formatting, wiki link integrity, and the app and bridge unit-test suites. Local pre-commit and pre-push hooks run the same secret scan, plus the bridge's type-check, tests and boot smoke, before anything leaves the machine.
- **Conventions are enforced by tests, not by review alone.** Drift in the areas easiest to get quietly wrong — schema classification, storage keys, translation coverage, plan-doc status, hover-reveal accessibility — fails the build rather than relying on someone spotting it.
- **Over 600 test files** back roughly a thousand source files, and a change that touches a runtime surface is driven in a real browser rather than trusted on types alone.

None of this makes the software defect-free — see the [Disclaimer](#disclaimer) — but "written with AI assistance" here does not mean "generated and merged unread".

## Disclaimer

This software is provided "as is", without warranty of any kind. You use it **entirely at your own risk**. The developers accept no responsibility or liability for any loss, damage, data loss, or other issues arising from its use. See the [LICENCE](LICENSE) for the full terms.

## Licence

[MIT](LICENSE) © 2026 Joe Cox.
