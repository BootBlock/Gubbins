# PHASE_HANDOVER.md — Phase 55 → Phase 56

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 55 — Backlog (developer-chosen): **coloured the Add Item location picker** — the one concrete residual deferred by Phase 54. `CreateItemDialog`'s Location field was the last location surface still showing no colour swatch (a native `<select>`); it is now the tinted, accessible `LocationSelect` combobox the parent / Move-Item pickers already use, driven by an RHF `Controller`.
**Date:** 2026-06-29
**Status:** ✅ Complete. `npm run type-check` clean (exit 0) · `npm run build` passes (bundle reporter prints **2912.62 KiB across 28 precache files, no budget — informational only**) · **1130/1130 unit tests pass** across **115 test files** on the **`threads`** pool, ~4 s (no unit tests added/changed — the work is thin RHF/DOM glue over already-tested pure helpers) · **92/92 browser-smoke steps pass** (no new step — the three Add Item flows were converted in place and one gained a colour-tint assertion; first run flaked on the documented "adds a weighted capability" `press('Enter')` step and went green on re-run; zero console/page errors). **No schema migration — `user_version` stays 19** (Phase 54's additive v19 `locations.description`/`color`). **No dependency change.** **`build:extension` NOT re-run** (no §9 / `extension/` edit).

> ⚠️ **Stale-handover note (resolved):** the file you may have entered on was *Phase 53 → 54*. Phase 54 (location description + colour swatch, additive **v19**, `user_version = 19`) shipped via commits (`79fffd2 …`) but never regenerated this handover. This document now reflects the true head state (Phases 1–55 complete, schema v19). If you ever see the schema/commits disagree with this file again, **trust the migration registry + `git log`** and reconcile.

> ⚠️ **Smoke flake reminder:** the long-standing intermittent **"adds a weighted capability"** `press('Enter')` flake **did** fire on the first Phase-55 run and cleared on re-run — **re-run once** before investigating a smoke red. The Phase-37 deep-scroll step seeds 305 items and can take a few seconds. The Phase-53 datasheet step does a full `page.reload()` mid-suite (simulated second device, relies on OPFS persisting).

> ⚠️ **Node-25 cold-start unit flake reminder:** the full `npm run test:run` wrapper (`scripts/run-unit-tests.mjs`) auto-recovers the `Cannot read properties of undefined (reading 'config')` fingerprint; it did **not** fire this phase. A bare `npx vitest run <file>` lacks the wrapper — re-run it by hand if it hits the flake.

> ✅ **What shipped (one pick, no migration).**
> - **Coloured the Add Item location picker (Phase-54 residual).** `CreateItemDialog`'s Location field is converted from a native `<select>` (which strips colour/layout from `<option>`s) to the tinted **`LocationSelect`** combobox — the accessible WAI-ARIA select-only listbox the location **Parent** and **Move Item** pickers already use, where each row renders the location's `text-loc-*` colour swatch + right-aligned item count. It is driven by an RHF **`Controller`** (`control` from `useForm`), with options from the existing pure `buildItemLocationOptions(locations, fmt.quantity)` (`features/inventory/parent-options.ts`). Crucially it is **not** wrapped in `FormField`: that primitive names its control via an implicit `<label>`, which only names *labelable* elements — a `div[role="combobox"]` is not one — so the field is associated via a sibling `<span id={useId()}>Location</span>` + `LocationSelect labelledBy={id}`, mirroring `MoveItemDialog` exactly. A `role="alert"` sibling renders the (effectively unreachable) `locationId` validation error.
> - **Smoke:** a `role=combobox` can't be driven by Playwright `selectOption`, so the three Add Item flows changed from `getByLabel('Location').selectOption({label})` to `getByRole('combobox',{name:'Location'}).click()` + `getByRole('option',{name}).click()`; the cycle-count flow additionally asserts the teal `Workshop` option carries `.text-loc-teal`, proving the new tint.
> - **Deferred (not dropped):** every remaining open item is a conditional/YAGNI Backlog entry with **no live trigger** (multi-scrape UI tray, true NTP/cross-origin time source, leaner/precache-excluded WASM decoder, live distributor selector maintenance, further `aria-live`). **No mandated spec gap and no tracked location-UI residual remain.** Tracked in `docs/dev/deferred-features.md` (Phase-55 section + the Phase-54 deferral now ticked).

> Protocol Alpha (§8.1.2): the incoming Phase 56 agent **must** read both the master specification
> (`docs/todo/done/_specification.md`) and this document before writing any code, and must reuse the established
> Repository/driver, 3-tier state, Foundry, icon-registry and testing patterns rather than inventing new ones.
> **The spec's numbered phases end at Phase 9; Phases 10+ are consolidation phases delivering the explicitly
> *deferred-not-dropped* work in `docs/dev/deferred-features.md`.** As of Phase 55 **every enumerated consolidation
> phase (10–16) is complete, the developer-chosen Backlog items so far (P17–P53) are cleared, the last *mandated*
> spec gap (§4 "Unlinked Local File", P53) is closed, P54 added location description + colour, and P55 cleared the
> final location-UI residual.** **No remaining open item is a mandated spec requirement** — they are all
> purely-conditional / YAGNI Backlog entries with **no live trigger today, and there is no remaining "closest
> sibling" continuation of any kind.** Confirm the Phase-56 scope with the developer before starting (see §9).

---

## 1. Locked decisions & toolchain (spec §1.2 — binding, restated)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` — official build, FTS5 + **OPFS VFS** (`opfs`; the file at `/gubbins.sqlite3` **is** the raw DB). FTS5 verified at boot via `probeFts5`. |
| Package manager | **npm** (only `package-lock.json`) |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + coi-serviceworker COOP/COEP (via `src/sw.ts` injectManifest worker). PWA `registerType: 'autoUpdate'`; the worker `skipWaiting`/`clients.claim()`s, so new versions auto-activate + auto-reload. |
| Cloud sync | **Provider-agnostic** — strict `CloudProvider` interface; in-memory + File System Access adapters. **Still no provider SDK** in the dep tree. |
| Conflict resolution | Row-level **LWW** + tombstones (§7.2, 180-day TTL, watermark-aware); **Delta-CRDT** gauge replay (§7.3); §7.5 orphan re-parent + cycle rejection + child-FK guard. |
| Extension bridge | **`window.postMessage`** Content-Script bridge (§9). `SCRAPE_ERROR` is the Phase-36 seven-member set (`DOM_DRIFT`/`NETWORK_TIMEOUT`/`RATE_LIMITED`/`BLOCKED`/`NOT_FOUND`/`SERVER_ERROR`/`CHALLENGE`); `requestId`-correlated, origin+Zod-validated, silent-drop. **Untouched since P36.** |
| Test runner | **Vitest** · UUIDs via native `crypto.randomUUID()` · formatting via `Intl` · **`test.pool: 'threads'`** (P21) · **`npm run test:run` wraps `vitest run` with a surgical single auto-retry of the Node-25 cold-start flake** (P27 — `scripts/run-unit-tests.mjs`). |
| E2E | **Playwright** (dev-only) driving **system Edge** (`channel: 'msedge'`, no download); a global fake camera so the §6 scanner reaches `STREAM_ACTIVE` headlessly. Connectivity emulated via `page.context().setOffline(…)`; a second device by overwriting `localStorage['gubbins:device-id']` + reload. A **custom `LocationSelect` combobox is driven by `getByRole('combobox',{name}).click()` + `getByRole('option',{name}).click()`, never `selectOption`** (native `<select>`s still use `selectOption`). |
| Bundle size | **No budget (P44).** `scripts/check-bundle-size.mjs` is an **informational reporter only** — prints the precache total, exits 0, never warns/gates. |
| Native-first | Web APIs over NPM bloat (§2.4.3); all behind feature-detection guards. Lists are **virtualised** with a **bounded infinite-query window** (P37), incl. the per-item Activity Log (P52). Scanner: native **BarcodeDetector** → off-thread Web Worker zxing decode on an **adaptive cadence**, narrowable to a **single symbology** (P34), with a main-thread-capture tier for Safari < 16.4 (P33). `Intl` via `makeFormatters`/`useFormatters` (P16); System theme via `matchMedia` (P16). Dialogs **focus-trap** (P38); location sidebar is an **APG `tree`** (P39); global **skip-link + per-screen `<main>`** (P40); **kiosk wake-lock + containment** (P41); silent status via **`LiveRegion`** (P42, incl. form-field errors + offline transition P51); **reduced-motion** honoured (P43); PWA **installable in one tap** (P44); dashboard is a **customisable DnD widget board** (P45) with **user-tunable low-stock thresholds** (P46); search has a **hybrid text syntax** (OR/parens + saved searches, P47/P48). **QR codes hand-rolled** → single labels + batch sheets (P49). **Continuous-Mode batch actions** (P50). **Accessible form controls via Foundry `FormField`** (P51). **Connectivity via `useOnlineStatus` + `OfflineIndicator`** (P51). **Per-item Activity Log via `ActivityLog` + pure `describeHistoryEntry`** (P52). **Foreign `LOCAL_POINTER` degrades to "Unlinked Local File" via `resolveAttachmentLink` + `getDeviceId`** (P53). **Locations carry a description + colour swatch** (P54); **every location surface — including the Add Item picker (P55) — renders the swatch** via the `LocationSelect` listbox + pure `location-color.ts` token maps. |
| Base currency / locale | **GBP / en-GB** defaults (§1.2.1), user-configurable end-to-end (P16). |

**Installed majors:** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 · TanStack Router / Query /
Virtual · Zustand 5 · React Hook Form 7 + **Zod 4** · lucide-react · vite-plugin-pwa · react-error-boundary ·
`fflate` · **`@zxing/library` (direct dep)** · happy-dom (test env) + `@testing-library/react`. Node on this
machine: **v25.2.1**.

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build && node scripts/check-bundle-size.mjs`) ·
`npm run type-check` · **`npm run test:run`** (unit/`:memory:`, **1130 tests**, `threads` pool — via the
`scripts/run-unit-tests.mjs` auto-retry wrapper) · `npm run test:e2e` (real-browser smoke; needs a dev server up,
**92 steps**) · `npm run check:bundle` (informational size report only) · `npm run build:extension`. **Local run:**
`run.bat` / `run.ps1`. **Launch the dev server in a persistent background process** (the Bash tool's
`run_in_background` works well; a PowerShell `Start-Job` does **not** survive into a later tool call, and
`Start-Process npm` fails — npm is `npm.cmd`, so go via `Start-Process cmd.exe -ArgumentList '/c','npm run dev'`).
**Stop it via its PID** (`Stop-Process` the owner of the listening port; confirm release via
`Get-NetTCPConnection -LocalPort <port> -State Listen` — the resulting exit-127 "task failed" notice is just the
killed process reporting non-zero, expected). Phase 55's dev server bound **5174** (5173 was occupied by a stale
server — pass `SMOKE_BASE=http://localhost:5174/Gubbins/`). `$pid` is a **read-only** PowerShell automatic
variable — use a different loop variable.

> ⚠️ **`npm run type-check` pipe trap:** `tsc` errors are masked if you pipe through `tail`/`head`. Capture
> `${PIPESTATUS[0]}` (bash) / `"$LASTEXITCODE"` (pwsh).

> ⚠️ **Route-tree generation:** `src/routeTree.gen.ts` is generated by `@tanstack/router-plugin` when **Vite** runs,
> *not* `tsc`. **Phase 55 added NO route** (it edited an existing component + the smoke). If Phase 56 adds a
> `src/routes/*` file, run `npx vite build` once **before** `type-check`.

> ⚠️ **`noUncheckedIndexedAccess` + `noUnusedLocals` are on.** A destructured/imported symbol you don't use is a
> hard error.

> ⚠️ **Foundry basename-collision trap (P42):** a pure `.ts` module and a `.tsx` component **must not share a
> basename**.

> ⚠️ **`FormField` can't name a custom combobox (P55):** `FormField` associates its control via an implicit
> `<label>`, which names only *labelable* elements — **not** a `div[role="combobox"]` like `LocationSelect`. For
> such a control, name it via a sibling `<span id>` + the control's `labelledBy`/`aria-labelledby` (cf.
> `MoveItemDialog` / `CreateItemDialog` Location field), and render any error as a `role="alert"` **sibling** (P51).

> ⚠️ **Design tokens:** colours/motion come from tokens (`src/styles/index.css`), never raw hex / Tailwind palette
> classes. Location swatches are **semantic keys** (`'teal'`) → `text-loc-*`/`bg-loc-*` tokens via the **static
> literal** maps in `features/inventory/location-color.ts` (a computed `` `text-loc-${k}` `` would not be scanned by
> Tailwind). There is **no `glyph-warning` token** — use `text-warning`.

> ⚠️ **Modal "Close" ambiguity (P49 smoke trap):** the Foundry `Modal` renders its own built-in close (X) named
> **"Close"** — a dialog that *also* has a text "Close" button makes `getByRole('button', { name: 'Close' })`
> resolve to two elements. In the smoke close such a dialog with `page.keyboard.press('Escape')` or a `data-testid`.

> ⚠️ **The extension (`extension/`) is bundled by esbuild, NOT type-checked by `tsc -b` and NOT run by Vitest.** Put
> any extension-shared logic in a pure `src/` module and unit-test it there. **`dist/` is unchanged since P36.**

---

## 2. Database schema snapshot — `PRAGMA user_version = 19` (UNCHANGED this phase)

**Phase 55 added no migration.** The registry (`src/db/migrations/index.ts`) ends at **v19**
(`v19-location-description-color`, Phase 54): additive nullable `locations.description TEXT` + `locations.color TEXT`
(`TARGET_SCHEMA_VERSION` = 19, derived as the max registered version). Both columns:

- **Nullable, no backfill, NOT FKs** — no `FK_REFS` entry, no `applyPlan`/`LocationRepository.delete` null-out.
- **Sync for free** — `locations` ∈ `SYNC_TABLES` and the LWW schema dictionary (`buildSchemaDictionary`) reads
  columns live via `PRAGMA table_info`; the snapshot reader uses `SELECT *`. ⚠️ But `LocationRepository`'s
  `SELECT_WITH_COUNT` lists columns **explicitly**, so any *future* additive location column must be added there too
  (`getById` uses `SELECT *`).

All earlier seams are exactly as left: v18 `item_attachments.origin_device_id` (non-FK, synced; P53); v17
`maintenance_schedules.location_id`; v16 `checkouts.source_batch_key`; v15 `stock_batches` + the three-level guarded
recompute triggers; v14 `checkouts.source_location_id`; v13 `item_stock`; v12 `received_qty`; v11
`accrue_checkout_hours` + the M:N/leaf/`item_history`/`item_images` sync-set expansion; v10 history watermark; the
variant CTE guard; vault/archive seams; In-Transit/usage derived projections; formatter/theme seams; the bounded-list
`maxPages` window; kiosk (P41); `LiveRegion`/`liveRegionAttrs` (P42); reduced-motion (P43); install-prompt (P44);
dashboard-layout + `listLowStock` (P45); low-stock thresholds (P46); text-search parser + reducer `load` (P47);
OR/parens parser + `useSavedSearchesStore` (P48); QR/printable batch (P49); Continuous-Mode batch-action (P50);
`FormField`/`fieldAria` + `useOnlineStatus`/`OfflineIndicator` + gauge `clampNetValue`/`refill*` (P51);
`describeHistoryEntry`/`historyActionLabel` + bounded `useItemHistory` (P52); `resolveAttachmentLink`/`getDeviceId`
(P53); `location-color.ts` + `Textarea` + `ColorSwatchPicker` (P54). **The `items` auto-stamp + FTS triggers remain
untouched.**

---

## 3. What shipped in Phase 55 (one pick; no migration)

### 3.1 `CreateItemDialog` — Location field → tinted `LocationSelect`
`src/features/inventory/components/CreateItemDialog.tsx`: the native `<Select {...register('locationId')}>` is
replaced by an RHF `Controller` rendering `LocationSelect` (`value`/`onChange` from `field`), options from
`buildItemLocationOptions(locations, fmt.quantity)` (`useFormatters()` for the count formatter). The control is named
by a sibling `<span id={useId()} className="mb-field-gap block text-sm font-medium">Location</span>` +
`labelledBy={id}` (the field is **not** in `FormField` — see the §1 trap); the `errors.locationId?.message` renders
as a `role="alert"` sibling. No other field changed (Tracking/Category/Condition remain native `<Select>`s).

### 3.2 Smoke — three Add Item flows + a tint assertion
`scripts/browser-smoke.mjs`: the three `getByLabel('Location').selectOption({label:drawerName})` calls (cycle-count,
batch-receive, serialised-audit flows) became `getByRole('combobox',{name:'Location'}).click()` +
`getByRole('option',{name:drawerName}).click()`. The cycle-count flow additionally waits on the teal
`Workshop ${stamp}` option's `.text-loc-teal` span (asserting the new swatch tint). **No new step** — step count
stays **92**.

### 3.3 No new pure module, no migration, no dependency, extension untouched
The change is thin RHF/DOM glue over already-tested pure helpers (`buildItemLocationOptions`,
`locationColorTextClass`) + the already-built `LocationSelect`, so no contrived pure module was invented and no unit
test was added (1130 unchanged). `user_version` stays **19**; no `package.json` change; **`build:extension` NOT
re-run**.

---

## 4. Testing (TDD-first) — what's reusable (1130; smoke 92)

- **No new unit tests** — the work reuses `parent-options.ts` (`buildItemLocationOptions`, tested) and
  `location-color.ts` (`locationColorTextClass`, tested) and the `LocationSelect` combobox (exercised by the Move /
  parent picker smoke). Wiring an existing combobox through an RHF `Controller` is glue best covered by the browser
  smoke, not a contrived component test — consistent with the P53/P42 guidance.
- **Established TDD seams unchanged:** `createMemoryDriver()` `:memory:` + `IDatabaseDriver` DI (§8.5); the Repository
  pattern; pure helpers extracted out of glue; injectable `lib/env/*` + `apiOverride` hook seams.
- **Smoke driving a custom combobox:** open via `getByRole('combobox',{name}).click()` then
  `getByRole('option',{name}).click()` (option `name` matches as a **substring**, so the trailing item-count meta in
  the option's accessible name doesn't break the match). Never `selectOption` on a `role=combobox`.

---

## 5. Files touched (orientation map)

- **Edit:** `src/features/inventory/components/CreateItemDialog.tsx` (imports `Controller`/`useId`/`useMemo`/
  `useFormatters`/`buildItemLocationOptions`/`LocationSelect`; `control` from `useForm`; `locationOptions` memo;
  Location field rebuilt as the `Controller` + `LocationSelect` + sibling label + alert).
- **Smoke:** `scripts/browser-smoke.mjs` (three Add Item flows converted; one tint assertion).
- **Docs:** `docs/dev/deferred-features.md` (Phase-54 "Colour the Add Item location picker" deferral ticked +
  Phase-55 section) and this file.
- **Unchanged:** every migration; all Repositories; `LocationSelect.tsx` / `MoveItemDialog.tsx` / `parent-options.ts`
  / `location-color.ts` (reused as-is); `protocol.ts` / `scrape-errors.ts` / the whole §9 path; the extension
  `dist/*`; `package.json`; `vite.config.ts`; the flake-retry runner; every other component and seam.

---

## 6. The companion extension (`extension/`) — UNCHANGED since Phase 36

Phase 55 touched no §9 protocol and no `extension/` source, so `extension/dist/*` is exactly as Phase 36 left it
(the seven-member `SCRAPE_ERROR` enum incl. `CHALLENGE`, `detectChallengePage` in `dist/content-script.js`). No
`build:extension` re-run was needed.

---

## 7. Technical debt, stubs & deferrals

> Tracked in `docs/dev/deferred-features.md` — kept current. **Phase 55 ticked the Phase-54 "Colour the Add Item
> location picker" deferral; no tracked location-UI residual remains.**

**Remaining Backlog (all triggered conditionals — none has a live trigger today):** multi-scrape UI tray (trigger: a
real concurrent-scrape entry-point, e.g. bulk BOM ingress); live distributor selector maintenance (trigger: a real
scrape against a live supplier failing); true NTP / cross-origin time source (trigger: same-origin `Date` proves
insufficient); leaner / precache-excluded WASM decoder (the ~442 KiB zxing scanner-fallback worker is ~15% of the
precache — excluding it sacrifices *offline* fallback scanning; **no size gate forces it since the P44 budget
removal**); further `aria-live` coverage (the silent surfaces are all done — any *new* region needs a genuinely
silent in-place status surface). **No remaining open item is a *mandated* spec requirement, and there is no "closest
sibling" continuation of any kind.**

**Carried LWW-class limitation (not a Phase-55 change):** concurrent location-delete vs. offline stock edit — an
additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until the next
reconcile (accepted, parallel to §7.5.2).

**Carried attachment note (P53 design choice, not debt):** a *legacy* pre-v18 `LOCAL_POINTER` (NULL origin) is
treated as `local` on every device — it cannot be attributed, so it keeps its prior behaviour. Only pointers
created/relinked from P53 onward carry an origin and degrade correctly.

> **Working-tree note:** the recent location-UI work (Phase 54) was committed (`79fffd2 …`, `6167968 …`) on
> `phase-9-lifecycle`. **Phase 55's edits are currently uncommitted in the working tree** — committing/branching is
> the developer's call (no phase agent commits without being asked).

---

## 8. Live consolidation roadmap (post-Phase-55)

**Every enumerated consolidation phase (10–16) is complete**, the developer-chosen Backlog items so far (P17–P53)
are cleared, the last *mandated* spec gap (§4 "Unlinked Local File", P53) is closed, P54 added location description +
colour, and **P55 cleared the final location-UI residual** (the Add Item picker). No spec-numbered or
roadmap-enumerated phase remains; the scanner/perf, §9 scraping, a11y, kiosk, PWA-installability,
customisable-dashboard, advanced-search, printable-QR, Continuous-Mode, the P51 trio, the P52 Activity Log, the P53
attachment degradation and the P54/P55 location colour story have all exhausted their named work; **no remaining
Backlog item has a concrete trigger today**, and **no remaining open item is a *mandated* spec requirement.** Phase 56
is therefore another **developer-chosen Backlog / polish** phase (or a no-op until a trigger fires). **There is no
remaining "closest sibling" continuation of any kind.** Candidates remain the unrelated conditional Backlog entries
(multi-scrape UI tray; live distributor selector maintenance; a true NTP source; a leaner/precache-excluded WASM
decoder; further `aria-live`), or a fresh investigation pick like Phases 37–53 were.

---

## 9. Phase 56 entry checklist

- [ ] Read the master spec **and** this handover; restate the locked decisions.
- [ ] **Confirm Phase-56 scope with the developer first** — no enumerated phase remains, no Backlog item has a live
      trigger, and no remaining open item is a *mandated* spec requirement; pick one deliberately, propose a fresh
      investigation (as Phases 37–53 were), or agree there's nothing to land yet. **There is no "closest sibling"
      residual — choose consciously.**
- [ ] **Reuse, don't reinvent:** the Repository/driver + `createMemoryDriver()` test path; 3-tier state; the Foundry
      primitives & **Tooltip (not `title`)** + **Toast** + the **focus-trapping Modal** (built-in **"Close"** can
      collide with a feature "Close") + the **APG-tree LocationSidebar** + the **`SkipLink` (+ `MAIN_CONTENT_ID`)** +
      the **`LiveRegion` (+ `liveRegionAttrs`)** + the **`FormField` (+ `fieldAria`)** + the **`Textarea`** + the
      **`ColorSwatchPicker`** + the **`LocationSelect` combobox** (name it via `labelledBy`, *not* `FormField`) + the
      **`useReducedMotion`/`useInstallPrompt`/`useWakeLock`/`useOnlineStatus`/`getDeviceId`** injectable-seam hooks
      (the `apiOverride` pattern + a pure `lib/env/*` probe); icons via the registry; RHF + Zod (drive a custom
      control with a **`Controller`**); **the `makeFormatters` factory + `useFormatters()` hook**; the
      `resolveTheme`/`applyTheme` seam; the export vault + archive seams; the recursive-ancestor-CTE cycle guard;
      **the "derive a projection from the SSOT, never a stored counter" seam**; **the cycle-count / partial-receipt /
      per-location-stock / batch seams**; **the off-thread scanner + adaptive-cadence + symbology seams**; **the §9
      scraping seam**; **the bounded-list seam** (`list-window.ts` + `MAX_LIST_PAGES`, also driving the Activity Log);
      **the focus-trap / tree-keyboard / dashboard-layout seams**; **the text-search + saved-search seams**
      (`parseASTtoSQL` is the single SQL translator — never hand-build SQL from text); **the QR/printable +
      Continuous-Mode batch-action seams**; **the `describeHistoryEntry`/`historyActionLabel` formatter**; **the
      `resolveAttachmentLink` + `getDeviceId` attachment seams**; **and the `location-color.ts` swatch-key→token
      seam**. **The bundle check no longer enforces a budget.**
- [ ] **TDD-first over `createMemoryDriver()`** (Protocol Beta) for any logic; keep pure helpers pure, use an
      **injectable dependency seam** for hard-to-unit-test glue. **For anything that runs in the extension, put the
      logic in a pure `src/` module and unit-test it there.** **Don't invent a contrived pure module for thin DOM
      glue** — a `@testing-library/react` component/hook test (or the browser smoke for pointer/camera/network/device
      glue) is the right tool. **Don't share a basename between a pure `.ts` and a component `.tsx`** (P42). **A
      control inside an existing `<form>` must not be its own `<form>`** (P48). **Render a field's `role="alert"`
      error as a sibling of the label** (P51). **Name a custom `role=combobox` via `labelledBy`, not `FormField`**
      (P55). **In the smoke, close a Modal with Escape or a `data-testid`** (P49). **`noUnusedLocals` is on.** **Use
      design tokens, never raw colour/motion values.**
- [ ] **A schema migration is only needed if you add persistent bookkeeping** — register the next migration in
      `src/db/migrations/index.ts`, bump `user_version` past **19**, add a migration test (additive pattern `v9`…`v19`;
      `engine.test.ts` asserts the *derived* `TARGET_SCHEMA_VERSION` and per-version tests use `>=`, so neither needs
      narrowing for an additive bump). A column on a `SYNC_TABLES` table auto-joins the LWW payload — add it to
      `SYNC_EXCLUDED_COLUMNS` if device-local; a new synced **FK** column needs an `FK_REFS` entry +
      `applyPlan`/`LocationRepository.delete` null-out (a non-FK synthetic id needs neither). **A new additive
      `locations` column must also be added to `LocationRepository`'s explicit `SELECT_WITH_COUNT`.** (A device-local
      UI toggle/preference belongs in `usePreferencesStore`/`useLayoutStore`/a dedicated Zustand `persist` store /
      `localStorage`; a transient, workflow-scoped selection belongs in ephemeral Tier-3 React/Context state.)
- [ ] ⚠️ **Trigger ordering & FTS5:** do **not** `DROP`/`CREATE` the `items` auto-stamp or FTS triggers. For a
      quantity-like derived projection, copy the v13/v15 guarded separate-table recompute pattern.
- [ ] **Extend `scripts/browser-smoke.mjs`** with any new flows. `SMOKE_BASE` if not on 5173/5174. **Launch the dev
      server in a persistent background process** (Bash `run_in_background`; `Start-Process npm` fails — go via
      `cmd.exe /c "npm run dev"`), and **stop it via its PID** — verify the port is released. Connectivity →
      `page.context().setOffline(…)`; a second device → overwrite `localStorage['gubbins:device-id']` + reload; a
      custom combobox → open + click option. If you add a `src/routes/*` file, run `npx vite build` once before
      `type-check`. **Vite bundles `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })` as a
      separate module graph** — use that exact form.
- [ ] Verify four ways and keep all green: `npm run type-check` (check the exit code), `npm run test:run`
      (`threads`-pool, **1130**), `npm run build` (reporter prints the precache size, no budget), and `npm run
      test:e2e` against a live dev server (the "adds a weighted capability" step can flake on `press('Enter')` —
      re-run once; the Phase-37 deep-scroll step seeds 305 items; the Phase-53 datasheet step does a mid-suite
      reload). **Run `npm run build:extension` only if you touch §9 / `extension/`** (Phase 55 did **not**). Then
      generate the **Phase 56 → 57** handover and hand back the Phase 57 continuation prompt in a raw markdown block.
