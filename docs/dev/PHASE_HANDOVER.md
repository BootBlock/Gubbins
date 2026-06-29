# PHASE_HANDOVER.md — Phase 57 → Phase 58

**Project:** Gubbins — local-first inventory tracking PWA
**Phase completed:** Phase 57 — Backlog (developer-chosen, fresh investigation): **made the §6.5 scanner feedback user-mutable** — the Web-Audio **beep** + `navigator.vibrate` **haptic** confirmation fired on *every* successful scan and was completely unconfigurable; it is now two independent On/Off Tier-2 preferences (`scannerBeep`/`scannerHaptics`, default on).
**Date:** 2026-06-29
**Status:** ✅ Complete. `npm run type-check` clean (exit 0) · `npm run build` passes (bundle reporter prints **2940.99 KiB across 32 precache files, no budget — informational only**) · **1159/1159 unit tests pass** across **118 test files** on the **`threads`** pool, ~4 s · **94/94 browser-smoke steps pass** (incl. one new step: toggle + persist the beep/haptic preferences; the first smoke run flaked **2** steps on the documented "adds a weighted capability" `press('Enter')` / element-stability flake and went **94/94** on re-run; zero console/page errors). **No schema migration — `user_version` stays 19.** **No dependency change.** **`build:extension` NOT re-run** (no §9 / `extension/` edit).

> ℹ️ **Scope decision (recorded for the next agent):** Phase 57 entered with **no pre-assigned slice** — every open item in `docs/dev/deferred-features.md` is a purely-conditional / YAGNI Backlog entry with **no live trigger**. A fresh-investigation audit confirmed the app is **essentially spec-complete** (composite assemblies, BOM costing toggle, reservation/procurement states, all §3 dashboard widgets, the CRITICAL no-overwrite scrape merge, the circular **and** linear gauge, KiCad-ish CSV BOM columns, the Export Wizard "remember last-used", and the §6.5 beep+haptic were all already built). The audit's first candidate was a **KiCad XML intermediate-netlist** importer; the developer correctly flagged it as **YAGNI** (KiCad 6/7/8 export BOMs as CSV directly, which `bom-import.ts` already maps, so an `.xml` netlist parser serves a hypothetical with no trigger) and it was **consciously deferred** to the Backlog (never dropped). The chosen pick — making the always-on §6.5 feedback mutable — fixes a concrete present-day annoyance instead.

> ⚠️ **Smoke flake reminder:** the long-standing intermittent **"adds a weighted capability"** `press('Enter')` flake (sometimes manifesting as "element is not stable / detached from the DOM" retries) **did** fire on the first Phase-57 run (2 steps red) and cleared on re-run → **94/94**. **Re-run once** before investigating a smoke red. The Phase-37 deep-scroll step seeds 305 items; the Phase-53 datasheet step does a full `page.reload()` mid-suite + overwrites `localStorage['gubbins:device-id']` to `smoke-other-device` — keep any new pre-Phase-53 flow before it (the new Phase-57 step sits in the §6.6/§6.5 Settings cluster, well before the Phase-53 step).

> ⚠️ **Node-25 cold-start unit flake reminder:** the full `npm run test:run` wrapper (`scripts/run-unit-tests.mjs`) auto-recovers the `Cannot read properties of undefined (reading 'config')` fingerprint; it did **not** fire this phase. A bare `npx vitest run <file>` lacks the wrapper — re-run it by hand if it hits the flake.

> ✅ **What shipped (one pick, no migration).**
> - **Made the §6.5 non-visual scan confirmation user-mutable.** `ScanFeedback.confirm()` previously *always* called `this.beep()` (Web Audio) **and** `this.vibrate(200)` (`navigator.vibrate`) on every successful scan, with **no toggle anywhere** in the app — a real annoyance in quiet/shared workshops or for users with a sensory preference. `confirm()` now accepts `{ beep?: boolean; haptics?: boolean }` (both default **true** — never a regression) and gates each channel.
> - **Two boolean Tier-2 preferences.** `usePreferencesStore` gained `scannerBeep` / `scannerHaptics` (default `true`) + `setScannerBeep` / `setScannerHaptics`. Booleans need no normalisation, so these mirror the existing `kioskMode`/`setKioskMode` shape exactly — **deliberately no contrived pure module** (the handover's "don't invent a pure seam for thin glue" rule; the gating logic that *does* warrant a test lives in `ScanFeedback.confirm`).
> - **Wiring.** `ScannerOverlay` reads both flags via selectors and threads `{ beep, haptics }` through **both** `feedback.current.confirm(...)` call sites (Discrete + Continuous), with the two flags added to the `handleDecode` `useCallback` deps so a mid-session settings change is honoured.
> - **Settings UI.** Two **On/Off** `Select` controls — "Beep on scan" (`data-testid="setting-scanner-beep"`) and "Vibrate on scan" (`data-testid="setting-scanner-haptics"`) — added to the **existing "Scanner"** `SettingsSection`, beside the Phase-34 symbology control.
> - **Tests:** new `src/features/scanner/feedback.test.ts` (+4) asserts `confirm` gating by spying on the browser-only `beep`/`vibrate` members (no real `AudioContext` / `navigator.vibrate` needed). Smoke: one new step toggles both controls off, asserts `gubbins:preferences` persists `scannerBeep:false`/`scannerHaptics:false`, then restores the defaults so later scan steps are unaffected. Step count **93 → 94**; unit **1153 → 1159 / 117 → 118 files** (the +6/+1 also reflects test counts that had drifted slightly above the prior-handover figure — all green).
> - **Deferred (not dropped):** the KiCad-XML-netlist importer is now a tracked Backlog entry (consciously YAGNI). Every other open item remains a conditional/YAGNI Backlog entry with **no live trigger** (multi-scrape UI tray, true NTP/cross-origin time source, leaner/precache-excluded WASM decoder, live distributor selector maintenance, further `aria-live`). **No mandated spec gap remains and there is no "closest sibling" continuation.** Tracked in `docs/dev/deferred-features.md` (Phase-57 row + Backlog).

> Protocol Alpha (§8.1.2): the incoming Phase 58 agent **must** read both the master specification
> (`docs/todo/done/_specification.md`) and this document before writing any code, and must reuse the established
> Repository/driver, 3-tier state, Foundry, icon-registry and testing patterns rather than inventing new ones.
> **The spec's numbered phases end at Phase 9; Phases 10+ are consolidation phases delivering the explicitly
> *deferred-not-dropped* work in `docs/dev/deferred-features.md`.** As of Phase 57 **every enumerated consolidation
> phase (10–16) is complete, the developer-chosen Backlog items so far (P17–P56) are cleared, the last *mandated*
> spec gap (§4 "Unlinked Local File", P53) is closed, P54/P55 finished the location-colour story, P56 surfaced the
> §4.1.1 operational-metadata layer, and P57 made the §6.5 scanner feedback mutable.** **No remaining open item is a
> mandated spec requirement** — they are all purely-conditional / YAGNI Backlog entries with **no live trigger today,
> and there is no remaining "closest sibling" continuation of any kind.** Confirm the Phase-58 scope with the
> developer before starting (see §9).

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
| Native-first | Web APIs over NPM bloat (§2.4.3); all behind feature-detection guards. Lists are **virtualised** with a **bounded infinite-query window** (P37/P52). Scanner: native **BarcodeDetector** → off-thread Web Worker zxing decode on an **adaptive cadence**, narrowable to a **single symbology** (P34), with a main-thread-capture tier for Safari < 16.4 (P33); the §6.5 **beep + haptic confirmation is now user-mutable** (P57). `Intl` via `makeFormatters`/`useFormatters` (P16); System theme via `matchMedia` (P16). Dialogs **focus-trap** (P38); location sidebar is an **APG `tree`** (P39); global **skip-link + per-screen `<main>`** (P40); **kiosk wake-lock + containment** (P41); silent status via **`LiveRegion`** (P42, incl. form-field errors + offline transition P51); **reduced-motion** honoured (P43); PWA **installable in one tap** (P44); dashboard is a **customisable DnD widget board** (P45) with **user-tunable low-stock thresholds** (P46); search has a **hybrid text syntax** (OR/parens + saved searches, P47/P48). **QR codes hand-rolled** → single labels + batch sheets (P49). **Continuous-Mode batch actions** (P50). **Accessible form controls via Foundry `FormField`** (P51). **Connectivity via `useOnlineStatus` + `OfflineIndicator`** (P51). **Per-item Activity Log via `ActivityLog` + pure `describeHistoryEntry`** (P52). **Foreign `LOCAL_POINTER` degrades via `resolveAttachmentLink` + `getDeviceId`** (P53). **Locations carry a description + colour swatch** (P54); **every location surface — incl. the Add Item picker (P55) — renders the swatch** via `LocationSelect` + `location-color.ts`. **§4.1.1 operational metadata edited via `OperationalMetadataEditor` + pure `operational-metadata.ts`** (P56). |
| Base currency / locale | **GBP / en-GB** defaults (§1.2.1), user-configurable end-to-end (P16). |

**Installed majors:** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 · TanStack Router / Query /
Virtual · Zustand 5 · React Hook Form 7 + **Zod 4** · lucide-react · vite-plugin-pwa · react-error-boundary ·
`fflate` · **`@zxing/library` (direct dep)** · happy-dom (test env) + `@testing-library/react`. Node on this
machine: **v25.2.1**.

**Commands:** `npm run dev` · `npm run build` (`tsc -b && vite build && node scripts/check-bundle-size.mjs`) ·
`npm run type-check` · **`npm run test:run`** (unit/`:memory:`, **1159 tests**, `threads` pool — via the
`scripts/run-unit-tests.mjs` auto-retry wrapper) · `npm run test:e2e` (real-browser smoke; needs a dev server up,
**94 steps**) · `npm run check:bundle` (informational size report only) · `npm run build:extension`. **Local run:**
`run.bat` / `run.ps1`. **Launch the dev server in a persistent background process** (the Bash tool's
`run_in_background` works well; a PowerShell `Start-Job` does **not** survive into a later tool call, and
`Start-Process npm` fails — npm is `npm.cmd`, so go via `Start-Process cmd.exe -ArgumentList '/c','npm run dev'`).
**Stop it via its PID** (`Stop-Process` the owner of the listening port; confirm release via
`Get-NetTCPConnection -LocalPort <port> -State Listen`). Phase 57's dev server fell back to **5174** (5173 was in
use); pass `SMOKE_BASE=http://localhost:<port>/Gubbins/` when it isn't on 5173. `$pid` is a **read-only** PowerShell
automatic variable — use a different loop variable.

> ⚠️ **`npm run type-check` pipe trap:** `tsc` errors are masked if you pipe through `tail`/`head`. Capture
> `${PIPESTATUS[0]}` (bash) / `"$LASTEXITCODE"` (pwsh).

> ⚠️ **Route-tree generation:** `src/routeTree.gen.ts` is generated by `@tanstack/router-plugin` when **Vite** runs,
> *not* `tsc`. **Phase 57 added NO route** (it edited `feedback.ts` + `usePreferencesStore.ts` + `ScannerOverlay.tsx`
> + `SettingsScreen.tsx`, added `feedback.test.ts`, and edited the smoke). If Phase 58 adds a `src/routes/*` file,
> run `npx vite build` once **before** `type-check`.

> ⚠️ **`noUncheckedIndexedAccess` + `noUnusedLocals` are on.** A destructured/imported symbol you don't use is a
> hard error.

> ⚠️ **Foundry basename-collision trap (P42):** a pure `.ts` module and a `.tsx` component **must not share a
> basename**. (Still true: pure `operational-metadata.ts` vs component `OperationalMetadataEditor.tsx`.)

> ⚠️ **`FormField` can't name a custom combobox (P55):** name a `div[role="combobox"]` like `LocationSelect` via a
> sibling `<span id>` + the control's `labelledBy`/`aria-labelledby`, and render any error as a `role="alert"`
> **sibling** (P51).

> ⚠️ **`ItemDetailDialog` is tabbed (P56):** a detail facet is only in the DOM when its tab is active, so any
> smoke/component test must `getByRole('tab', { name }).click()` first; **two section editors can share a button
> label** (CustomFields + operational-metadata both render "Saved") → scope by `data-testid`.

> ⚠️ **Design tokens:** colours/motion come from tokens (`src/styles/index.css`), never raw hex / Tailwind palette
> classes. Location swatches are **semantic keys** (`'teal'`) → `text-loc-*`/`bg-loc-*` tokens via the **static
> literal** maps in `features/inventory/location-color.ts`. There is **no `glyph-warning` token** — use `text-warning`.

> ⚠️ **Modal "Close" ambiguity (P49 smoke trap):** the Foundry `Modal` renders its own built-in close (X) named
> **"Close"** — a dialog that *also* has a text "Close" button makes `getByRole('button', { name: 'Close' })`
> resolve to two elements. In the smoke close such a dialog with `page.keyboard.press('Escape')` or a `data-testid`.

> ⚠️ **The extension (`extension/`) is bundled by esbuild, NOT type-checked by `tsc -b` and NOT run by Vitest.** Put
> any extension-shared logic in a pure `src/` module and unit-test it there. **`dist/` is unchanged since P36.**

---

## 2. Database schema snapshot — `PRAGMA user_version = 19` (UNCHANGED this phase)

**Phase 57 added no migration** (it is a device-local Tier-2 preference change — no persistent bookkeeping). The
registry (`src/db/migrations/index.ts`) ends at **v19** (`v19-location-description-color`, Phase 54): additive
nullable `locations.description TEXT` + `locations.color TEXT` (`TARGET_SCHEMA_VERSION` = 19, derived as the max
registered version).

⚠️ **`LocationRepository`'s `SELECT_WITH_COUNT` still lists columns explicitly**, so any *future* additive `locations`
column must be added there too (`getById` uses `SELECT *`). `ItemRepository` reads items with explicit column lists
too — any future additive `items` read column must be added to those lists.

All earlier seams are exactly as left: `items.operational_metadata` (pre-existing v2 JSON column, now read as a
top-level `Item.operationalMetadata` for all rows, P56); v18 `item_attachments.origin_device_id` (non-FK, synced;
P53); v17 `maintenance_schedules.location_id`; v16 `checkouts.source_batch_key`; v15 `stock_batches` + the
three-level guarded recompute triggers; v14 `checkouts.source_location_id`; v13 `item_stock`; v12 `received_qty`;
v11 `accrue_checkout_hours` + the M:N/leaf/`item_history`/`item_images` sync-set expansion; v10 history watermark;
the variant CTE guard; vault/archive seams; In-Transit/usage derived projections; formatter/theme seams; the
bounded-list `maxPages` window; kiosk (P41); `LiveRegion`/`liveRegionAttrs` (P42); reduced-motion (P43);
install-prompt (P44); dashboard-layout + `listLowStock` (P45); low-stock thresholds (P46); text-search parser +
reducer `load` (P47); OR/parens parser + `useSavedSearchesStore` (P48); QR/printable batch (P49); Continuous-Mode
batch-action (P50); `FormField`/`fieldAria` + `useOnlineStatus`/`OfflineIndicator` + gauge `clampNetValue`/`refill*`
(P51); `describeHistoryEntry`/`historyActionLabel` + bounded `useItemHistory` (P52); `resolveAttachmentLink`/
`getDeviceId` (P53); `location-color.ts` + `Textarea` + `ColorSwatchPicker` (P54); `LocationSelect`-via-`Controller`/
`labelledBy` (P55); `operational-metadata.ts` + tabbed `ItemDetailDialog`/`tab-keyboard.ts` (P56). **The `items`
auto-stamp + FTS triggers remain untouched.**

---

## 3. What shipped in Phase 57 (one pick; no migration)

### 3.1 `ScanFeedback.confirm` is now gated by per-call flags
`src/features/scanner/feedback.ts`: `confirm()` → `confirm({ beep = true, haptics = true } = {})` — it calls
`this.beep()` only when `beep`, and `this.vibrate(200)` only when `haptics`. Both default `true`, so an unsupplied
call is identical to the old always-fire behaviour. `prime()`/`beep()`/`vibrate()`/`dispose()` are unchanged.

### 3.2 Two boolean Tier-2 preferences
`src/state/stores/usePreferencesStore.ts`: added `scannerBeep: boolean` / `scannerHaptics: boolean` (default
`true`) to the interface + initial state, and `setScannerBeep` / `setScannerHaptics` setters (`set({ scannerBeep })`
— booleans need no clamp/normalise, mirroring `kioskMode`). Persisted device-local under the existing
`gubbins:preferences` key (auto-joins the same store). **No pure module** — the only logic worth testing is the
`confirm` gating, which is tested directly on the class.

### 3.3 `ScannerOverlay` wiring
`src/features/scanner/components/ScannerOverlay.tsx`: reads `scannerBeep`/`scannerHaptics` via selectors and passes
`{ beep, haptics }` to **both** `feedback.current.confirm(...)` calls (Discrete result + Continuous queue offer); the
two flags are added to the `handleDecode` `useCallback` dependency array so a settings change mid-session is honoured.

### 3.4 Settings controls
`src/features/settings/SettingsScreen.tsx`: two new **On/Off** `Select` `SettingRow`s in the existing **"Scanner"**
`SettingsSection` — "Beep on scan" (`data-testid="setting-scanner-beep"`) and "Vibrate on scan"
(`data-testid="setting-scanner-haptics"`), beside the P34 "Barcode symbology" control.

### 3.5 Tests + smoke
New `src/features/scanner/feedback.test.ts` (+4): spies on `beep`/`vibrate` to assert `confirm` fires both by
default, suppresses each independently, and suppresses both. `scripts/browser-smoke.mjs` gained one step (in the
§6.6/§6.5 Settings cluster, after the Phase-34 symbology step): set both controls off, assert `gubbins:preferences`
persists `scannerBeep:false`/`scannerHaptics:false`, then restore the defaults. Step count **93 → 94**.

### 3.6 No migration, no dependency, extension untouched
`user_version` stays **19**; no `package.json` change; **`build:extension` NOT re-run**.

---

## 4. Testing (TDD-first) — what's reusable (1159; smoke 94)

- **Phase-57 added +4 unit tests** (`feedback.test.ts`) → **1159 / 118 files**. The gating test spies on the
  browser-only `beep`/`vibrate` members so it runs cleanly in happy-dom without a real `AudioContext` /
  `navigator.vibrate` — the right tool for thin device glue (no contrived pure module).
- **Established TDD seams unchanged:** `createMemoryDriver()` `:memory:`; the Repository pattern; pure helpers
  extracted out of glue; injectable `lib/env/*` + `apiOverride` hook seams; the P56 `operational-metadata.ts`
  rows↔record seam + `tab-keyboard.ts` `resolveTabKey`.
- **Smoke pattern for a Settings toggle:** `page.goto(\`${BASE}settings\`)`, `getByTestId('setting-…').selectOption(…)`,
  read `JSON.parse(localStorage.getItem('gubbins:preferences'))` to assert `…?.state?.<pref>`, then restore the
  default so later steps are unaffected (mirrors the Phase-34 symbology step exactly).

---

## 5. Files touched (orientation map)

- **New:** `src/features/scanner/feedback.test.ts` (+4 gating tests).
- **Edit:** `src/features/scanner/feedback.ts` (`confirm` flags), `src/state/stores/usePreferencesStore.ts`
  (`scannerBeep`/`scannerHaptics` + setters), `src/features/scanner/components/ScannerOverlay.tsx` (read flags +
  thread through both `confirm` calls + deps), `src/features/settings/SettingsScreen.tsx` (two On/Off Scanner
  controls).
- **Smoke:** `scripts/browser-smoke.mjs` (one new step after the Phase-34 symbology step).
- **Docs:** `docs/dev/deferred-features.md` (back-filled P54/P55/P56 rows that the concurrent location-UI work had
  left out of the roadmap table, + new P57 row + Backlog note) and this file.
- **Unchanged:** every migration; all Repositories; `protocol.ts` / `scrape-errors.ts` / the whole §9 path; the
  extension `dist/*`; `package.json`; `vite.config.ts`; the flake-retry runner; every other component and seam.

---

## 6. The companion extension (`extension/`) — UNCHANGED since Phase 36

Phase 57 touched no §9 protocol and no `extension/` source, so `extension/dist/*` is exactly as Phase 36 left it
(the seven-member `SCRAPE_ERROR` enum incl. `CHALLENGE`, `detectChallengePage` in `dist/content-script.js`). No
`build:extension` re-run was needed.

---

## 7. Technical debt, stubs & deferrals

> Tracked in `docs/dev/deferred-features.md` — kept current. **Phase 57 added a "Phase 57" row, back-filled the
> missing P54–P56 rows, and recorded the KiCad-XML-netlist importer as a conscious YAGNI deferral.**

**Remaining Backlog (all triggered conditionals — none has a live trigger today):** KiCad XML intermediate-netlist
import (trigger: a user actually arrives with a raw `.xml` netlist rather than a CSV BOM — KiCad's first-class BOM
export is already CSV, which `bom-import.ts` maps); multi-scrape UI tray (trigger: a real concurrent-scrape
entry-point, e.g. bulk BOM ingress); live distributor selector maintenance (trigger: a real scrape against a live
supplier failing); true NTP / cross-origin time source (trigger: same-origin `Date` proves insufficient); leaner /
precache-excluded WASM decoder (the ~442 KiB zxing scanner-fallback worker is ~15% of the precache — excluding it
sacrifices *offline* fallback scanning; **no size gate forces it since the P44 budget removal**); further
`aria-live` coverage (the silent surfaces are all done — any *new* region needs a genuinely silent in-place status
surface). **No remaining open item is a *mandated* spec requirement, and there is no "closest sibling" continuation
of any kind.**

**Carried LWW-class limitation (not a Phase-57 change):** concurrent location-delete vs. offline stock edit — an
additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until the next
reconcile (accepted, parallel to §7.5.2).

**Carried attachment note (P53 design choice, not debt):** a *legacy* pre-v18 `LOCAL_POINTER` (NULL origin) is
treated as `local` on every device — it cannot be attributed, so it keeps its prior behaviour.

> **Working-tree note:** Phase 57's edits are currently **uncommitted in the working tree** — committing/branching is
> the developer's call (no phase agent commits without being asked). Earlier location-UI work (Phase 54/55) and the
> Phase-56 edits may also still be uncommitted; the P54–56 roadmap rows in `deferred-features.md` were back-filled
> this phase. If schema/commits disagree with this file, **trust the migration registry + `git log`** and reconcile.

---

## 8. Live consolidation roadmap (post-Phase-57)

**Every enumerated consolidation phase (10–16) is complete**, the developer-chosen Backlog items so far (P17–P56)
are cleared, the last *mandated* spec gap (§4 "Unlinked Local File", P53) is closed, P54/P55 finished the
location-colour story, P56 surfaced the §4.1.1 operational-metadata layer, and **P57 made the §6.5 scanner feedback
mutable**. No spec-numbered or roadmap-enumerated phase remains; **no remaining Backlog item has a concrete trigger
today**, and **no remaining open item is a *mandated* spec requirement.** Phase 58 is therefore another
**developer-chosen Backlog / polish** phase (or a no-op until a trigger fires). **There is no remaining "closest
sibling" continuation of any kind.** Candidates remain the unrelated conditional Backlog entries (KiCad XML netlist
import; multi-scrape UI tray; live distributor selector maintenance; a true NTP source; a leaner/precache-excluded
WASM decoder; further `aria-live`), or a fresh investigation pick like Phases 37–57 were. **The audit in P57 found
the app essentially spec-complete — a genuine "defer until a trigger appears" is a legitimate Phase-58 outcome.**

---

## 9. Phase 58 entry checklist

- [ ] Read the master spec **and** this handover; restate the locked decisions.
- [ ] **Confirm Phase-58 scope with the developer first** — no enumerated phase remains, no Backlog item has a live
      trigger, and no remaining open item is a *mandated* spec requirement; pick one deliberately, propose a fresh
      investigation (as Phases 37–57 were), or **agree there's nothing to land yet** (P57's audit found the app
      essentially spec-complete, so deferral is a real option). **There is no "closest sibling" residual — choose
      consciously, and weigh YAGNI honestly (P57 deferred the KiCad-XML-netlist pick for exactly this reason).**
- [ ] **Reuse, don't reinvent:** the Repository/driver + `createMemoryDriver()` test path; 3-tier state; the Foundry
      primitives & **Tooltip (not `title`)** + **Toast** + the **focus-trapping Modal** (built-in **"Close"** can
      collide with a feature "Close"; a shared section-button label like "Saved" collides too — scope by
      `data-testid`) + the **APG-tree LocationSidebar** + the **tabbed `ItemDetailDialog`** (`tab-keyboard.ts`;
      active-tab-only mount) + the **`SkipLink` (+ `MAIN_CONTENT_ID`)** + the **`LiveRegion` (+ `liveRegionAttrs`)** +
      the **`FormField` (+ `fieldAria`)** + the **`Textarea`** + the **`ColorSwatchPicker`** + the **`LocationSelect`
      combobox** (name it via `labelledBy`, *not* `FormField`) + the
      **`useReducedMotion`/`useInstallPrompt`/`useWakeLock`/`useOnlineStatus`/`getDeviceId`** injectable-seam hooks
      (the `apiOverride` pattern + a pure `lib/env/*` probe); icons via the registry; RHF + Zod (drive a custom
      control with a **`Controller`**); **the `makeFormatters` factory + `useFormatters()` hook**; the
      `resolveTheme`/`applyTheme` seam; the export vault + archive seams; the recursive-ancestor-CTE cycle guard;
      **the "derive a projection from the SSOT, never a stored counter" seam**; **the cycle-count / partial-receipt /
      per-location-stock / batch seams**; **the off-thread scanner + adaptive-cadence + symbology + mutable-feedback
      seams**; **the §9 scraping seam**; **the bounded-list seam** (`list-window.ts` + `MAX_LIST_PAGES`, also driving
      the Activity Log); **the focus-trap / tree-keyboard / tab-keyboard / dashboard-layout seams**; **the text-search
      + saved-search seams** (`parseASTtoSQL` is the single SQL translator — never hand-build SQL from text); **the
      QR/printable + Continuous-Mode batch-action seams**; **the `describeHistoryEntry`/`historyActionLabel`
      formatter**; **the `resolveAttachmentLink` + `getDeviceId` attachment seams**; **the `location-color.ts`
      swatch-key→token seam**; **the `operational-metadata.ts` rows↔record seam** (rich per-item facets are edited as
      `ItemDetailDialog` **tab sections** wired to their own hooks); **and the `usePreferencesStore` "fixed behaviour
      → device-local Tier-2 toggle/clamp" pattern** (P34/P46/P57: a boolean needs no normalisation module; an enum/
      number gets a pure clamp/normalise helper). **The bundle check no longer enforces a budget.**
- [ ] **TDD-first over `createMemoryDriver()`** (Protocol Beta) for any logic; keep pure helpers pure, use an
      **injectable dependency seam** for hard-to-unit-test glue. **For anything that runs in the extension, put the
      logic in a pure `src/` module and unit-test it there.** **Don't invent a contrived pure module for thin DOM/
      device glue** — a `@testing-library/react` component/hook test, a direct test on a small class (as P57 did for
      `ScanFeedback.confirm`), or the browser smoke for pointer/camera/network/device glue is the right tool. **Don't
      share a basename between a pure `.ts` and a component `.tsx`** (P42). **A control inside an existing `<form>`
      must not be its own `<form>`** (P48). **Render a field's `role="alert"` error as a sibling of the label**
      (P51). **Name a custom `role=combobox` via `labelledBy`, not `FormField`** (P55). **In the smoke, close a Modal
      with Escape or a `data-testid`, scope a shared button label by `data-testid`, and click a detail facet's tab
      first** (P49/P56). **`noUnusedLocals` is on.** **Use design tokens, never raw colour/motion values.**
- [ ] **A schema migration is only needed if you add persistent bookkeeping** — register the next migration in
      `src/db/migrations/index.ts`, bump `user_version` past **19**, add a migration test (additive pattern `v9`…`v19`;
      `engine.test.ts` asserts the *derived* `TARGET_SCHEMA_VERSION` and per-version tests use `>=`, so neither needs
      narrowing for an additive bump). A column on a `SYNC_TABLES` table auto-joins the LWW payload — add it to
      `SYNC_EXCLUDED_COLUMNS` if device-local; a new synced **FK** column needs an `FK_REFS` entry +
      `applyPlan`/`LocationRepository.delete` null-out (a non-FK synthetic id needs neither). **A new additive
      `locations` column must also be added to `LocationRepository`'s explicit `SELECT_WITH_COUNT`** (and any new
      `items` column to `ItemRepository`'s explicit read lists). (A device-local UI toggle/preference belongs in
      `usePreferencesStore`/`useLayoutStore`/a dedicated Zustand `persist` store / `localStorage` — as P57's scanner
      toggles do; a transient, workflow-scoped selection belongs in ephemeral Tier-3 React/Context state.)
- [ ] ⚠️ **Trigger ordering & FTS5:** do **not** `DROP`/`CREATE` the `items` auto-stamp or FTS triggers. For a
      quantity-like derived projection, copy the v13/v15 guarded separate-table recompute pattern.
- [ ] **Extend `scripts/browser-smoke.mjs`** with any new flows. `SMOKE_BASE` if not on 5173. **Launch the dev
      server in a persistent background process** (Bash `run_in_background`; `Start-Process npm` fails — go via
      `cmd.exe /c "npm run dev"`), and **stop it via its PID** — verify the port is released. Connectivity →
      `page.context().setOffline(…)`; a second device → overwrite `localStorage['gubbins:device-id']` + reload (note
      the Phase-53 step does this near the end — keep new flows **before** it); a custom combobox → open + click
      option; a detail facet → click its tab first. If you add a `src/routes/*` file, run `npx vite build` once
      before `type-check`. **Vite bundles `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`
      as a separate module graph** — use that exact form.
- [ ] Verify four ways and keep all green: `npm run type-check` (check the exit code), `npm run test:run`
      (`threads`-pool, **1159**), `npm run build` (reporter prints the precache size, no budget), and `npm run
      test:e2e` against a live dev server (the "adds a weighted capability" step can flake on `press('Enter')` /
      element-stability — **re-run once**; the Phase-37 deep-scroll step seeds 305 items; the Phase-53 datasheet step
      does a mid-suite reload + device-id swap). **Run `npm run build:extension` only if you touch §9 / `extension/`**
      (Phase 57 did **not**). Then generate the **Phase 58 → 59** handover and hand back the Phase 59 continuation
      prompt in a raw markdown block.
