# PHASE_HANDOVER.md — Phase 56 → Phase 57

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 56 — Backlog (developer-chosen, fresh investigation): **surfaced the §4.1.1 operational-metadata editor** — the one Consumable-Gauge schema field (`items.operational_metadata`, the "flexible metadata layer for operational parameters") that was stored, repository-mapped, input-accepted and synced since **v2** yet rendered by **no** component. It is now an **"Operational parameters"** section in `ItemDetailDialog`, exposed on **every** item (the field was promoted from gauge-nested to a top-level `Item.operationalMetadata`).
**Date:** 2026-06-29
**Status:** ✅ Complete. `npm run type-check` clean (exit 0) · `npm run build` passes (bundle reporter prints **2931.08 KiB across 32 precache files, no budget — informational only**) · **1153/1153 unit tests pass** across **117 test files** on the **`threads`** pool, ~4 s · **93/93 browser-smoke steps pass** (incl. one new step: edit operational parameters + DB round-trip; first run flaked on the documented "adds a weighted capability" `press('Enter')` step and went green on re-run; zero console/page errors). **No schema migration — `user_version` stays 19.** **No dependency change.** **`build:extension` NOT re-run** (no §9 / `extension/` edit).

> ℹ️ **Concurrent refactor folded in (not part of the Phase-56 pick, but reflected here for the next agent):** `ItemDetailDialog` was reworked from a flat scroll of `Section` cards into a **WAI-ARIA APG vertical `tabs`** layout (§2.4.1) — the ten facet editors are grouped into **five tabs**: **Supplier & ops** (Supplier data + **Operational parameters**), **Lifecycle** (Lifecycle & variants + Maintenance), **Media & docs** (Images + Datasheets), **Classification** (Tags + Capabilities + Custom fields), **Activity** (Activity log). Arrow-key tab navigation is the pure, unit-tested `src/features/inventory/tab-keyboard.ts` (`resolveTabKey`, +8 tests / +1 file → the 1153/117 totals above). **Only the active tab's panel is mounted.** The operational-parameters editor lives in the **default** "Supplier & ops" tab. **Smoke consequence:** driving any detail facet now requires first clicking its tab — `dialog.getByRole('tab', { name: '<Tab>' }).click()` — which every detail-dialog smoke step now does.

> ⚠️ **Smoke flake reminder:** the long-standing intermittent **"adds a weighted capability"** `press('Enter')` flake **did** fire on the first Phase-56 run and cleared on re-run — **re-run once** before investigating a smoke red. The Phase-37 deep-scroll step seeds 305 items and can take a few seconds. The Phase-53 datasheet step does a full `page.reload()` mid-suite (simulated second device, relies on OPFS persisting) **and overwrites `localStorage['gubbins:device-id']` to `smoke-other-device`** — keep any new pre-Phase-53 flow before it (the new Phase-56 step is inserted **immediately before** the Phase-53 step for exactly this reason).

> ⚠️ **Node-25 cold-start unit flake reminder:** the full `npm run test:run` wrapper (`scripts/run-unit-tests.mjs`) auto-recovers the `Cannot read properties of undefined (reading 'config')` fingerprint; it did **not** fire this phase. A bare `npx vitest run <file>` lacks the wrapper — re-run it by hand if it hits the flake.

> ✅ **What shipped (one pick, no migration).**
> - **Surfaced the §4.1.1 `operational_metadata` "flexible metadata layer".** The schema-less per-item JSON object (spec example `{ bed_temp_celsius: 60, extrusion_multiplier: 0.98, drying_time_hrs: 4 }`) existed in the DB since **v2**, was repository-mapped, accepted by `CreateItemInput`/`UpdateItemInput`, and synced for free (`items` ∈ `SYNC_TABLES`) — **but appeared in zero `.tsx` files**, so a user could neither enter nor see it (every *other* gauge field is surfaced; this one alone was invisible).
> - **Exposed on every item (developer's choice), via a top-level field promotion.** `operationalMetadata` was previously read **only when the row was a gauge** (`rowToItem` nested it inside `gauge`). It is now a **top-level `Item.operationalMetadata: Record<string, unknown> | null`** read by `rowToItem` for *all* rows (removed from `GaugeState` — nothing in any `.tsx` read `gauge.operationalMetadata`, so zero blast radius). `UpdateItemInput.operationalMetadata` + a new branch in `ItemRepository.update` persist it (inline `JSON.stringify`, mirroring the create path, so the **db layer keeps no feature-layer import**); an empty/cleared record stores SQL **NULL**, never `{}`.
> - **Editor UI:** `OperationalMetadataEditor.tsx` — a free-form `key → value` row editor (add/remove rows, `role="alert"` validation error, Save) in an **"Operational parameters"** `ItemDetailDialog` section (icon `GaugeIcon`), saved wholesale via the existing `useUpdateItem`. (It now sits in the dialog's default **"Supplier & ops"** tab — see the concurrent-refactor note above.)
> - **Pure seam (TDD, §8.2 + §2.4.4 Zod):** `features/inventory/operational-metadata.ts` — `buildMetadata` (rows → `{ ok, value: record | null }`, dropping blank rows, rejecting a value-without-key + duplicate keys, Zod-validating primitives), `metadataToRows` (record → rows), `coerceMetadataValue` (a *canonical* numeric string → number per the spec example — `String(Number(x)) === x`, so `007`/`1.50`/`1e5` stay strings; `true`/`false` → boolean). 14 pure tests + a `createMemoryDriver` round-trip test on a **non-gauge** item.
> - **Smoke:** one new step creates → opens detail → adds `bed_temp_celsius = 60` → saves → **reopens and asserts the value round-trips from the DB** (the item query is invalidated, so the reopen is a genuine worker read). New `data-testid`s: `op-meta-add`, `op-meta-save` (the latter avoids colliding with the CustomFields editor's identical "Saved" button text).
> - **Deferred (not dropped):** every remaining open item is a conditional/YAGNI Backlog entry with **no live trigger** (multi-scrape UI tray, true NTP/cross-origin time source, leaner/precache-excluded WASM decoder, live distributor selector maintenance, further `aria-live`). **No mandated spec gap remains and there is no "closest sibling" continuation.** Tracked in `docs/dev/deferred-features.md` (Phase-56 section).

> Protocol Alpha (§8.1.2): the incoming Phase 57 agent **must** read both the master specification
> (`docs/todo/done/_specification.md`) and this document before writing any code, and must reuse the established
> Repository/driver, 3-tier state, Foundry, icon-registry and testing patterns rather than inventing new ones.
> **The spec's numbered phases end at Phase 9; Phases 10+ are consolidation phases delivering the explicitly
> *deferred-not-dropped* work in `docs/dev/deferred-features.md`.** As of Phase 56 **every enumerated consolidation
> phase (10–16) is complete, the developer-chosen Backlog items so far (P17–P55) are cleared, the last *mandated*
> spec gap (§4 "Unlinked Local File", P53) is closed, P54/P55 finished the location-colour story, and P56 surfaced
> the §4.1.1 operational-metadata layer.** **No remaining open item is a mandated spec requirement** — they are all
> purely-conditional / YAGNI Backlog entries with **no live trigger today, and there is no remaining "closest
> sibling" continuation of any kind.** Confirm the Phase-57 scope with the developer before starting (see §9).

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
| Native-first | Web APIs over NPM bloat (§2.4.3); all behind feature-detection guards. Lists are **virtualised** with a **bounded infinite-query window** (P37/P52). Scanner: native **BarcodeDetector** → off-thread Web Worker zxing decode on an **adaptive cadence**, narrowable to a **single symbology** (P34), with a main-thread-capture tier for Safari < 16.4 (P33). `Intl` via `makeFormatters`/`useFormatters` (P16); System theme via `matchMedia` (P16). Dialogs **focus-trap** (P38); location sidebar is an **APG `tree`** (P39); global **skip-link + per-screen `<main>`** (P40); **kiosk wake-lock + containment** (P41); silent status via **`LiveRegion`** (P42, incl. form-field errors + offline transition P51); **reduced-motion** honoured (P43); PWA **installable in one tap** (P44); dashboard is a **customisable DnD widget board** (P45) with **user-tunable low-stock thresholds** (P46); search has a **hybrid text syntax** (OR/parens + saved searches, P47/P48). **QR codes hand-rolled** → single labels + batch sheets (P49). **Continuous-Mode batch actions** (P50). **Accessible form controls via Foundry `FormField`** (P51). **Connectivity via `useOnlineStatus` + `OfflineIndicator`** (P51). **Per-item Activity Log via `ActivityLog` + pure `describeHistoryEntry`** (P52). **Foreign `LOCAL_POINTER` degrades via `resolveAttachmentLink` + `getDeviceId`** (P53). **Locations carry a description + colour swatch** (P54); **every location surface — including the Add Item picker (P55) — renders the swatch** via `LocationSelect` + `location-color.ts`. **§4.1.1 operational metadata edited via `OperationalMetadataEditor` + pure `operational-metadata.ts`** (P56). |
| Base currency / locale | **GBP / en-GB** defaults (§1.2.1), user-configurable end-to-end (P16). |

**Installed majors:** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 · TanStack Router / Query /
Virtual · Zustand 5 · React Hook Form 7 + **Zod 4** · lucide-react · vite-plugin-pwa · react-error-boundary ·
`fflate` · **`@zxing/library` (direct dep)** · happy-dom (test env) + `@testing-library/react`. Node on this
machine: **v25.2.1**.

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build && node scripts/check-bundle-size.mjs`) ·
`npm run type-check` · **`npm run test:run`** (unit/`:memory:`, **1153 tests**, `threads` pool — via the
`scripts/run-unit-tests.mjs` auto-retry wrapper) · `npm run test:e2e` (real-browser smoke; needs a dev server up,
**93 steps**) · `npm run check:bundle` (informational size report only) · `npm run build:extension`. **Local run:**
`run.bat` / `run.ps1`. **Launch the dev server in a persistent background process** (the Bash tool's
`run_in_background` works well; a PowerShell `Start-Job` does **not** survive into a later tool call, and
`Start-Process npm` fails — npm is `npm.cmd`, so go via `Start-Process cmd.exe -ArgumentList '/c','npm run dev'`).
**Stop it via its PID** (`Stop-Process` the owner of the listening port; confirm release via
`Get-NetTCPConnection -LocalPort <port> -State Listen`). Phase 56's dev server bound **5173**; pass
`SMOKE_BASE=http://localhost:<port>/Gubbins/` if it falls back to another port. `$pid` is a **read-only** PowerShell
automatic variable — use a different loop variable.

> ⚠️ **`npm run type-check` pipe trap:** `tsc` errors are masked if you pipe through `tail`/`head`. Capture
> `${PIPESTATUS[0]}` (bash) / `"$LASTEXITCODE"` (pwsh).

> ⚠️ **Route-tree generation:** `src/routeTree.gen.ts` is generated by `@tanstack/router-plugin` when **Vite** runs,
> *not* `tsc`. **Phase 56 added NO route** (it added two `src/` modules + a component + edited existing files + the
> smoke). If Phase 57 adds a `src/routes/*` file, run `npx vite build` once **before** `type-check`.

> ⚠️ **`noUncheckedIndexedAccess` + `noUnusedLocals` are on.** A destructured/imported symbol you don't use is a
> hard error.

> ⚠️ **Foundry basename-collision trap (P42):** a pure `.ts` module and a `.tsx` component **must not share a
> basename**. (P56 kept this: pure `operational-metadata.ts` vs component `OperationalMetadataEditor.tsx`.)

> ⚠️ **`FormField` can't name a custom combobox (P55):** `FormField` associates its control via an implicit
> `<label>`, which names only *labelable* elements — **not** a `div[role="combobox"]` like `LocationSelect`. For
> such a control, name it via a sibling `<span id>` + the control's `labelledBy`/`aria-labelledby`, and render any
> error as a `role="alert"` **sibling** (P51).

> ⚠️ **Design tokens:** colours/motion come from tokens (`src/styles/index.css`), never raw hex / Tailwind palette
> classes. Location swatches are **semantic keys** (`'teal'`) → `text-loc-*`/`bg-loc-*` tokens via the **static
> literal** maps in `features/inventory/location-color.ts`. There is **no `glyph-warning` token** — use `text-warning`.

> ⚠️ **Modal "Close" ambiguity (P49 smoke trap):** the Foundry `Modal` renders its own built-in close (X) named
> **"Close"** — a dialog that *also* has a text "Close" button makes `getByRole('button', { name: 'Close' })`
> resolve to two elements. In the smoke close such a dialog with `page.keyboard.press('Escape')` or a `data-testid`.
> Likewise, two section editors can share a button label (P56: the CustomFields & operational-metadata editors both
> render a "Saved" button) — scope by a `data-testid` (`op-meta-save`).

> ⚠️ **The extension (`extension/`) is bundled by esbuild, NOT type-checked by `tsc -b` and NOT run by Vitest.** Put
> any extension-shared logic in a pure `src/` module and unit-test it there. **`dist/` is unchanged since P36.**

---

## 2. Database schema snapshot — `PRAGMA user_version = 19` (UNCHANGED this phase)

**Phase 56 added no migration.** The registry (`src/db/migrations/index.ts`) ends at **v19**
(`v19-location-description-color`, Phase 54): additive nullable `locations.description TEXT` + `locations.color TEXT`
(`TARGET_SCHEMA_VERSION` = 19, derived as the max registered version).

`items.operational_metadata` is a **pre-existing v2 column** (a `TEXT` JSON string, nullable). Phase 56 added **no
column** — it only changed how the column is *read* (now mapped to a **top-level `Item.operationalMetadata`** for all
rows in `rowToItem`, no longer nested inside `GaugeState`) and *written* (a new conditional branch in
`ItemRepository.update`). Because `items` ∈ `SYNC_TABLES` and the LWW schema dictionary reads columns live via
`PRAGMA table_info`, the column already round-trips through sync/backup unchanged.

⚠️ **`LocationRepository`'s `SELECT_WITH_COUNT` still lists columns explicitly**, so any *future* additive `locations`
column must be added there too (`getById` uses `SELECT *`). `ItemRepository` reads items with explicit column lists
too — `operational_metadata` was already in them (it pre-dates this phase), so no read-list change was needed.

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
(P53); `location-color.ts` + `Textarea` + `ColorSwatchPicker` (P54); `LocationSelect`-via-`Controller`/`labelledBy`
(P55). **The `items` auto-stamp + FTS triggers remain untouched.**

---

## 3. What shipped in Phase 56 (one pick; no migration)

### 3.1 `operational_metadata` promoted to a top-level `Item` field
`src/db/repositories/types.ts`: removed `operationalMetadata` from `GaugeState`; added a top-level
`Item.operationalMetadata: Record<string, unknown> | null` (available on any item, `null` when none); added
`operationalMetadata?: Record<string, unknown> | null` to `UpdateItemInput`. `src/db/repositories/mappers.ts`:
`rowToItem` now reads `operationalMetadata: parseJson(row.operational_metadata)` at the top level for **all** rows
(moved out of the gauge-only block). `src/db/repositories/ItemRepository.ts`: `update` gained a branch writing
`operational_metadata` (inline `JSON.stringify`, mirroring the existing create path; empty/cleared → SQL NULL — keeps
the db layer free of feature-layer imports). The create path is unchanged (a gauge can still seed it via `GaugeInput`).

### 3.2 Pure seam `features/inventory/operational-metadata.ts`
`MetadataRow {key,value}`; `coerceMetadataValue(raw)` (canonical numeric string → number, `true`/`false` → boolean,
else trimmed string); `buildMetadata(rows)` → `{ok:true,value:Record|null} | {ok:false,error}` (drops fully-blank
rows, rejects a value-without-key + duplicate trimmed keys, Zod-validates the primitive record per §2.4.4, empty →
`null`); `metadataToRows(record)` (primitive → string, nested → `JSON.stringify`). 14 unit tests
(`operational-metadata.test.ts`). DB serialisation deliberately stays in the Repository (so `db/` imports nothing
from `features/`).

### 3.3 `OperationalMetadataEditor.tsx` + `ItemDetailDialog` section
`src/features/inventory/components/OperationalMetadataEditor.tsx`: a `key → value` row editor (add/remove rows;
`role="alert"` error; a `data-testid="op-meta-save"` Save button that disables to "Saved" when not dirty; a
`data-testid="op-meta-add"` add button), re-syncing its draft from `item.operationalMetadata` via a `useEffect`
keyed on the **stable serialisation** (not object identity), saving wholesale through the existing `useUpdateItem`.
Wired as an **"Operational parameters"** section (icon `GaugeIcon`) in `ItemDetailDialog` — in the default
**"Supplier & ops"** tab after the concurrent tabbed-layout refactor (see the top-of-file note). (Distinct concept
from custom fields: those are *category-defined schema*; this is the §4.1.1 *free-form per-item* blob.)

### 3.4 Round-trip repo test + smoke
`ItemRepository.test.ts` gained a test proving a **non-gauge** item stores, re-reads (fresh `getById`) and clears
(`{}` → NULL) operational metadata. `scripts/browser-smoke.mjs` gained one step (inserted **before** the Phase-53
device-swap step): create → open detail → add `bed_temp_celsius = 60` → save → reopen → assert the value round-trips
from the DB. Step count **92 → 93**.

### 3.5 No migration, no dependency, extension untouched
`user_version` stays **19**; no `package.json` change; **`build:extension` NOT re-run**.

---

## 4. Testing (TDD-first) — what's reusable (1153; smoke 93)

- **Phase-56 pick added +15 unit tests:** 14 pure (`operational-metadata.test.ts`) + 1 `createMemoryDriver`
  round-trip in `ItemRepository.test.ts`. The concurrent tab refactor added +8 (`tab-keyboard.test.ts`) → **1153 /
  117 files**. The pure module is the §8.2 TDD seam; the repo test proves the top-level read/write over a real
  `:memory:` SQLite engine (`createMemoryDriver()` + `runMigrations` + `IDatabaseDriver` DI, §8.5).
- **Established TDD seams unchanged:** `createMemoryDriver()` `:memory:`; the Repository pattern; pure helpers
  extracted out of glue; injectable `lib/env/*` + `apiOverride` hook seams.
- **Smoke driving a long detail dialog:** open via the item card's **"Item details"** button, operate inside
  `page.getByRole('dialog')`, close with `page.keyboard.press('Escape')`. A round-trip assertion **reopens** the
  dialog after a save (the item query is invalidated on settle, so the reopen is a genuine worker read). Scope a
  shared button label (e.g. "Saved") by a `data-testid` to avoid a strict-mode multi-match.

---

## 5. Files touched (orientation map)

- **New:** `src/features/inventory/operational-metadata.ts` (pure) + `operational-metadata.test.ts`;
  `src/features/inventory/components/OperationalMetadataEditor.tsx`.
- **Edit:** `src/db/repositories/types.ts` (`GaugeState` − field; `Item` + top-level field; `UpdateItemInput` +
  field), `src/db/repositories/mappers.ts` (`rowToItem` top-level read), `src/db/repositories/ItemRepository.ts`
  (`update` branch), `src/db/repositories/ItemRepository.test.ts` (round-trip test),
  `src/features/inventory/components/ItemDetailDialog.tsx` (import + "Operational parameters" section + `GaugeIcon`).
- **Concurrent refactor (not the Phase-56 pick):** `src/features/inventory/components/ItemDetailDialog.tsx`
  reworked to APG vertical tabs + `src/features/inventory/tab-keyboard.ts` (+ `tab-keyboard.test.ts`).
- **Smoke:** `scripts/browser-smoke.mjs` (one new step before the Phase-53 step; every detail-dialog step gained a
  `getByRole('tab', { name }).click()` for the new tabbed layout).
- **Docs:** `docs/dev/deferred-features.md` (Phase-56 section) and this file.
- **Unchanged:** every migration; all *other* Repositories; `LocationSelect.tsx` / `MoveItemDialog.tsx` /
  `CreateItemDialog.tsx` / `GaugeBar.tsx` (GaugeBar never read `gauge.operationalMetadata`); `protocol.ts` /
  `scrape-errors.ts` / the whole §9 path; the extension `dist/*`; `package.json`; `vite.config.ts`; the flake-retry
  runner; every other component and seam.

---

## 6. The companion extension (`extension/`) — UNCHANGED since Phase 36

Phase 56 touched no §9 protocol and no `extension/` source, so `extension/dist/*` is exactly as Phase 36 left it
(the seven-member `SCRAPE_ERROR` enum incl. `CHALLENGE`, `detectChallengePage` in `dist/content-script.js`). No
`build:extension` re-run was needed.

---

## 7. Technical debt, stubs & deferrals

> Tracked in `docs/dev/deferred-features.md` — kept current. **Phase 56 added a "Phase 56" section; no new deferral
> was created.**

**Remaining Backlog (all triggered conditionals — none has a live trigger today):** multi-scrape UI tray (trigger: a
real concurrent-scrape entry-point, e.g. bulk BOM ingress); live distributor selector maintenance (trigger: a real
scrape against a live supplier failing); true NTP / cross-origin time source (trigger: same-origin `Date` proves
insufficient); leaner / precache-excluded WASM decoder (the ~442 KiB zxing scanner-fallback worker is ~15% of the
precache — excluding it sacrifices *offline* fallback scanning; **no size gate forces it since the P44 budget
removal**); further `aria-live` coverage (the silent surfaces are all done — any *new* region needs a genuinely
silent in-place status surface). **No remaining open item is a *mandated* spec requirement, and there is no "closest
sibling" continuation of any kind.**

**Carried LWW-class limitation (not a Phase-56 change):** concurrent location-delete vs. offline stock edit — an
additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until the next
reconcile (accepted, parallel to §7.5.2).

**Carried attachment note (P53 design choice, not debt):** a *legacy* pre-v18 `LOCAL_POINTER` (NULL origin) is
treated as `local` on every device — it cannot be attributed, so it keeps its prior behaviour.

> **Working-tree note:** Phase 56's edits are currently **uncommitted in the working tree** — committing/branching is
> the developer's call (no phase agent commits without being asked). Earlier location-UI work (Phase 54/55) was on
> `phase-9-lifecycle`; Phase 55's edits may also still be uncommitted. If schema/commits disagree with this file,
> **trust the migration registry + `git log`** and reconcile.

---

## 8. Live consolidation roadmap (post-Phase-56)

**Every enumerated consolidation phase (10–16) is complete**, the developer-chosen Backlog items so far (P17–P55)
are cleared, the last *mandated* spec gap (§4 "Unlinked Local File", P53) is closed, P54/P55 finished the
location-colour story, and **P56 surfaced the §4.1.1 operational-metadata layer**. No spec-numbered or
roadmap-enumerated phase remains; the scanner/perf, §9 scraping, a11y, kiosk, PWA-installability,
customisable-dashboard, advanced-search, printable-QR, Continuous-Mode, the P51 trio, the P52 Activity Log, the P53
attachment degradation, the P54/P55 location colour story and the P56 operational-metadata editor have all exhausted
their named work; **no remaining Backlog item has a concrete trigger today**, and **no remaining open item is a
*mandated* spec requirement.** Phase 57 is therefore another **developer-chosen Backlog / polish** phase (or a no-op
until a trigger fires). **There is no remaining "closest sibling" continuation of any kind.** Candidates remain the
unrelated conditional Backlog entries (multi-scrape UI tray; live distributor selector maintenance; a true NTP
source; a leaner/precache-excluded WASM decoder; further `aria-live`), or a fresh investigation pick like Phases
37–56 were.

---

## 9. Phase 57 entry checklist

- [ ] Read the master spec **and** this handover; restate the locked decisions.
- [ ] **Confirm Phase-57 scope with the developer first** — no enumerated phase remains, no Backlog item has a live
      trigger, and no remaining open item is a *mandated* spec requirement; pick one deliberately, propose a fresh
      investigation (as Phases 37–56 were), or agree there's nothing to land yet. **There is no "closest sibling"
      residual — choose consciously.**
- [ ] **Reuse, don't reinvent:** the Repository/driver + `createMemoryDriver()` test path; 3-tier state; the Foundry
      primitives & **Tooltip (not `title`)** + **Toast** + the **focus-trapping Modal** (built-in **"Close"** can
      collide with a feature "Close"; a shared section-button label like "Saved" collides too — scope by
      `data-testid`) + the **APG-tree LocationSidebar** + the **`SkipLink` (+ `MAIN_CONTENT_ID`)** + the
      **`LiveRegion` (+ `liveRegionAttrs`)** + the **`FormField` (+ `fieldAria`)** + the **`Textarea`** + the
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
      `resolveAttachmentLink` + `getDeviceId` attachment seams**; **the `location-color.ts` swatch-key→token seam**;
      **and the `operational-metadata.ts` rows↔record seam** (rich per-item facets are edited as `ItemDetailDialog`
      **sections** wired to their own hooks — `OperationalMetadataEditor` saves wholesale via `useUpdateItem`). **The
      bundle check no longer enforces a budget.**
- [ ] **TDD-first over `createMemoryDriver()`** (Protocol Beta) for any logic; keep pure helpers pure, use an
      **injectable dependency seam** for hard-to-unit-test glue. **For anything that runs in the extension, put the
      logic in a pure `src/` module and unit-test it there.** **Don't invent a contrived pure module for thin DOM
      glue** — a `@testing-library/react` component/hook test (or the browser smoke for pointer/camera/network/device
      glue) is the right tool. **Don't share a basename between a pure `.ts` and a component `.tsx`** (P42). **A
      control inside an existing `<form>` must not be its own `<form>`** (P48). **Render a field's `role="alert"`
      error as a sibling of the label** (P51). **Name a custom `role=combobox` via `labelledBy`, not `FormField`**
      (P55). **In the smoke, close a Modal with Escape or a `data-testid`, and scope a shared button label by
      `data-testid`** (P49/P56). **`noUnusedLocals` is on.** **Use design tokens, never raw colour/motion values.**
- [ ] **A schema migration is only needed if you add persistent bookkeeping** — register the next migration in
      `src/db/migrations/index.ts`, bump `user_version` past **19**, add a migration test (additive pattern `v9`…`v19`;
      `engine.test.ts` asserts the *derived* `TARGET_SCHEMA_VERSION` and per-version tests use `>=`, so neither needs
      narrowing for an additive bump). A column on a `SYNC_TABLES` table auto-joins the LWW payload — add it to
      `SYNC_EXCLUDED_COLUMNS` if device-local; a new synced **FK** column needs an `FK_REFS` entry +
      `applyPlan`/`LocationRepository.delete` null-out (a non-FK synthetic id needs neither). **A new additive
      `locations` column must also be added to `LocationRepository`'s explicit `SELECT_WITH_COUNT`** (and any new
      `items` column to `ItemRepository`'s explicit read lists). (A device-local UI toggle/preference belongs in
      `usePreferencesStore`/`useLayoutStore`/a dedicated Zustand `persist` store / `localStorage`; a transient,
      workflow-scoped selection belongs in ephemeral Tier-3 React/Context state.)
- [ ] ⚠️ **Trigger ordering & FTS5:** do **not** `DROP`/`CREATE` the `items` auto-stamp or FTS triggers. For a
      quantity-like derived projection, copy the v13/v15 guarded separate-table recompute pattern.
- [ ] **Extend `scripts/browser-smoke.mjs`** with any new flows. `SMOKE_BASE` if not on 5173. **Launch the dev
      server in a persistent background process** (Bash `run_in_background`; `Start-Process npm` fails — go via
      `cmd.exe /c "npm run dev"`), and **stop it via its PID** — verify the port is released. Connectivity →
      `page.context().setOffline(…)`; a second device → overwrite `localStorage['gubbins:device-id']` + reload (note
      the Phase-53 step does this near the end — keep new flows **before** it); a custom combobox → open + click
      option. If you add a `src/routes/*` file, run `npx vite build` once before `type-check`. **Vite bundles
      `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })` as a separate module graph** — use
      that exact form.
- [ ] Verify four ways and keep all green: `npm run type-check` (check the exit code), `npm run test:run`
      (`threads`-pool, **1153**), `npm run build` (reporter prints the precache size, no budget), and `npm run
      test:e2e` against a live dev server (the "adds a weighted capability" step can flake on `press('Enter')` —
      re-run once; the Phase-37 deep-scroll step seeds 305 items; the Phase-53 datasheet step does a mid-suite
      reload + device-id swap). **Run `npm run build:extension` only if you touch §9 / `extension/`** (Phase 56 did
      **not**). Then generate the **Phase 57 → 58** handover and hand back the Phase 58 continuation prompt in a raw
      markdown block.
