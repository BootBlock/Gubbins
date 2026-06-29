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
- Provider-agnostic sync (File System Access) with last-write-wins conflict resolution.
- Export / import as a Markdown vault or a raw `.sqlite` file.
- Archive and restore, including image re-hydration.
- Storage triage dashboard: OPFS quota recovery, history pruning, and image downgrade.
- Cross-device handling of unlinked local-file attachments.

**Interface & accessibility**
- Customisable drag-and-drop dashboard widget board.
- Dark / light / system-auto theming, plus currency and locale formatting.
- Installable PWA with an offline indicator.
- Kiosk / tablet mode with screen wake-lock.
- Accessibility throughout: focus trapping, ARIA tree navigation, skip links, live regions, accessible form errors, and reduced-motion support.

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
| Cloud sync | Provider-agnostic interface with a File System Access adapter (last-write-wins) |

## Development

**Quick start (Windows):** double-click **`run.bat`**, or run **`.\run.ps1`** in PowerShell. Either installs dependencies on first use, starts the app, and opens it at `http://localhost:5173/Gubbins/`. Pass `preview` (e.g. `run.bat preview` / `.\run.ps1 preview`) to build and serve the production bundle at `http://localhost:4173/Gubbins/` instead.

Or use npm directly:

```sh
npm install
npm run dev        # Vite dev server (cross-origin isolated for OPFS)
npm run build      # Type-check + production build
npm run preview    # Serve the production build (real service worker + offline)
npm run test       # Vitest
```

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

[MIT](LICENSE) © 2026, Joe Cox.
