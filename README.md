# Gubbins

A **local-first, offline-capable Progressive Web App** for tracking electronic components, 3D-printing supplies, tools, and general inventory. All data resides and is processed entirely within the user's browser/device.

> Status: **feature-complete** — the master specification (phases 1–9) and the full consolidation roadmap are implemented. Remaining work is trigger-gated backlog only (see `docs/dev/deferred-features.md`).

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
| Cloud sync | Provider-agnostic interface; concrete adapter deferred to Phase 7 |

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

## Licence

[MIT](LICENSE) © Joe Cox
