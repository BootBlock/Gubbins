# PHASE_HANDOVER.md — Phase 53 → Phase 54

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 53 — Backlog (developer-chosen): **the §4 "Unlinked Local File" cross-device degradation** — the one genuinely *unbuilt mandated* §4 spec requirement (the P52 handover flagged it "considered but not picked"). §4 Attachments Option B (Hybrid Pointers) requires that a `LOCAL_POINTER` synced to a *secondary* device, where the literal path is invalid, "gracefully degrade to display an 'Unlinked Local File' placeholder, prompting the user to either supply a new local path for that device or an external URL" and "never attempt to upload or download the heavy file blob". Pre-53 a foreign pointer just showed its dead path under a tooltip. Phase 53 makes a device know *which* device authored a pointer and degrades a foreign one with a re-link / replace-with-URL flow.
**Date:** 2026-06-29
**Status:** ✅ Complete. `npm run type-check` clean (exit 0) · `npm run build` passes (bundle reporter prints **2888.21 KiB across 28 precache files, no budget — informational only**) · **1091/1091 unit tests pass** (was 1074 in the Phase-52 handover; Phase 53 added **+17**: `attachment-link.test.ts` +5, `device-id.test.ts` +5, `v18-attachment-origin-device.test.ts` +4, `AttachmentRepository.test.ts` +3) across **110 test files** (**+3** new files) on the **`threads`** pool, ~4 s · **91/91 browser-smoke steps pass** (**+3** vs the recorded 88 — the entering baseline measured 88, +1 new Phase-53 step → the harness reported 91; zero console/page errors). **Schema migration: additive v18 `item_attachments.origin_device_id` → `user_version` now 18** (first bump since Phase 30's v17). **No dependency change.** **`build:extension` NOT re-run** (this phase touched no §9 / `extension/` code — it is entirely PWA-side).

> ⚠️ **Smoke flake reminder:** the long-standing intermittent **"adds a weighted capability"** `press('Enter')` flake did **not** fire this phase (passed on the only full run), but it remains documented — **re-run once** before investigating a smoke red. The Phase-37 deep-scroll step seeds 305 items and can take a few seconds. The new Phase-53 datasheet step does a full `page.reload()` mid-suite (to simulate a second device) and then re-opens the item — it relies on OPFS persisting across the reload (it does).

> ⚠️ **Node-25 cold-start unit flake reminder:** the full `npm run test:run` wrapper (`scripts/run-unit-tests.mjs`) auto-recovers the `Cannot read properties of undefined (reading 'config')` fingerprint; it did **not** fire this phase. A bare `npx vitest run <file>` lacks the wrapper — re-run it by hand if it hits the flake.

> ✅ **What shipped (one pick).**
> - **§4 "Unlinked Local File" cross-device degradation.** A `LOCAL_POINTER` datasheet now carries the device that authored it, so a peer can tell a foreign pointer from a local one and degrade it gracefully (§4). The genuine logic is the pure, unit-tested **`resolveAttachmentLink(attachment, currentDeviceId)`** (`src/features/inventory/attachment-link.ts`): `URL` → `{state:'url'}` (valid everywhere); `LOCAL_POINTER` whose `originDeviceId` matches this device (or is a legacy NULL — non-regressive) → `{state:'local'}`; a `LOCAL_POINTER` from another device → `{state:'unlinked'}`. The current device's id is the new pure-ish seam **`getDeviceId`** (`src/lib/env/device-id.ts`): a `crypto.randomUUID()` generated once and persisted **device-local** in `localStorage` under `gubbins:device-id` (injectable `storage` arg for tests; in-memory fallback where storage is absent — mirrors `network.ts`/`install.ts`/`motion.ts`). `AttachmentManager.tsx` renders an unlinked pointer as an "Unlinked Local File" placeholder (warning glyph, the dead path shown for reference under a Tooltip) with two inline actions — **Re-link** (supply a new local path → restamps origin to this device) and **Use URL** (replace with a validated external URL → clears origin) — both routed through `AttachmentRepository.update`, extended this phase to switch `kind` and restamp `origin_device_id`.
> - **Persistence:** additive **v18** `item_attachments.origin_device_id TEXT` (nullable; NOT an FK — a device id is a synthetic identity). It SHOULD sync (the receiving device needs the origin to compare), so it is deliberately *not* in `SYNC_EXCLUDED_COLUMNS`; `item_attachments` is already in `SYNC_TABLES` and the LWW schema dictionary reads columns live via `PRAGMA table_info`, so it round-trips with no further registration. No `FK_REFS` entry, no `applyPlan`/`LocationRepository.delete` null-out (it references no row).
> - **Deferred (not dropped):** every remaining open item is still a conditional/YAGNI Backlog entry with **no live trigger** (multi-scrape UI tray, true NTP/cross-origin time source, leaner/precache-excluded WASM decoder, live distributor selector maintenance, further `aria-live`). The §4 "Unlinked Local File" item — the last *mandated* spec gap — is now **retired**. Tracked in `docs/todo/deferred-features.md` (roadmap row 53 ✅).

> Protocol Alpha (§8.1.2): the incoming Phase 54 agent **must** read both the master specification
> (`docs/todo/_specification.md`) and this document before writing any code, and must reuse the established
> Repository/driver, 3-tier state, Foundry, icon-registry and testing patterns rather than inventing new ones.
> **The spec's numbered phases end at Phase 9; Phases 10+ are consolidation phases delivering the explicitly
> *deferred-not-dropped* work in `docs/todo/deferred-features.md`.** As of Phase 53 **every enumerated consolidation
> phase (10–16) is complete, the developer-chosen Backlog items so far (P17–P53) are cleared, and the last
> *mandated* spec gap (§4 "Unlinked Local File") is closed.** **No remaining open item is a mandated spec
> requirement** — they are all purely-conditional / YAGNI Backlog entries with **no live trigger today, and there is
> no remaining "closest sibling" continuation of any kind.** Confirm the Phase-54 scope with the developer before
> starting (see §9).

---

## 1. Locked decisions & toolchain (spec §1.2 — binding, restated)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` — official build, FTS5 + **OPFS VFS** (`opfs`; the file at `/gubbins.sqlite3` **is** the raw DB). FTS5 verified at boot via `probeFts5`. |
| Package manager | **npm** (only `package-lock.json`) |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + coi-serviceworker COOP/COEP (delivered via the custom `src/sw.ts` injectManifest worker). PWA `registerType: 'autoUpdate'`; the worker calls `skipWaiting`/`clients.claim()`, so new versions auto-activate + auto-reload. |
| Cloud sync | **Provider-agnostic** — strict `CloudProvider` interface; in-memory + File System Access adapters. **Still no provider SDK** in the dep tree. |
| Conflict resolution | Row-level **LWW** + tombstones (§7.2, 180-day TTL, watermark-aware); **Delta-CRDT** gauge replay (§7.3); §7.5 orphan re-parent + cycle rejection + child-FK guard. |
| Extension bridge | **`window.postMessage`** Content-Script bridge (§9). `SCRAPE_ERROR` enum is the Phase-36 seven-member set (`DOM_DRIFT`/`NETWORK_TIMEOUT`/`RATE_LIMITED`/`BLOCKED`/`NOT_FOUND`/`SERVER_ERROR`/`CHALLENGE`); `requestId`-correlated, origin+Zod-validated, silent-drop. **Untouched in Phase 53.** |
| Test runner | **Vitest** · UUIDs via native `crypto.randomUUID()` · formatting via `Intl` · **`test.pool: 'threads'`** (Phase 21) · **`npm run test:run` wraps `vitest run` with a surgical single auto-retry of the Node-25 cold-start flake** (Phase 27 — `scripts/run-unit-tests.mjs`). |
| E2E | **Playwright** (dev-only) driving **system Edge** (`channel: 'msedge'`, no download); a global fake camera so the §6 scanner reaches `STREAM_ACTIVE` headlessly. Connectivity emulated via `page.context().setOffline(…)`. A device identity can be emulated by overwriting `localStorage['gubbins:device-id']` and reloading (Phase 53 datasheet step). |
| Bundle size | **No budget (Phase 44).** `scripts/check-bundle-size.mjs` is an **informational reporter only** — it prints the precache total and exits 0, never warns, never gates. |
| Native-first | Web APIs over NPM bloat (§2.4.3); all behind feature-detection guards. Lists are **virtualised** with a **bounded infinite-query window** (Phase 37), incl. the per-item Activity Log (P52). Scanner: native **BarcodeDetector** → off-thread Web Worker zxing decode on an **adaptive cadence**, narrowable to a **single symbology** (P34); §6.5 haptic + Web-Audio; Continuous queue applies a **batch action** (P50). `Intl` via `makeFormatters`/`useFormatters` (P16); System theme via `matchMedia` (P16). Dialogs **focus-trap** (P38); location sidebar is an **APG `tree`** (P39); global **skip-link + per-screen `<main>`** (P40); **kiosk wake-lock + containment** (P41); silent status via **`LiveRegion`** (P42, incl. form-field errors + offline transition P51); **reduced-motion** honoured (P43); PWA **installable in one tap** (P44); dashboard is a **customisable DnD widget board** (P45) with **user-tunable low-stock thresholds** (P46); search has a **hybrid text syntax** (OR/parens + saved searches, P47/P48). **QR codes hand-rolled** → single labels + batch sheets (P49). **Form controls accessible via the Foundry `FormField`** (P51). **Connectivity surfaced via `useOnlineStatus` + `OfflineIndicator`** (P51). **The immutable Activity Log is viewable per-item via `ActivityLog` + pure `describeHistoryEntry`** (P52). **A foreign `LOCAL_POINTER` datasheet degrades to "Unlinked Local File" via pure `resolveAttachmentLink` + `getDeviceId`** (P53). |
| Base currency / locale | **GBP / en-GB** defaults (§1.2.1), user-configurable end-to-end (Phase 16). |

**Installed majors:** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 · TanStack Router / Query /
Virtual · Zustand 5 · React Hook Form 7 + **Zod 4** · lucide-react · vite-plugin-pwa · react-error-boundary ·
`fflate` · **`@zxing/library` (direct dep)** · happy-dom (test env) + `@testing-library/react`. Node on this
machine: **v25.2.1**.

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build && node scripts/check-bundle-size.mjs`) ·
`npm run type-check` · **`npm run test:run`** (unit/`:memory:`, **1091 tests**, `threads` pool — via the
`scripts/run-unit-tests.mjs` auto-retry wrapper) · `npm run test:e2e` (real-browser smoke; needs a dev server up,
**91 steps**) · `npm run check:bundle` (informational size report only) · `npm run build:extension`. **Local run:**
`run.bat` / `run.ps1`. **Launch the dev server in a persistent background process** (the Bash tool's
`run_in_background` works well; a PowerShell `Start-Job` does **not** survive into a later tool call, and
`Start-Process npm` fails — npm is `npm.cmd`, so go via `Start-Process cmd.exe -ArgumentList '/c','npm run dev'`).
**Stop it via its PID** (`Stop-Process` the owner of the listening port; confirm release via
`Get-NetTCPConnection -LocalPort <port> -State Listen` — the resulting exit-127 "task failed" notice is just the
killed process reporting non-zero, expected). Phase 53's dev server bound **5173** (was free). `$pid` is a
**read-only** PowerShell automatic variable — use a different loop variable. Pass `SMOKE_BASE=http://localhost:<port>/Gubbins/`
if not on 5173.

> ✅ **Node-25 cold-start flake — auto-recovered (Phase 27).** `npm run test:run` re-runs `vitest run` once **only**
> on the exact cold-start fingerprint; a genuine red test still fails immediately. A bare `npx vitest run <file>`
> does **not** have this wrapper — re-run it by hand.

> ⚠️ **`npm run type-check` pipe trap:** `tsc` errors are masked if you pipe through `tail`/`head`. Capture
> `${PIPESTATUS[0]}` (bash) / `"$LASTEXITCODE"` (pwsh) so a real failure isn't hidden by a clean tail.

> ⚠️ **Route-tree generation:** `src/routeTree.gen.ts` is generated by `@tanstack/router-plugin` when **Vite** runs,
> *not* `tsc`. **Phase 53 added NO route** (it edited existing components). If Phase 54 adds a `src/routes/*` file,
> run `npx vite build` once **before** `type-check`.

> ⚠️ **`noUncheckedIndexedAccess` + `noUnusedLocals` are on.** Array/string-index reads widen to `T | undefined`
> (use a justified `!` in a provably-bounded loop); a destructured field you don't use is a hard error.

> ⚠️ **Foundry basename-collision trap (Phase 42):** a pure `.ts` module and a `.tsx` component **must not share a
> basename**. Phase 53 respected this — pure `attachment-link.ts` ≠ component `AttachmentManager.tsx`; `device-id.ts`
> is its own module.

> ⚠️ **Design tokens:** colours/motion come from tokens (`src/styles/index.css`), never raw hex / Tailwind palette
> classes. Phase 53 used the existing **`text-warning`** token for the unlinked glyph (there is no `glyph-warning`
> token — the `--glyph-*` set is danger/success/edit/move/scan/checkout/gauge/neutral; `--warning`/`--color-warning`
> is the warning surface/text token). Prefer a Foundry primitive's `variant` first.

> ⚠️ **Modal "Close" ambiguity (Phase 49 smoke trap):** the Foundry `Modal` renders its own built-in close (X)
> named **"Close"** — a dialog that *also* has a text "Close" button makes `getByRole('button', { name: 'Close' })`
> resolve to two elements. In the smoke close such a dialog with `page.keyboard.press('Escape')` or a `data-testid`.

> ⚠️ **`FormField` accessible-name trap (Phase 51):** render an error's `role="alert"` as a **sibling** of the
> `<label>`, never inside it. Phase 53's inline error `<p role="alert">` lives outside any label.

> ⚠️ **The extension (`extension/`) is bundled by esbuild, NOT type-checked by `tsc -b` and NOT run by Vitest.** Put
> any extension-shared logic in a pure `src/` module and unit-test it there. **Phase 53 did not touch §9 or the
> extension, so `dist/` is unchanged from Phase 36.**

---

## 2. Database schema snapshot — `PRAGMA user_version = 18` (CHANGED this phase)

**Phase 53 added migration v18** — `src/db/migrations/v18-attachment-origin-device.ts`, registered last in
`src/db/migrations/index.ts` (so `TARGET_SCHEMA_VERSION` = 18, derived as the max registered version):

```sql
ALTER TABLE item_attachments ADD COLUMN origin_device_id TEXT;  -- nullable; NOT a foreign key
```

- **Nullable, no backfill** — every pre-v18 row reads as NULL, which `resolveAttachmentLink` treats as `local`
  (non-regressive: a pointer doesn't suddenly degrade on the device that made it).
- **NOT an FK** — a device id references no table row, so there is **no `FK_REFS` entry** and **no
  `applyPlan`/`LocationRepository.delete` null-out** (contrast v14 `source_location_id` / v17 `location_id`, which
  *are* FKs and got those).
- **Syncs** — deliberately *not* added to `SYNC_EXCLUDED_COLUMNS`; `item_attachments` ∈ `SYNC_TABLES` and the schema
  dictionary (`buildSchemaDictionary`) reads columns live via `PRAGMA table_info`, so it round-trips by LWW with no
  further wiring. The snapshot reader uses `SELECT *`, so backup/restore carries it too.

All earlier seams are exactly as left: v17 `maintenance_schedules.location_id`; v16 `checkouts.source_batch_key`;
v15 `stock_batches` + the three-level guarded recompute triggers; v14 `checkouts.source_location_id`; v13
`item_stock`; v12 `received_qty`; v11 `accrue_checkout_hours` + the M:N/leaf/`item_history`/`item_images` sync-set
expansion; v10 history watermark; the variant CTE guard; vault/archive seams; In-Transit/usage derived projections;
formatter/theme seams; the bounded-list `maxPages` window; kiosk (P41); `LiveRegion`/`liveRegionAttrs` (P42);
reduced-motion (P43); install-prompt (P44); dashboard-layout + `listLowStock` (P45); low-stock thresholds (P46);
text-search parser + reducer `load` (P47); OR/parens parser + `useSavedSearchesStore` (P48); QR/printable batch
(P49); Continuous-Mode batch-action (P50); `FormField`/`fieldAria` + `useOnlineStatus`/`OfflineIndicator` + gauge
`clampNetValue`/`refill*` (P51); `describeHistoryEntry`/`historyActionLabel` + bounded `useItemHistory` (P52).
**The `items` auto-stamp + FTS triggers remain untouched.**

---

## 3. What shipped in Phase 53 (one pick; additive v18 migration)

### 3.1 Migration — `v18-attachment-origin-device`
`src/db/migrations/v18-attachment-origin-device.ts` (+ `.test.ts`, +4): the nullable `origin_device_id` column. The
test asserts it reaches ≥18, registers v18 last, is nullable with NULL default, defaults NULL for a legacy row, and
accepts an arbitrary string (proving it's not an FK).

### 3.2 Pure seams — `getDeviceId` and `resolveAttachmentLink`
- `src/lib/env/device-id.ts` (+ `.test.ts`, +5): `getDeviceId(storage?)` returns a stable per-device id, generating
  + persisting a `crypto.randomUUID()` in `localStorage['gubbins:device-id']` (`DEVICE_ID_KEY`), with an injectable
  `storage` arg and a process-stable in-memory fallback when storage is unavailable. No React/DOM beyond storage.
- `src/features/inventory/attachment-link.ts` (+ `.test.ts`, +5): `resolveAttachmentLink(attachment, currentDeviceId)`
  → `{ state: 'url' | 'local' | 'unlinked'; value }`. Pure; the only place the foreign/local decision lives.

### 3.3 Repository / types / mappers
`AttachmentRepository.add` stamps `origin_device_id` for a `LOCAL_POINTER` (null for a URL); `update` now also
switches `kind` (validating the value against the *new* kind — the replace-with-URL path) and restamps
`origin_device_id` (`UpdateAttachmentInput` gained `kind?` + `originDeviceId?`). `CreateAttachmentInput` gained
`originDeviceId?`. `ItemAttachmentRow`/`ItemAttachment` gained `origin_device_id`/`originDeviceId`; `rowToItemAttachment`
maps it. (`AttachmentKind` is imported from `./constants`, not `./types`.) `AttachmentRepository.test.ts` +3.

### 3.4 UI — `AttachmentManager`
`src/features/inventory/components/AttachmentManager.tsx`: each row routes through `resolveAttachmentLink(att,
getDeviceId())`; an `unlinked` row renders the **"Unlinked Local File"** placeholder (`data-testid="attachment-unlinked"`,
`UnlinkIcon` in the registry, the dead path under a Tooltip) with **Re-link** (`attachment-relink` → input
`attachment-relink-input` → `attachment-relink-confirm`, restamps origin to this device) and **Use URL**
(`attachment-use-url` → same input/confirm, switches kind to `URL`, clears origin). `url`/`local` rows render exactly
as before (anchor / path+Tooltip). `add` stamps the origin for a new local pointer.

### 3.5 No dependency change; extension untouched
No `package.json` change. **`build:extension` NOT re-run** (no §9 / `extension/` edit).

---

## 4. Testing (TDD-first) — what's new and reusable (1091; smoke 91)

- **`src/features/inventory/attachment-link.test.ts`** (+5): URL linked everywhere; local pointer linked on its
  origin device; foreign pointer → unlinked; legacy NULL-origin → local (non-regressive); value passthrough.
- **`src/lib/env/device-id.test.ts`** (+5): generates + persists a stable id; same id on repeat; distinct storages
  are distinct devices; reuses a pre-persisted id; non-empty memoised fallback with no storage.
- **`src/db/migrations/v18-attachment-origin-device.test.ts`** (+4): version ≥18 + registered last; nullable column;
  NULL default for a legacy row; arbitrary device id accepted (not an FK).
- **`src/db/repositories/AttachmentRepository.test.ts`** (+3): stamps origin on a local pointer / null for a URL;
  re-links a foreign pointer to this device; replaces a local pointer with a validated URL (and rejects an invalid
  one on the kind switch).
- **Established TDD seams unchanged:** `createMemoryDriver()` `:memory:` + `IDatabaseDriver` DI (§8.5); the Repository
  pattern; **pure helpers extracted out of glue** (`attachment-link.ts` / `device-id.ts` join `history-format.ts` /
  `field-aria.ts` / `network.ts` / `gauge.ts` / `list-window.ts`); injectable seams. The `AttachmentManager` re-link
  *view* is thin DOM glue over the pure resolver + the device-id seam, so it is covered by the pure tests + the
  browser smoke (real OPFS attachment + a simulated second device) rather than a contrived component test.
- **Smoke (+1 → 91):** "degrades a foreign local-pointer datasheet to 'Unlinked Local File' (§4, Phase 53)" — enables
  Hybrid mode in Settings (reached from the dashboard root — the Inventory screen has no Settings gear), links a
  `LOCAL_POINTER` on the printer item (stamped this device), overwrites `localStorage['gubbins:device-id']` and
  reloads (a simulated second device), re-opens the item to assert the `attachment-unlinked` placeholder, then uses
  **Use URL** to replace it and asserts the placeholder detaches and a working link appears.

---

## 5. Files touched (orientation map)

- **New migration:** `src/db/migrations/v18-attachment-origin-device.ts` (+ `.test.ts`); registered in
  `src/db/migrations/index.ts`.
- **New pure seams:** `src/lib/env/device-id.ts` (+ `.test.ts`); `src/features/inventory/attachment-link.ts`
  (+ `.test.ts`).
- **Edits:** `src/db/repositories/AttachmentRepository.ts` (`add` stamps origin; `update` switches kind + restamps;
  import `AttachmentKind` from `./constants`); `src/db/repositories/types.ts` (`origin_device_id`/`originDeviceId` on
  row/entity, `originDeviceId?` on create); `src/db/repositories/mappers.ts` (`rowToItemAttachment`);
  `src/db/repositories/AttachmentRepository.test.ts` (+3); `src/components/icons/index.ts` (`Unlink as UnlinkIcon`);
  `src/features/inventory/components/AttachmentManager.tsx` (resolve + render + re-link/replace flow).
- **Smoke:** `scripts/browser-smoke.mjs` (one new step before the Phase-4 flows section).
- **Docs:** `docs/todo/deferred-features.md` (roadmap row 53 ✅ + Backlog "Retired in P53" note) and this file.
- **Unchanged:** every other migration; `protocol.ts` / `scrape-errors.ts` / the whole §9 path; the extension
  `dist/*`; `package.json`; `vite.config.ts`; the flake-retry runner; `parseASTtoSQL.ts`; the text-search /
  saved-search seams; the QR/printable seams; the scanner queue/cadence/symbology + batch-actions seams; the
  dashboard grid/registry; the kiosk / focus-trap / tree-keyboard seams; `feature-detection.ts`; the service worker;
  the P51 `FormField`/offline/gauge seams; the P52 `history-format.ts` / `ActivityLog.tsx`; the sync engine
  (`origin_device_id` flows through it automatically via the live schema dictionary).

---

## 6. The companion extension (`extension/`) — UNCHANGED in Phase 53

Phase 53 touched no §9 protocol and no `extension/` source, so `extension/dist/*` is exactly as Phase 36 left it
(the seven-member `SCRAPE_ERROR` enum incl. `CHALLENGE`, `detectChallengePage` in `dist/content-script.js`). No
`build:extension` re-run was needed.

---

## 7. Technical debt, stubs & deferrals

> Tracked in `docs/todo/deferred-features.md` — kept current. **Phase 53's roadmap row is ticked; the §4
> "Unlinked Local File" item — the last *mandated* spec gap — is now RETIRED.**

**Remaining Backlog (all triggered conditionals — none has a live trigger today):** multi-scrape UI tray (trigger: a
real concurrent-scrape entry-point, e.g. bulk BOM ingress); live distributor selector maintenance (trigger: a real
scrape against a live supplier failing); true NTP / cross-origin time source (trigger: same-origin `Date` proves
insufficient); leaner / precache-excluded WASM decoder (the ~442 KiB zxing scanner-fallback worker is ~15% of the
precache — excluding it sacrifices *offline* fallback scanning; **no size gate forces it since the P44 budget
removal**); further `aria-live` coverage (the silent surfaces are all done — any *new* region needs a genuinely
silent in-place status surface). **No remaining open item is a *mandated* spec requirement, and there is no "closest
sibling" continuation of any kind.**

**Carried LWW-class limitation (not a Phase-53 change):** concurrent location-delete vs. offline stock edit — an
additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until the next
reconcile (accepted, parallel to §7.5.2).

**Carried attachment note (Phase 53 design choice, not debt):** a *legacy* pre-v18 `LOCAL_POINTER` (NULL origin) is
treated as `local` on every device — it cannot be attributed, so it keeps its prior behaviour rather than all such
pointers degrading. Only pointers created/relinked from Phase 53 onward carry an origin and degrade correctly. This
is the deliberate non-regressive trade-off.

> **Working-tree note (carried, not a Phase-53 change):** the Phase 10–53 work is present in the working tree but the
> only commit on `phase-9-lifecycle` is "Phase 9". Committing/branching is the developer's call — no phase agent has
> committed since.

---

## 8. Live consolidation roadmap (post-Phase-53)

**Every enumerated consolidation phase (10–16) is complete**, the developer-chosen Backlog items so far (P17–P53)
are cleared, and the last *mandated* spec gap (§4 "Unlinked Local File") is now closed. No spec-numbered or
roadmap-enumerated phase remains; the scanner/perf, §9 scraping, a11y, kiosk, PWA-installability,
customisable-dashboard, advanced-search, printable-QR, Continuous-Mode, the Phase-51 trio, the Phase-52 Activity Log
and now the Phase-53 attachment degradation have all exhausted their named work; **no remaining Backlog item has a
concrete trigger today**, and **no remaining open item is a *mandated* spec requirement.** Phase 54 is therefore
another **developer-chosen Backlog / polish** phase (or, if the developer prefers, a no-op until a trigger fires).
**There is no remaining "closest sibling" continuation of any kind.** Candidates remain the unrelated conditional
Backlog entries (multi-scrape UI tray; live distributor selector maintenance; a true NTP source; a
leaner/precache-excluded WASM decoder; further `aria-live`), or a fresh investigation pick like Phases 37–53 were.

---

## 9. Phase 54 entry checklist

- [ ] Read the master spec **and** this handover; restate the locked decisions.
- [ ] **Confirm Phase-54 scope with the developer first** — no enumerated phase remains, no Backlog item has a live
      trigger, and no remaining open item is a *mandated* spec requirement; pick one deliberately, propose a fresh
      investigation (as Phases 37–53 were), or agree there's nothing to land yet. **There is no "closest sibling"
      residual — choose consciously.**
- [ ] **Reuse, don't reinvent:** the Repository/driver + `createMemoryDriver()` test path; 3-tier state; the Foundry
      primitives & **Tooltip (not `title`)** + **Toast** + the **focus-trapping Modal** (built-in **"Close"** can
      collide with a feature "Close") + the **APG-tree LocationSidebar** + the **`SkipLink` (+ `MAIN_CONTENT_ID`)** +
      the **`LiveRegion` (+ pure `liveRegionAttrs`)** + the **`FormField` (+ pure `fieldAria`)** + the
      **`useReducedMotion`/`useInstallPrompt`/`useWakeLock`/`useOnlineStatus` injectable-seam hooks** (the
      `apiOverride` pattern + a pure `lib/env/*` probe — incl. the new **`getDeviceId`**); icons via the registry;
      RHF + Zod; **the `makeFormatters` factory + `useFormatters()` hook**; the `resolveTheme`/`applyTheme` seam; the
      export vault + archive seams; the recursive-ancestor-CTE cycle guard; **the "derive a projection from the SSOT,
      never a stored counter" seam**; **the cycle-count / partial-receipt / per-location-stock / batch seams**; **the
      off-thread scanner + adaptive-cadence + symbology seams**; **the §9 scraping seam**; **the bounded-list seam**
      (`list-window.ts` + `MAX_LIST_PAGES`, also driving the Activity Log view); **the focus-trap / tree-keyboard /
      dashboard-layout seams**; **the text-search + saved-search seams** (`parseASTtoSQL` is the single SQL
      translator — never hand-build SQL from text); **the QR/printable + Continuous-Mode batch-action seams**; **the
      P52 `describeHistoryEntry`/`historyActionLabel` formatter**; **and the new P53 `resolveAttachmentLink` +
      `getDeviceId` seams** for any future per-device / attachment surface. **The bundle check no longer enforces a
      budget.**
- [ ] **TDD-first over `createMemoryDriver()`** (Protocol Beta) for any logic; keep pure helpers pure, and use an
      **injectable dependency seam** for hard-to-unit-test glue. **For anything that runs in the extension, put the
      logic in a pure `src/` module and unit-test it there.** **Don't invent a contrived pure module for thin DOM
      glue** — a `@testing-library/react` component/hook test (or the browser smoke for pointer/camera/network glue)
      is the right tool. **Don't share a basename between a pure `.ts` and a component `.tsx`** (P42). **A control
      inside an existing `<form>` must not be its own `<form>`** (P48). **Render a field's `role="alert"` error as a
      sibling of the `<label>`** (P51). **In the smoke, close a Modal with Escape or a `data-testid`** (P49).
      **`noUnusedLocals` is on.** **Use design tokens, never raw colour/motion values.**
- [ ] **A schema migration is only needed if you add persistent bookkeeping** — register the next migration in
      `src/db/migrations/index.ts`, bump `user_version` past **18**, and add a migration test (additive pattern
      `v9`…`v18`; **narrow a prior per-version test only if it asserts an exact version** — note `engine.test.ts`
      asserts `TARGET_SCHEMA_VERSION` (derived) and the per-version tests use `>=`, so neither needs touching for an
      additive bump). Phase 53 left `user_version = 18`. A column on a `SYNC_TABLES` table auto-joins the LWW payload
      — add it to `SYNC_EXCLUDED_COLUMNS` if device-local; **a new synced FK column needs an `FK_REFS` entry** +
      `applyPlan`/`LocationRepository.delete` null-out/re-home (a non-FK synthetic id like `origin_device_id` needs
      neither). (A device-local UI toggle/preference/list belongs in `usePreferencesStore`/`useLayoutStore`/a
      dedicated Zustand `persist` store / `localStorage`; a transient, workflow-scoped selection belongs in
      **ephemeral Tier-3 React/Context state**.)
- [ ] ⚠️ **Trigger ordering & FTS5:** do **not** `DROP`/`CREATE` the `items` auto-stamp or FTS triggers. For a
      quantity-like derived projection, copy the v13/v15 guarded separate-table recompute pattern.
- [ ] **Extend `scripts/browser-smoke.mjs`** with any new flows. `SMOKE_BASE` if not on 5173. **Launch the dev server
      in a persistent background process** (Bash `run_in_background`; `Start-Job` is killed when the spawning pwsh
      tool call returns; `Start-Process npm` fails — go via `cmd.exe /c "npm run dev"`), and **stop it via its PID** —
      verify the port is released. Connectivity → `page.context().setOffline(…)`; a second device → overwrite
      `localStorage['gubbins:device-id']` + reload. If you add a `src/routes/*` file, run `npx vite build` once before
      `type-check`. **Vite bundles `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })` as a
      separate module graph** — use that exact form.
- [ ] Verify four ways and keep all green: `npm run type-check` (check the exit code), `npm run test:run`
      (`threads`-pool, **1091**), `npm run build` (reporter prints the precache size, no budget), and `npm run
      test:e2e` against a live dev server (the "adds a weighted capability" step can flake on `press('Enter')` —
      re-run once; the Phase-37 deep-scroll step seeds 305 items; the Phase-53 datasheet step does a mid-suite
      reload). **Run `npm run build:extension` only if you touch §9 / `extension/`** (Phase 53 did **not**). Then
      generate the **Phase 54 → 55** handover and hand back the Phase 55 continuation prompt in a raw markdown block.
