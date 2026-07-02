<p align="center">
  <img src="public/icons/gubbins.svg" alt="Gubbins" width="128" height="128" />
</p>

# Gubbins

## Use it

Gubbins runs entirely in your browser — **no install or local server required**.

1. Open **<https://bootblock.github.io/Gubbins/>**.
2. Start using it. All data is stored locally on your device (in the browser's OPFS); nothing is sent to a server.
3. *(Optional)* Click **Install** in your browser to add Gubbins as a standalone, offline-capable app.

> First load registers a service worker and may refresh once — this is expected (it enables the in-browser database). Your data lives in the browser profile you use, so use the same browser to find it again.

## About

A **local-first, offline-capable Progressive Web App** for tracking *anything* — electronics, 3D-printing supplies, tools, collections, household items, and general inventory. All data resides and is processed entirely within the user's browser/device.

> Status: **feature-complete** — the master specification (phases 1–9) and the full consolidation roadmap are implemented. Remaining work is trigger-gated backlog only (see `docs/dev/deferred-features.md`).

## Features

**Inventory**
- Track anything: items with categories, custom attributes, quantities, photos, and attachments (files or URLs).
- Hierarchical, colour-coded locations with descriptions and per-location item counts.
- Per-location stock ledger — quantities tracked independently at each location, with transfers between them.
- Batch / lot tracking beneath each location, with expiry dates and FEFO (first-expiry-first-out) consumption.
- Discrete, serialised, and batch-tracked item modes, plus single-level variants.
- Check items in/out — returning to their original location and lot — with a full audit trail.
- Cycle counting and reconciliation: discrete, serialised, per-location, and per-batch.
- Configurable low-stock thresholds with at-a-glance gauges.
- Per-item activity log of every change.

**Search**
- Full-text search powered by SQLite FTS5 (prefix, stemming, fuzzy matching).
- Visual query builder plus a hybrid text syntax (`field:value`, `cap:key>n`, `AND`/`OR`/parentheses).
- Capability-based search with best-match ranking.
- Save and recall named searches.

**Scanning & labels**
- Barcode/QR scanning via the native BarcodeDetector, with an off-thread `@zxing` WASM fallback.
- Adaptive frame-skip decode, selectable symbology, and a main-thread fallback for older Safari.
- Continuous scan mode with batch actions (move-all, check-out-all).
- Per-item deep-link QR codes and printable batch QR label sheets (A4).

**Projects & procurement**
- Projects with bills of materials (BOM) and component reservations.
- In-transit quantity tracking with partial / split line receipts.
- Project-scoped export vault sub-folders.

**Maintenance**
- Time-based and usage-based maintenance schedules.
- Automatic usage telemetry that accrues checkout-hours.
- Per-location maintenance scheduling.

**Supplier data scraping** (companion browser extension)
- Scrape datasheets and parameters from component suppliers.
- Parsers for DigiKey, Mouser, Farnell, LCSC, RS, Adafruit, and SparkFun.
- Detailed error taxonomy plus CAPTCHA / challenge-page detection.

**Data, sync & resilience**
- Local-first and fully offline; an in-browser SQLite database (WASM + OPFS) is the single source of truth.
- Provider-agnostic cloud sync — a local **File System Access** folder or **Google Drive** (backend-less browser OAuth into an app-private folder) — with last-write-wins conflict resolution.
- Full database backup & restore: a single portable `.zip` (version-guarded JSON snapshot + an exact `.sqlite` copy + full-resolution images + device settings), restored as a non-destructive **Merge** or an exact **Replace** — the destructive path guarded by an auto restore-point, an impact preview, a storage-quota pre-check, and a type-to-confirm gate.
- Export / import as a Markdown vault or a raw `.sqlite` file, including image re-hydration.
- Storage triage dashboard: OPFS quota recovery, history pruning, and image downgrade.
- Cross-device handling of unlinked local-file attachments.
- Optional Home Assistant / query bridge: ask a voice assistant where your items are — or push your whole dataset straight to it (see [below](#home-assistant--external-query-bridge-optional)).

**Interface & accessibility**
- Customisable drag-and-drop dashboard widget board, plus an About screen with a lightweight cinematic starfield.
- Dark / light / system-auto theming, plus currency and locale formatting (base currency guessed on first run).
- Installable PWA with an offline indicator.
- Kiosk / tablet mode with screen wake-lock.
- Accessibility throughout: focus trapping, ARIA tree navigation, skip links, live regions, accessible form errors, and reduced-motion support.

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

Every surface is **bearer-token-protected**, **loopback-by-default**, and rate-limited:

- **A read-only HTTP API** — `GET /health`, `/search?q=…`, `/where?q=…` plus a versioned,
  OpenAPI-described `/api/v1` (items, locations, categories, capabilities). Anything that speaks
  HTTP can query your inventory.
- **A Home Assistant integration** — a HACS-compatible custom component with a
  *"Where are my {item}?"* voice intent (it speaks the location back), a dashboard sensor, and
  **auto-discovery** so you usually don't even type the host/port.
- **An MCP server** — exposes the same read-only queries as tools to an LLM/agent (e.g. Claude),
  so an assistant can look things up for you.
- **Two data sources** — point it at either the `gubbins-sync.json` your sync writes, *or* a raw
  exported `.sqlite` database; it auto-detects which.
- **Opt-in, off-by-default writes** — let an automation or voice command check stock in/out
  (`GUBBINS_BRIDGE_ALLOW_WRITES=on`); changes round-trip through the app's own sync merge, so
  there's no drift.
- **Opt-in, off-by-default "push to bridge"** — if you *don't* use folder sync, the app can POST
  its whole dataset straight to the bridge (`GUBBINS_BRIDGE_ALLOW_PUSH=on`), so no shared folder
  is needed at all.

### Setting it up

Full instructions (Node / Docker / systemd, every config option, the security model) are in
[`bridge/README.md`](bridge/README.md); the Home Assistant side is in
[`homeassistant/README.md`](homeassistant/README.md). The short version:

1. **Get the bridge a copy of your data.** Pick one:
   - **Folder sync** — in the app, open **Cloud Sync & backups**, connect a **Local folder**
     (e.g. inside a NAS mount or a synced drive), and **Sync now**. The bridge watches the
     `gubbins-sync.json` that lands there.
   - **Push to bridge** *(no shared folder needed)* — see [the next section](#pushing-your-data-to-the-bridge).
   - **Raw export** — export a `.sqlite` from **Cloud Sync & backups** and point the bridge at it.

2. **Run the bridge** on a machine that can see that data and that Home Assistant can reach. From
   a checkout of this repo (needs Node ≥ 24, or ≥ 22.16 LTS — see
   [Requirements](bridge/README.md#requirements) — or use the Docker image):

   ```sh
   cp bridge/.env.example bridge/.env      # then edit bridge/.env (it is git-ignored)
   #  - GUBBINS_BRIDGE_TOKEN   → a long random string (your shared secret; never commit it)
   #  - GUBBINS_SNAPSHOT_PATH  → the gubbins-sync.json (or .sqlite) from step 1
   node bridge/serve.mjs                    # starts on http://127.0.0.1:8787 (loopback by default)
   ```

   To let Home Assistant on another machine reach it, bind the LAN with
   `GUBBINS_BRIDGE_HOST=0.0.0.0` (a deliberate, logged choice) and optionally enable mDNS
   auto-discovery with `GUBBINS_BRIDGE_MDNS=on`.

3. **Add the Home Assistant integration.** Copy `custom_components/gubbins/` (at the repo root)
   into your HA config, or add this repo (`BootBlock/Gubbins`) as a HACS custom repository
   (category: *Integration*), restart HA, then add the
   **Gubbins** integration — it either auto-discovers the bridge or asks for its host, port, and
   the **token** from step 2 (the token is stored by HA, never in YAML). Wire the
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
everything else.

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
| Hosting | **GitHub Pages** (`base: '/Gubbins/'` + `coi-serviceworker` for COOP/COEP) |
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

> **Node version:** building and deploying the PWA works on **Node ≥ 20** (the `engines`
> floor). Running the *test suites* needs a newer Node: the app's `:memory:` test driver and
> the companion bridge both use `node:sqlite` — and Gubbins' schema needs `node:sqlite`'s
> FTS5 support, which requires **Node ≥ 22.16** or **Node ≥ 24** (**not** any Node v23.x
> build; FTS5 was never backported to that line). The bridge additionally runs TypeScript
> directly via Node's built-in type-stripping. CI pins Node 24 for the test jobs; use a
> recent Node locally if you intend to run `npm run test`.

> **Cross-origin isolation:** the high-performance SQLite OPFS VFS requires `SharedArrayBuffer`, which the browser only permits under COOP/COEP. The dev server sets these headers directly; production (GitHub Pages) relies on the `coi-serviceworker` polyfill.

> **Single tab:** OPFS enforces an exclusive write lock — Gubbins guards against multiple open tabs and shows a graceful overlay rather than crashing.

## Deploying (maintainers)

Hosted on **GitHub Pages**, published **manually** — pushing to `main` does *not* deploy.

**One-time setup:** in the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**. (Pages is free for public repositories.) The repo must be named **`Gubbins`** to match `base: '/Gubbins/'` in [vite.config.ts](vite.config.ts).

**To publish a new version:** open the **Actions** tab → **Deploy to GitHub Pages** → **Run workflow** (pick `main`). The workflow runs `npm run build` and deploys `dist/` to Pages; the live site updates only when you trigger it.

## AI-assisted development

AI tooling was used in the development of this software.

## Disclaimer

This software is provided "as is", without warranty of any kind. You use it **entirely at your own risk**. The developers accept no responsibility or liability for any loss, damage, data loss, or other issues arising from its use. See the [LICENCE](LICENSE) for the full terms.

## Licence

[MIT](LICENSE) © 2026 Joe Cox.
