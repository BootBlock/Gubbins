# Deferred features tracker

Functionality intentionally deferred from a completed/active phase to a later one, so nothing is
silently dropped. Each entry cites its spec section and the phase that should pick it up.

> **Completion guarantee.** Deferred work is never dropped — every open `[ ]` item below is tagged with a
> concrete **→ Phase N** target (see the roadmap), and each consolidation phase must clear its assigned
> items before it is declared complete. The phase targets are *proposed*: per Protocol Alpha (§8.1.2) the
> developer confirms each phase's exact scope at entry, but an item may only ever be **re-scheduled to a
> later phase, never deleted**. "Conditional/YAGNI" items live in the Backlog with an explicit trigger and
> are likewise tracked, not forgotten.

## Consolidation roadmap (the spec's numbered phases end at Phase 9)

Proposed landing phases for all outstanding deferred work. Confirm scope at each phase entry.

| Phase | Theme | Absorbs |
| --- | --- | --- |
| **10** ✅ | OPFS Quota Recovery & Archiving (§7.6) | Storage Triage Dashboard + history pruning + image downgrade — **done** |
| **11** ✅ | **Sync-set expansion** (§7.2/§7.3/§8.2) | `item_history` (union-by-id + prune watermark), M:N joins/leaves (`item_tags` membership + the LWW leaf tables), `item_images` (base64 thumbnails) → `SYNC_TABLES`; `maintenance_schedules` reconcile-coverage audit + a §7.5 child-FK guard — **done** |
| **12** ✅ | Settings & preferences UI (§3) | `scrapeNotifications` control, `EXPIRY_SOON_WINDOW_DAYS` control, prune/downgrade window controls + permanent Triage entry-point, theme application (+ a confirm-before-delete step on triage, + currency/locale/attachment-mode controls) — **done** |
| **13** ✅ | Scraping & extension hardening (§9) | Six per-supplier parsers (Mouser/Farnell/LCSC/RS + Adafruit/SparkFun) + narrowed `host_permissions`, full-concurrent multi-scrape `requestId` correlation — **done** |
| **14** ✅ | Export/import & sync resilience (§2.7/§3/§4.5/§7) | Single-item/project export scope, vault asset extraction (full-res image bytes into `/assets`), raw `.sqlite` restore, mobile weekly auto-archive, HTTP/NTP time source, FS Access provider persistence, ledger-watermark in the §7.2 clone path, child-FK guard for non-item parents — **done** |
| **15** ✅ | Scanner, search & performance polish (§6.6) | Scanner WASM fallback (lazy `@zxing/browser`), weighted-capability "best match" ranking, a **warn-only** bundle-size budget, storage `AVG_ROW_BYTES` accuracy (measured OPFS image bytes), + the carried-over §2.7 auto-archive mobile smoke — **done** |
| **16** ✅ | Backlog consolidation / final polish | **End-to-end currency/locale propagation** (§3 — every `Intl`/currency call site routed through `usePreferencesStore` via the `makeFormatters` factory + `useFormatters` hook) **and** the **"System/auto" theme** (`Theme` union widened + a `prefers-color-scheme` listener) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **17** ✅ | Backlog (developer-chosen) | **Restore-from-archive image re-hydration** (§2.7/§3 — the §2.7 Full Archive `.zip` now restores on a fresh device: `restoreArchive` unzips, overwrites the OPFS database **and** writes the full-resolution OPFS images back via `writeImageFiles`) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **18** ✅ | Backlog (developer-chosen) | **Nested multi-level variants** (§4 Variant/SKU — the Phase-9 single-level cap is lifted: a variant may itself hold sub-variants to any depth, with cycle rejection (§7.5.3) as the sole structural invariant, enforced by a recursive ancestor-CTE guard in `ItemRepository` driving the pruned pure `validateVariantLink`) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **19** ✅ | Backlog (developer-chosen) | **§4.5 Project-scope vault sub-folders** (the Project/BOM Markdown-vault export now nests into one self-contained project folder: the master `.md` note alongside the component notes in their Location sub-folders + the shared `/assets`, via a new `rootFolder` option on `buildVault` and the pure `buildProjectVault` composer) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **20** ✅ | Backlog (developer-chosen) | **In-Transit physical quantity** (§4 liminal procurement — incoming/ordered stock now surfaces as a distinct per-item quantity, derived from the item's `IN_TRANSIT` BOM lines via the pure `ProjectRepository.inTransitQtyForItem`, shown beside on-hand stock on the item detail; **no migration**, no stored counter, so it can never drift from the line status under cascade-deletes or LWW sync) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **21** ✅ | Backlog (developer-chosen) — dev-experience | **Node-25 unit-pool cold-start flake fix** (the one *fresh* real-world trigger — this machine runs Node v25.2.1, where Vitest's default `forks` pool hit a tinypool `child_process.fork` cold-start race that crashed the whole run once on a cold cache: every file reported "no tests" with `TypeError: Cannot read properties of undefined (reading 'config')`). Pinned `test.pool: 'threads'` in `vite.config.ts` — the in-process `worker_threads` pool sidesteps the spawn race, is stable across cold starts and ~12× faster wall-clock (the `:memory:` node:sqlite driver runs correctly under it; per-file module isolation preserved). **No app code / schema change** (`user_version` stays 10). Remaining open items are still triggered Backlog entries (below). |
| **22** ✅ | Backlog (developer-chosen) | **Automatic maintenance usage telemetry** (§4.3 — a USAGE maintenance schedule may opt in to accrue real **checkout-hours**: the loan duration of the tool drives its next service, instead of the Phase-9 manual `addUsage` counter. The accrued hours are a *derived projection* over the `checkouts` ledger — `MaintenanceRepository` `AUTO_USAGE_HOURS` subquery, mirroring the Phase-20 `inTransitQtyForItem` "derive, never store a counter" seam — so they never drift; the only persisted bit is the per-schedule opt-in, an additive **v11** `accrue_checkout_hours` column that auto-joins the LWW payload) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **23** ✅ | Backlog (developer-chosen) | **Serialised cycle count** (§4.4 — the Cycle Count / Reconciliation workflow now audits **SERIALISED** instances by *presence*, not just DISCRETE quantity: each qty-1 unit in a location is flagged present or missing, and a missing instance is reconciled by a **reversible soft-delete** (`is_active = 0` + a `RECONCILED` ledger entry at `quantity_delta = -1`, restorable via `restore`). The present/missing partition is pure (`missingInstances`/`serialisedAuditNote` in `cycle-count.ts`); the write is `ItemRepository.reconcileSerialised`, mirroring the DISCRETE `reconcile` seam. **No migration** — only the existing synced `is_active` column is toggled, so `user_version` stays **11**) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **24** ✅ | Backlog (developer-chosen) | **Partial / split BOM-line receipts** (§4 procurement — an `IN_TRANSIT` BOM line can now be received into stock in instalments: the additive **v12** `project_bom_lines.received_qty` accumulates as stock arrives, the line stays IN_TRANSIT until cumulative receipts meet the requirement, and the derived In-Transit projection becomes `SUM(required_qty − received_qty)`. The clamp/accumulate maths is the pure `planReceipt` in `features/projects/receipts.ts` (mirroring the `cycle-count.ts` seam); `ProjectRepository.receiveLine` trusts it and persists the result. `received_qty` is the *primary* record of instalment progress (no ledger to derive it from reliably), so it persists — an additive column that auto-joins the LWW payload (`project_bom_lines` is in `SYNC_TABLES`); `user_version` is now **12**) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **25** ✅ | Backlog (developer-chosen) | **Per-location stock ledger** (§4 — the larger Phase-20 residual: an item's on-hand stock can now sit in **more than one location at once**. A new synced **v13** `item_stock` table becomes the SSOT for *where* the units are (one row per `(item, location)`, deterministic `${itemId}|${locationId}` id so concurrent placements merge by LWW), and `items.quantity` becomes a derived projection — `SUM(item_stock.quantity)` — maintained by `trg_item_stock_recompute_*` triggers (guarded `quantity <> SUM` so a no-op recompute never perturbs `items.updated_at`/FTS/LWW). Every write path routes through the ledger: create seeds the primary placement; `adjustQuantity`/`reconcile`/checkout/`receiveLine` act on a location; the new pure `planTransfer` + `ItemRepository.transferStock` split stock; `move` consolidates. `LocationRepository.delete` and the §7.5.2 sync `applyPlan` re-home placements at a removed location to Unassigned. UI: a per-location breakdown + split control on the item detail (`StockBreakdown`). `user_version` is now **13**) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **26** ✅ | Backlog (developer-chosen) | **Per-location cycle count + checkout source** (§4.4 / §4 — the two closest-to-triggered Phase-25 residuals). The §4.4 Cycle Count dialog now audits a *specific* placement: it reads the `item_stock` ledger (`ItemRepository.listStockAtLocation`) so the expected figure is *this location's* on-hand (not the item's grand total) and includes items primarily housed elsewhere, and `reconcile` absorbs the variance at the counted placement (optional `locationId` on `ReconciliationAdjustment`, `setStock` at that row). A DISCRETE loan can be drawn from a chosen placement (`CheckoutItemInput.fromLocationId`, validated against *its* on-hand) and is **returned to where it left from** — the lend-from location persists in the additive **v14** `checkouts.source_location_id` (nullable FK; `LocationRepository.delete` + the §7.5.2 sync `applyPlan` null it for a removed location before the RESTRICT delete; `FK_REFS` nulls an incoming dangling source). `user_version` is now **14**) — **done.** Remaining open items are still triggered Backlog entries (below). |
| **27** ✅ | Backlog (developer-chosen) — dev-experience | **Node-25 cold-start flake hardening** (the one *fresh, genuinely-observed* trigger, beyond the P21 `threads` pin). `npm run test:run` now runs through a wrapper (`scripts/run-unit-tests.mjs`) that **automatically re-runs `vitest run` once — but only** when the previous run carries the exact cold-start fingerprint (`Cannot read properties of undefined (reading 'config')`), so a real test failure still fails fast and is never masked. (Vitest's own `test.retry` *cannot* recover this: the flake collapses the whole run with zero tests collected, before any test body runs, so there is no failing test to retry.) The retry decision (`isColdStartFlake`) and the bounded orchestration (`runWithRetry`, injectable runner) are pure and unit-tested in `scripts/flake-retry.test.mjs` (+10 tests). **No app code / schema change** (`user_version` stays **14**). Remaining open items are still triggered Backlog entries (below). |
| **28** ✅ | Backlog (developer-chosen) | **Batch / lot-aware per-location stock + cycle count** (§4 perishables & traceability — the closest-to-triggered Phase-26 residual). A placement's units can now split across distinct **batches** (a `(batch number, lot number, expiry)` identity each): a new synced **v15** `stock_batches` table is the SSOT one level *below* `item_stock`, and `item_stock.quantity` becomes the derived `SUM(stock_batches.quantity)` per placement (guarded `trg_stock_batches_recompute_*` triggers chaining into the v13 `items.quantity` triggers — a clean three-level projection). A BOM receipt can land into a specific lot (`receiveLine`'s `batch`); the StockBreakdown shows FEFO batch sub-rows; the §4.4 cycle count audits each lot at a placement (optional `batch` on `ReconciliationAdjustment`). Transfer and checkout draw the placement down **first-expiry-first-out** across its lots (the pure `planBatchConsumption` in `features/inventory/batches.ts`), a transfer preserving each lot's identity at the destination. Sync: `stock_batches` ∈ `SYNC_TABLES` after `item_stock` + an `FK_REFS` entry + location-delete/`applyPlan` re-home to Unassigned. `user_version` is now **15**. Remaining open items are still triggered Backlog entries (below). |
| **29** ✅ | Backlog (developer-chosen) | **Explicit per-batch transfer / checkout selection** (§4 perishables & traceability — the closest-to-triggered Phase-28 residual). Transfer and checkout no longer *only* auto-consume FEFO: the user can pick the **exact lot** to move or lend (the pure `planBatchSelection` in `features/inventory/batches.ts`, alongside the FEFO `planBatchConsumption`), and a lent lot is remembered on the loan so the return restores to **that exact lot** rather than the untracked default batch — the canonical key round-trips back to its identity via the new `batchIdentityFromKey` (inverse of `batchKeyOf`), so the only persisted bit is one additive **v16** `checkouts.source_batch_key` (nullable, *not* an FK — a batch key is a synthetic identity and the lot's row may legitimately empty while the unit is out). `transferStock` gained an optional `batchKey`; `CheckoutItemInput` an optional `fromBatchKey`; both UIs (`StockBreakdown`, `CheckoutDialog`) gained an optional lot picker shown only where a placement holds tracked lots. `user_version` is now **16**. Remaining open items are still triggered Backlog entries (below). |
| **30** ✅ | Backlog (developer-chosen) | **Per-location maintenance scheduling** (§4.3 — the last Phase-26/28 sibling residual). A maintenance schedule may now be scoped to a *specific placement* of a DISCRETE tool spread across locations (Phase 25 `item_stock`): the additive **v17** `maintenance_schedules.location_id` (nullable FK; NULL = the whole item, the Phase-9 behaviour). The scope is operationally meaningful, not a label — a location-scoped USAGE/accrue schedule (Phase 22) accrues only loans *drawn from that placement* (`checkouts.source_location_id`, Phase 26), via the pure `accruedCheckoutHours` scope filter + the `AUTO_USAGE_HOURS` SQL `(location_id IS NULL OR k.source_location_id = ms.location_id)` guard. Synced FK: `FK_REFS` entry + `LocationRepository.delete`/`applyPlan` null-out (the schedule reverts to item-level when its location is removed), mirroring v14's `source_location_id` exactly. `user_version` is now **17**. Remaining open items are still triggered Backlog entries (below). |
| **31** ✅ | Backlog (developer-chosen) — performance | **WASM scanner decode performance** (§6.6 — the off-thread fallback decode). The §6.6 WASM fallback (used when the native `BarcodeDetector` is absent — Firefox, all Safari) no longer decodes on the main thread: a frame is captured to an `ImageBitmap` (`createImageBitmap`, off-thread) and **transferred** into a Web Worker that runs the zxing decode on an `OffscreenCanvas`, so live scanning never janks the UI. The worker uses the leaner `@zxing/library` **core** (`MultiFormatReader`/`RGBLuminanceSource`/`HybridBinarizer` via the pure `rgbaToLuminance`) — `@zxing/browser` needs a DOM `HTMLCanvasElement` absent in a worker — so the old `@zxing/browser` dep was **dropped** and `@zxing/library` promoted to a direct dep (already in the lockfile; no new download). The worker replaces the main-thread decoder as the sole `'wasm'` tier, gated by the pure `supportsWorkerDecode` (Worker + OffscreenCanvas + createImageBitmap); browsers lacking those + the native API degrade to manual entry (`'none'`). **Net leaner** (precache 2825 KiB, +24 KiB headroom vs Phase 30, as the worker zxing-core chunk replaces the old `@zxing/browser` chunk and is split out of the main bundle). **No schema/migration change** — `user_version` stays **17**. Remaining open items are still triggered Backlog entries (below). |
| **32** ✅ | Backlog (developer-chosen) — performance | **Adaptive frame-skip scanner decode** (§6.6/§6.1 battery — the Phase-31 residual). The off-thread WASM worker decode (Firefox/all Safari) no longer decodes every frame at a fixed 120 ms throttle: a new pure `decode-cadence.ts` (`initialCadence`/`nextCadence` + `DEFAULT_WASM_CADENCE`) backs the decode interval off geometrically (120 → 600 ms, ×2 after 8 idle frames, capped) as the camera stays idle and **snaps straight back to the fast base cadence the instant a code is decoded**, so a low-end device pointed at an empty bench stops burning CPU per frame while a barcode that is actually held up is still acquired within ≤600 ms. The cadence is a deterministic state-fold (no clock/DOM), threaded through `useScanner`'s RAF loop for the `'wasm'` engine only (native stays per-frame — it has no per-frame cost to amortise). **No schema/migration change** — `user_version` stays **17**; precache effectively unchanged (2825.79 KiB / 174.21 KiB headroom). Remaining open items are still triggered Backlog entries (below). |
| **33** ✅ | Backlog (developer-chosen) — compatibility | **Main-thread-capture scanner fallback** (§6.6 — restores live scanning for no-`OffscreenCanvas` browsers, Safari < 16.4). Those browsers previously degraded straight to manual entry: the `'wasm'` tier needs `OffscreenCanvas` (absent until Safari 16.4) to rasterise the transferred `ImageBitmap` in the worker. A new `'wasm-canvas'` tier captures each frame on the **main thread** with a regular 2-D `<canvas>` (the API they *do* have) and transfers the **raw RGBA pixels** to the **same** decode worker, which decodes them via the shared `createZxingDecode` **without** touching `OffscreenCanvas`. The heavy zxing decode therefore still runs **off-thread** and the worker's `@zxing/library` chunk is **reused, not duplicated** into the main bundle (the developer chose this over a literal main-thread decoder precisely to avoid a ~432 KiB precache duplication). Threaded through the same adaptive cadence as `'wasm'`. **No schema/migration change** — `user_version` stays **17**; precache effectively flat (2826.95 KiB / 173.05 KiB headroom). Remaining open items are still triggered Backlog entries (below). |
| **34** ✅ | Backlog (developer-chosen) — performance | **Single-format scanner symbology** (§6.6/§6.1 — the closest *thematic* sibling of P31–33, finishing the Phase-31 perf residual). The §6.6 tiered decoder hinted **all four** symbologies (QR/Code-128/EAN-13/Code-39) on every frame; a user who only scans one kind of code can now narrow the scanner to a **single symbology** so the zxing `MultiFormatReader` (and the native `BarcodeDetector`) hint just that one format — ~4× less per-frame decode work on the off-thread worker fallbacks. The scope is a pure, **main-thread-safe** seam: `scanner-formats.ts` (no `@zxing/library` import, so the enum never enters the default bundle) owns the `ScannerSymbology` union + `nativeFormatsFor`/`normaliseSymbology`; the worker-only `zxing-decode.ts` maps the key → `BarcodeFormat[]` (new pure `zxingFormatsFor`) and `createZxingDecode(symbology)`; the decode worker memoises its hinted reader **by symbology** and each `FrameDecoder` request carries the symbology; `createDecoder(symbology)` threads it through all three tiers. Surfaced as a `usePreferencesStore.scannerSymbology` Tier-2 preference (default `'all'` — never a regression) with a new "Scanner" Settings control. **No schema/migration change** — `user_version` stays **17**; precache effectively flat (2828.26 KiB / 171.74 KiB headroom, +1.31 KiB glue). Remaining open items are still triggered Backlog entries (below). |
| **35** ✅ | Backlog (developer-chosen) — extension resilience | **Deeper `SCRAPE_ERROR` taxonomy** (§9.4.2/§9.4.3 — a fresh extension-hardening pick). The §9.4.2 error enum gained three HTTP-status-driven members — **`BLOCKED`** (401/403/other-4xx), **`NOT_FOUND`** (404/410), **`SERVER_ERROR`** (5xx) — so a *received* HTTP failure is no longer mis-reported as a transport `NETWORK_TIMEOUT` (the pre-35 background worker collapsed every non-429 status into it). The status→type decision is the new pure, unit-tested `classifyHttpStatus` in `src/features/scraping/scrape-errors.ts` (extracted out of the esbuild-only extension worker so it is actually testable + shared verbatim), and the matching §9.4.3 graceful-degradation toast wording is the pure `describeScrapeError` (one tested place, per-type actionable nudge, replacing the inline `DOM_DRIFT`-only ternary in `ScrapeSupplierPanel`). The extension `background.ts` now calls `classifyHttpStatus`; a transport abort/timeout stays `NETWORK_TIMEOUT`. Also fixed a latent wrong import (the extension imported `ScrapeErrorType` from `parsers/types`, which never exported it — now from `protocol`, the SSOT). **Breaking §9 wire change → extension rebuilt** (`build:extension`; new members confirmed in `dist/background.js`). **No schema/migration change** — `user_version` stays **17**; precache effectively flat (2828.81 KiB / 171.19 KiB headroom, +0.55 KiB glue); 797 unit / 78 files / 69 smoke. Remaining open items are still triggered Backlog entries (below). |
| **36** ✅ | Backlog (developer-chosen) — extension resilience | **Heuristic `CAPTCHA` / challenge-page detection** (§9.4.2/§9.4.3 — the item P35 consciously declined, now landed). A 200-OK anti-bot interstitial is no longer mis-parsed into a `DOM_DRIFT`: the pure, unit-tested `detectChallengePage(html)` in `scrape-errors.ts` inspects the fetched body for **high-confidence, full-page vendor markers only** (Cloudflare `Just a moment…`/`cf-browser-verification`/`cdn-cgi/challenge-platform`/…; Imperva Incapsula incident; PerimeterX `px-captcha`; DataDome `geo.captcha-delivery.com`) and **deliberately ignores bare reCAPTCHA/hCaptcha widgets** (legitimate contact-form embeds) to keep false positives near zero — the conscious under-detect-not-misfire trade-off. The content script runs it **before** handing the body to the Strategy parsers and marshals a new **`CHALLENGE`** `SCRAPE_ERROR` wire member; `describeScrapeError` gained the per-type toast wording (nudges opening the page in a browser tab). **Breaking §9 wire change → extension rebuilt** (`CHALLENGE`/`detectChallengePage` confirmed in `dist/content-script.js`; `background.js` unchanged — challenge detection is content-script-side). **No schema/migration change** — `user_version` stays **17**; precache effectively flat (2828.96 KiB / 171.04 KiB headroom, +0.15 KiB glue); 809 unit / 78 files / 70 smoke. Remaining open items are still triggered Backlog entries (below). |
| **37** ✅ | Backlog (developer-chosen) — performance / resource | **Bounded virtualised-list memory** (§2.1 "light memory with 100,000+ items" — a performance/resource investigation pick, not a pre-listed Backlog item). The inventory list's `useInfiniteQuery` retained *every* scrolled page in the TanStack cache, and each row carries a thumbnail BLOB — so a deep scroll accumulated unbounded blob memory (the one place the 100k-item scaling claim actually leaked; the DOM was already virtualised). The infinite queries now cap retained pages with **`maxPages = MAX_LIST_PAGES` (6 × `DEFAULT_PAGE_SIZE` 50 = 300 items)** + a `getPreviousPageParam`, turning the resident `items` array into a *sliding window*. To stop a trimmed-off front page from shifting every row, the virtualiser is driven in **absolute index space** via the pure, unit-tested `list-window.ts` (`listRowCount`/`resolveListRow`): virtual row 0 is always result item 0 even after a page is evicted, trimmed rows render as a fixed-height placeholder, and scrolling back up refills the prefix (`fetchPreviousPage`) without moving the viewport. Applied to both `useInventoryItems` and the AST `useAstSearch` (both feed the same `ItemList`). **No schema/migration change** — `user_version` stays **17**; precache effectively flat (2829.76 KiB / 170.24 KiB headroom, +0.8 KiB glue); 818 unit / 79 files / 71 smoke. Remaining open items are still triggered Backlog entries (below). |
| **38** ✅ | Backlog (developer-chosen) — accessibility / fresh investigation | **Accessible Modal focus management** (§3 "modern accessible UI components" / §2.4.1 — a fresh-investigation pick à la Phase 37, sweeping the a11y/keyboard/focus axis Phase 37 did not). The Foundry `Modal` declared `role="dialog"` + `aria-modal="true"` but had **no focus management at all** — the `aria-modal` contract was broken across all ~45 dialogs (every create/edit dialog, CheckoutDialog, CycleCountDialog, Safe Mode, …): focus was never moved into the dialog on open, **Tab escaped to the backdrop-obscured page behind it**, and focus was lost (dropped to `<body>`) on close. The fix moves focus into the dialog container on open, **traps Tab/Shift+Tab within it** (wrapping at both ends), and **restores focus to the opener** on close. The wrap-around maths is the pure, unit-tested `src/components/foundry/focus-trap.ts` (`nextTrapIndex` + `FOCUSABLE_SELECTOR`), mirroring the `list-window.ts` / `cycle-count.ts` "extract pure logic out of glue" seam; the DOM glue (capture/move/trap/restore, via an `onCloseRef` so inline `onClose` closures don't thrash the `[open]`-keyed effect) lives in `modal.tsx`. **No schema/migration change** — `user_version` stays **17**; no dependency change; precache effectively flat (2830.39 KiB / 169.61 KiB headroom, +0.63 KiB glue); 831 unit / 81 files / 72 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **39** ✅ | Backlog (developer-chosen) — accessibility | **Accessible LocationSidebar tree** (§3 "modern accessible UI components" / §2.4.1 — a Phase-38 a11y follow-up: the developer chose "the a11y follow-ups", and this is the highest-leverage one with a clean pure seam). The location navigation sidebar was a flat pile of `<button>`s — **no tree semantics, no arrow-key navigation, and every control (expand chevron, label, delete) a separate tab stop**, so a deep hierarchy meant dozens of tab stops before the item list. It is now a WAI-ARIA APG **`tree`**: a single `role="tree"` with `role="treeitem"` rows carrying `aria-level`/`aria-expanded`/`aria-selected` (a *flat* ARIA tree — hierarchy via `aria-level`, no nested `role="group"`), the whole widget a **single tab stop via roving `tabindex`**, and once focused the arrow keys navigate it (Up/Down between visible rows, Right expand/enter-child, Left collapse/step-to-parent, Home/End, Enter/Space select, Delete removes a non-system location). The chevron and delete controls became `tabindex={-1}` (mouse + Delete-key driven), so the treeitem is the only tab stop. The pure navigation maths is the unit-tested `src/features/inventory/tree-keyboard.ts` (`resolveTreeKey` + `TreeRow`/`TreeKeyAction`), mirroring the Phase-38 `focus-trap.ts` / `list-window.ts` "extract the logic out of the glue" seam; the DOM glue (roving tabindex, ref focus, expand/collapse overrides, selection) lives in `LocationSidebar.tsx` (its keydown handler resolves the active row from the focused treeitem's `data-tree-id`, not React state, so a key is never read against a not-yet-flushed `focusedId`). Expansion is now "top-level open by default (**including freshly-created locations**), explicit toggles recorded as overrides" — preserving the prior per-node `depth < 1` default as the tree grows. **No schema/migration change** — `user_version` stays **17**; no dependency change; precache effectively flat (2832.75 KiB / 167.25 KiB headroom, +2.99 KiB glue); 856 unit / 83 files / 73 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **40** ✅ | Backlog (developer-chosen) — accessibility | **Skip-to-content link + result-count `aria-live`** (§3 "modern accessible UI components" / §2.4.1 — the remaining Phase-38/39 a11y follow-ups). The app had no WCAG 2.4.1 *Bypass Blocks* affordance: a keyboard/SR user had to step through every per-screen navigation header (the Inventory header alone is ~10 controls) before reaching content, and the routed screens had inconsistent landmark structure (three screens had **no** `<main>` at all). A new `SkipLink` Foundry primitive (`src/components/foundry/skip-link.tsx`) is rendered once in the root layout (`routes/__root.tsx`) as the **first focusable element on every route** — visually hidden until focused, then it moves focus past the header to the per-screen `#main-content` landmark (it focuses the target explicitly via `MAIN_CONTENT_ID`, not just the `href` fragment, since a hash nav scrolls but doesn't reliably move SR/keyboard focus). Every routed screen now carries exactly one `<main id={MAIN_CONTENT_ID} tabIndex={-1}>` *after* its header (Inventory/Projects already had one — given the id; Dashboard's outer `<main>` was demoted to `<div>` with a content `<main>` after the header; Contacts/Sync/Settings gained a `<main>` wrapper). The skip target must live per-screen because the nav is per-screen (inside the `<Outlet/>`) — there is no global placement that skips it (the Phase-39 "no app shell" note). Also closed the one genuine silent-update `aria-live` gap: the Inventory result-count / "Loading…" region is now `role="status" aria-live="polite"` so filter/search result changes are announced (mutation outcomes already announce via the Foundry Toast's `aria-live="polite"`/`role="status"`). The skip-link's small DOM-focus glue is component-tested (`skip-link.test.tsx`) à la `LocationSidebar.test.tsx`. **No schema/migration change** — `user_version` stays **17**; no dependency change; precache effectively flat (2834.00 KiB / 166.00 KiB headroom, +1.25 KiB glue); 859 unit / 84 files / 74 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **41** ✅ | Backlog (developer-chosen) — fresh investigation (kiosk ergonomics) | **§3 Kiosk & Tablet Ergonomics** (a fresh-investigation pick à la P37/P38: the §3 "Kiosk & Tablet Ergonomics" mandate was the one genuinely-unbuilt spec requirement — `hasWakeLock()` was *detected* in `feature-detection.ts` but **never requested**, and no dashboard view carried the mandated `touch-action: pan-y; user-select: none;` containment). Both are now landed behind one opt-in **Tier-2 `kioskMode` preference** (default off, Settings "Kiosk & display" control): the Dashboard calls `useWakeLock(kioskMode)` to hold a `'screen'` wake-lock sentinel — **re-acquiring on `visibilitychange`** (the browser auto-releases when hidden) and degrading silently where the API is absent (iOS/Safari) — and applies `touch-pan-y select-none` to its `<main>` landmark only when kiosk mode is on (so casual use keeps pinch-zoom, avoiding a P38–40 a11y regression). The lifecycle *decision* is the pure, unit-tested `wakeLockAction` (`src/features/dashboard/wake-lock.ts`); the DOM glue reaches the API through an **injectable `WakeLockApi` seam** (`useWakeLock.ts`) so it is component-tested with a fake (no real browser), mirroring the scanner decoder seam. The §2.2.7 multi-tab guard (`tab-lock.ts`) was already done, so this closes the remaining unbuilt half of the kiosk/tablet story. **No schema migration** — `kioskMode` is a device-local Tier-2 preference (`user_version` stays **17**); no dependency change; precache 2836.23 KiB / 163.77 KiB headroom (+2.23 KiB glue); 874 unit / 86 files / 75 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **42** ✅ | Backlog (developer-chosen) — accessibility | **Broader `aria-live` coverage** (§3 "modern accessible UI components" / WCAG 4.1.3 Status Messages — the developer chose this trigger-gated item). The high-leverage live regions landed earlier (the Toast announces *mutation* outcomes; P40 added the skip-link + Inventory result-count region), but two **in-place status surfaces still changed silently after an explicit action**: the **Sync screen's `sync-result` line** (a bare `<span>` — tap "Sync now" and a screen-reader user heard nothing of "CLEAN · pulled 3 · deleted 1") and the **scanner's manual-entry feedback** (a blind user typing a code into the §6.6 fallback got no spoken result). A new Foundry **`LiveRegion`** primitive (`src/components/foundry/live-region.tsx`) wraps these: it is **always mounted** so a later content change is actually announced (a `role`/`aria-live` element *inserted* at message-time is frequently not announced — the region must pre-exist), with politeness resolved by the pure, unit-tested `liveRegionAttrs` (`src/components/foundry/aria-live.ts` — `polite`→`role=status`, `assertive`→`role=alert`, both `aria-atomic`, mirroring the `resolveTheme`/`describeScrapeError` small-pure-mapping seam). Wired into: the Sync outcome line (polite), the Sync error banner upgraded to **assertive** `role="alert"` (a sync/restore/backup failure should interrupt *and* announces reliably on insertion), the scanner's manual-entry notice (polite, always-mounted) and a **visually-hidden** announcement of the discrete "Scanned <name>" result (the visible card is interactive, so the announcement lives in a separate `sr-only` region). **No schema/migration change** — `user_version` stays **17**; no dependency change; precache effectively flat (2836.79 KiB / 163.21 KiB headroom, +0.56 KiB glue); 883 unit / 88 files / 76 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **43** ✅ | Backlog (developer-chosen) — accessibility / fresh investigation | **`prefers-reduced-motion` honouring** (§3 "modern accessible UI components" / WCAG 2.3.3 Animation from Interactions — a fresh-investigation pick à la P37/P38, sweeping the motion-sensitivity axis the P38–42 a11y arc never named). The app is deliberately animation-rich (§3 "fluid CSS transitions", "colour pulsing on success states", "smooth expand/collapse animations") but only *partially* honoured a reduced-motion request: the sole `@media (prefers-reduced-motion: reduce)` block neutralised just the four bespoke `animate-*` utilities, leaving the **`animate-spin` loader** (a continuous rotation), **every Tailwind `transition-*` effect across 31 component files**, and `scroll-behavior` untouched — and there was **no JS seam** (unlike the P16 `prefers-color-scheme` seam). Now: (1) the CSS block is broadened to a **global catch-all** (`*,*::before,*::after` neutralising animation/transition durations + `scroll-behavior`), with a deliberate **spinner exemption** (a loading spinner is *functional* feedback, not decoration, so `.animate-spin` keeps rotating via a self-contained `gubbins-spin` keyframe); (2) a pure, feature-detected `prefersReducedMotion()` seam (`src/lib/env/motion.ts`, mirroring `theme.ts`'s `systemPrefersDark`); (3) a live `useReducedMotion()` hook (`src/components/foundry/useReducedMotion.ts`) behind an **injectable `MediaQueryProvider`** seam (the `useWakeLock` `apiOverride` pattern, component-tested with a fake `MediaQueryList`); (4) the Foundry **Modal & Tooltip** consume the hook to drop their decorative entrance classes **at source** (so no animation event fires) — defence-in-depth alongside the CSS catch-all. **No schema/migration change** — `user_version` stays **17**; no dependency change; precache 2837.58 KiB / 162.42 KiB headroom (+0.79 KiB glue); 892 unit / 90 files / 77 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **44** ✅ | Backlog (developer-chosen) — fresh investigation (PWA installability) | **PWA install affordance** (§2 "Must support installation to Home Screen/Desktop" + the §2 ephemeral-data persistence safeguard — a fresh-investigation pick à la P37/P38/P43). The manifest was install-ready and the persistence banner *told* the user to install manually, but the platform `beforeinstallprompt` event was **captured nowhere** and nothing detected an already-installed/standalone launch — so Chromium's one-tap install was ignored and the nudge showed even when already installed. Now: (1) a pure, feature-detected `isStandaloneDisplay()` seam (`src/lib/env/install.ts`, mirroring `motion.ts`/`theme.ts`); (2) a live `useInstallPrompt()` hook (`src/components/foundry/useInstallPrompt.ts`) that captures + `preventDefault`s `beforeinstallprompt`, exposes `{ canInstall, installed, promptInstall }`, and clears on `appinstalled`, behind an **injectable `InstallPromptApi`** seam (the `useWakeLock` `apiOverride` pattern, component-tested with a fake — no real browser/dialog); (3) the §2 persistence banner gains a one-tap **"Install Gubbins"** primary action when installable (suppressed once standalone — installing is the most reliable route to persistent OPFS storage); (4) a permanent **"App → Install Gubbins"** Settings entry (Install / "Installed" / "Use your browser's menu" by state). **Also removed the bundle-size *budget* entirely** (developer's call — `scripts/check-bundle-size.mjs` is now an informational size *reporter* with no threshold/warning/headroom, so a useful feature is never constrained on size grounds; the "hard-failing bundle CI gate" Backlog item is thereby retired, not deferred). **No schema/migration change** — install state is ephemeral/device (`user_version` stays **17**); no dependency change; precache 2839.97 KiB (reporter only, no budget); 904 unit / 92 files / 78 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **45** ✅ | Backlog (developer-chosen) — fresh investigation (customisable dashboard) | **§3 Customisable Dashboard widget board** (a fresh-investigation pick à la P37/P41/P44: the §3 "Customisable Dashboard … Users can **pin** specific visualisations, 'Low Stock Alerts', 'Soon to Expire' trackers, 'Overdue Items', Project statuses, or quick-links" mandate plus the §2.1 `useLayoutStore` "dashboard widget layout coordinates" were genuinely unbuilt — `DashboardScreen` carried a literal *"built out in later phases"* deferral comment and was a **fixed** board; `useLayoutStore` owned only density+sidebar; and **no "Low Stock Alerts" widget existed at all**). Now: (1) a pure, unit-tested coordinate seam `features/dashboard/dashboard-layout.ts` (`(x,y)` placements, `moveWidget` swap-on-collision, keyboard `nudgeWidget`, `setWidgetVisible`, registry `reconcileLayout` — mirroring the `tree-keyboard.ts`/`list-window.ts` "logic out of the glue" pattern); (2) `useLayoutStore.dashboardLayout` persisted to localStorage (device-local — **no schema migration**); (3) a widget registry (`widgets.tsx`) of 10 self-fetching widgets incl. the **new `Low Stock Alerts`** (new `ItemRepository.listLowStock` — low DISCRETE qty + low CONSUMABLE_GAUGE %, abstract-parent/SERIALISED/inactive-excluded, ordered by remaining fraction; `LOW_STOCK_QTY_THRESHOLD`/`LOW_STOCK_GAUGE_PERCENT`) and **new `Project statuses`** (reuses `useProjects`) plus a **`Quick links`** widget; (4) `DashboardGrid` — native HTML5 **drag-and-drop** (no dep, §2.4.3) + **arrow-key reorder** (a11y) + show/hide + a "Customise" edit mode, collapsing to single-column flow below `sm`. **No schema/migration change** — `user_version` stays **17**; no dependency change; precache 2848.47 KiB (reporter only); 927 unit / 94 files / 79 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). The standing §3 *mandated* gap is now closed; remaining open items are still triggered Backlog entries (below). |
| **46** ✅ | Backlog (developer-chosen) — preference polish | **User-tunable low-stock thresholds** (§3 "Low Stock Alerts" — the clean Phase-45 follow-on the P45 handover flagged as a scope note). Phase 45 shipped the §3 Low Stock widget with **fixed** default thresholds (`LOW_STOCK_QTY_THRESHOLD = 5`, `LOW_STOCK_GAUGE_PERCENT = 15`) while `ItemRepository.listLowStock` already accepted per-call overrides. Phase 46 surfaces both as Tier-2 `usePreferencesStore` preferences (`lowStockQtyThreshold` / `lowStockGaugePercent`, defaulting to the constants), exactly mirroring the Phase-12 `expirySoonWindowDays` seam: new pure clamp helpers `clampLowStockQty` / `clampLowStockGaugePercent` + `LOW_STOCK_QTY_BOUNDS {1,1000}` / `LOW_STOCK_GAUGE_BOUNDS {1,99}` (`features/settings/settings.ts`, unit-tested), defensive clamping in the setters, two number controls in the Settings "Inventory & lifecycle" section (`setting-low-stock-qty` / `setting-low-stock-gauge`), and `LowStockWidget` now reads the prefs and threads them into `useLowStockItems`. **No schema/migration change** — device-local Tier-2 (`user_version` stays **17**); no dependency change; precache 2859.63 KiB (reporter only); 948 unit / 95 files / 80 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **47** ✅ | Backlog (developer-chosen) — fresh investigation (search) | **§3 hybrid text-based search syntax** (a fresh-investigation pick à la P37/P44/P45: the §3 "Advanced Search & Filtering" *Roadmap Task* — "A hybrid text-based syntax (e.g. `cap:voltage>3.3`) should be planned for future power-user expansion but not implemented in the initial phases" — was the last named, genuinely-unbuilt §3 search feature). A new pure, unit-tested parser `src/features/search/parse-text-query.ts` turns a flat query string into the **exact** §5.1 `SearchAST` the Visual Builder edits and `parseASTtoSQL` already consumes — so typing parses *into* the same Tier-3 AST (a new `load` action on `builderReducer`), the graphical builder visibly fills in, and the existing AST→FTS path runs it (one source of truth, no parallel search path). Grammar: `field:text` (CONTAINS) / `field=v` (EQUALS) / `qty>10`·`<`·`=` (numeric compare) / `cap:<key>` (HAS_CAPABILITY) / `cap:<key>>3.3`·`=` (capability compare/EQUALS, numeric or text) / bare word·"phrase" (name CONTAINS), case-insensitive field aliases (`desc`/`mfr`/`qty`), quote-aware. Field/operator validity is single-sourced via `fields.ts`; anything untranslatable (`>` on a text field, a non-numeric quantity, a missing value) returns a typed `{ok:false,error}` so the input surfaces it inline and keeps the previous good search rather than loading a broken tree. UI: a `TextQueryInput` power-search box at the top of the Visual-Builder panel (the graphical builder is the canonical editor below it). **No schema/migration change** — `user_version` stays **17**; no dependency change (native string parsing, §2.4.3); precache 2864.12 KiB (reporter only); 991 unit / 97 files / 81 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **48** ✅ | Backlog (developer-chosen) — search | **Text-search grammar depth + saved searches** (the closest follow-on to P47: the P47 hybrid parser shipped a *flat AND* of terms, leaving nesting/OR/saved-text-searches deferred). The pure parser `src/features/search/parse-text-query.ts` is deepened from a flat term list into a real **recursive-descent boolean parser** (a lexer emitting `TERM`/`OR`/`AND`/`LPAREN`/`RPAREN`, then `orExpr := andExpr (OR andExpr)*` with `AND` binding tighter than `OR`, and parentheses for grouping): `a OR b` / `a|b` → an OR group, `( … )` → an explicit nest, redundant brackets flatten, an empty `()` / dangling `OR` contribute nothing. It emits the **exact** §5.1 nested `SearchAST` the Visual Builder already edits and `parseASTtoSQL` already translates (which has *always* supported OR + nested groups to the depth-4 cap — only the text parser was flat), so there is **no** reducer/SQL change. Untranslatable input (unbalanced parens, a leaf error inside a group, a tree nested past `MAX_AST_GROUP_DEPTH`) returns a typed `{ok:false,error}` — enforced end-to-end by running the built tree through the real `parseASTtoSQL` as a final gate (**the text path can never emit an AST the single SQL translator would reject**). **Saved searches**: a power user can name, recall and delete a query — pure add/dedupe/cap logic in `src/features/search/saved-searches.ts` (`addSavedSearch`/`removeSavedSearch`, `MAX_SAVED_SEARCHES` 50, injectable `makeId`, case-insensitive upsert-by-name), persisted device-local through the new `useSavedSearchesStore` (Zustand `persist`, `gubbins:saved-searches`), surfaced by `SavedSearchMenu` under the `TextQueryInput` box (recall chip with a Foundry **Tooltip** query preview — never HTML `title`; the save control is a `<div>` not a nested `<form>`, since it lives inside the TextQueryInput form). **No schema/migration change** — saved searches are device-local Tier-2 (`user_version` stays **17**); no dependency change (native string parsing, §2.4.3); precache 2868.38 KiB (reporter only); 1022 unit / 99 files / 82 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **49** ✅ | Backlog (developer-chosen) — fresh investigation (printing) | **Batch QR label-sheet printing** (§6 "Printable QR generation" — a fresh-investigation pick à la P37/P44/P45/P47: the §6 deliverable shipped only a *single-item* printable QR (`QrCodeDialog`); there was no way to print a whole **sheet** of labels). A new pure, unit-tested `src/features/inventory/qr-label-sheet.ts` (`buildLabelSheetHtml` → a complete self-contained A4 label-grid HTML document; `toLabelCells` shared with the on-screen preview so the two can't diverge; `MAX_LABELS = 500` cap; HTML-escaped names) composes many labels at once, reusing the lean hand-rolled `qrSvg` encoder (§2.4.3) + the canonical `buildItemQrUrl` deep-link. Surfaced via a **multi-select mode** on the inventory list (a "Select" header toggle → row/card checkboxes + a selection action bar with Print labels / Clear / Done) feeding a `PrintLabelsDialog` preview-and-print modal (the print itself opens a fresh window with the pure-built sheet, mirroring `QrCodeDialog`). Selection is **ephemeral Tier-3 screen state keyed by id→name**, so it survives the bounded virtualised-list window (a selected item whose page was trimmed off still prints) and spans filter changes. **No schema/migration change** — `user_version` stays **17**; no dependency change; precache 2873.97 KiB (reporter only); 1034 unit / 101 files / 83 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **50** ✅ | Backlog (developer-chosen) — fresh investigation (scanner ergonomics) | **§6.3 Continuous-Mode "Move all to a location" batch action** (a fresh-investigation pick à la P37/P44/P45/P47/P49: the §6.3 Continuous-Mode finalisation — "apply a batch action (e.g., **moving all 3 items to a new location**)" — shipped only **one** of its two named actions, "Check out all" to a contact; the spec's *headline illustrative* batch action, moving the whole queue to a location, was unbuilt). The continuous working-queue review panel now offers a **"Move all to…"** action alongside "Check out all": a location picker (reusing `useLocations`) + a button that loops `ItemRepository.move(id, locationId)` over the queue and re-homes every scanned item, then clears the queue and resumes scanning. Both queue actions now route through a new pure, unit-tested seam `src/features/scanner/batch-actions.ts` (`runBatch` — a partial-failure partition so one rejected item never aborts the rest; `summariseBatch` — a screen-reader-friendly outcome line, mirroring the `cycle-count.ts`/`qr-label-sheet.ts` "logic out of the glue" pattern), so the pre-existing "Check out all" path also stops silently swallowing per-item errors and now **announces its outcome** via the always-mounted `LiveRegion` notice (a small consistency win). **No schema/migration change** — `move` is an existing write; `user_version` stays **17**; no dependency change; precache 2875.21 KiB (reporter only); 1043 unit / 102 files / 84 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). The §6.3 finalisation deliverable now ships both named batch actions; remaining open items are still triggered Backlog entries (below). |
| **51** ✅ | Backlog (developer-chosen) — fresh investigation (three small picks) | **Accessible form errors + offline indicator + gauge refill** (a fresh-investigation pick à la P37/P44/P45/P47/P49/P50; the developer chose to land *all three* audited candidates, starting with the a11y one). **(1) Accessible form-field errors (§3 / WCAG 3.3.1 Error Identification, 1.3.1 Info & Relationships, 4.1.3 Status Messages):** validation errors were shown as red text but in ~25 of 26 form files were *not* programmatically tied to their control (`aria-describedby`) nor announced (`role="alert"`) — `aria-invalid` existed in exactly **one** file. A new Foundry **`FormField`** primitive (`src/components/foundry/field.tsx`) wraps a labelled control, injects `aria-invalid` + `aria-describedby` onto it *only when invalid* (via `cloneElement`, child props always win), and renders the message in a `role="alert"` element *outside* the `<label>` (so it never folds into the control's accessible name) that announces on insertion. The conditional-attribute logic is the pure, unit-tested **`fieldAria`** seam (`field-aria.ts`, mirroring `liveRegionAttrs`). Adopted across the three RHF+Zod per-field forms (CreateItemDialog — replacing its local `Field`; CreateProjectDialog; AddBomLineDialog), and the four form-level submit-error strings that lacked it (CheckoutDialog, MaintenanceEditor, CategoryManagerDialog, LifecycleEditor) gained `role="alert"`. **(2) Global offline/online indicator (§2 offline-first):** there was no connectivity indicator anywhere. A pure feature-detected **`isOnline()`** seam (`src/lib/env/network.ts`, mirroring `install.ts`/`motion.ts`) + a live **`useOnlineStatus`** hook (`src/components/foundry/useOnlineStatus.ts`) behind an injectable **`OnlineStatusApi`** seam (the `useInstallPrompt` pattern, component-tested with a fake) drive a root-layout **`OfflineIndicator`** (`src/components/OfflineIndicator.tsx`): a reassurance pill ("Offline — changes saved locally") shown *only* when offline, with the transition announced via an always-mounted `LiveRegion` (the new genuinely-silent surface WCAG 4.1.3 wanted). **(3) Consumable-gauge refill (§4.1.2):** a gauge could only be consumed/weighed; a third **"Refill"** mode in `GaugeAdjustDialog` (with a "Fill to full" shortcut) tops a spool back up, and `adjustGauge` now clamps the net value to the full range `[0, grossCapacity]` (an over-fill/over-eager refill caps at capacity, never `>100%`). Pure, unit-tested `clampNetValue`/`refillToFullAmount`/`refillDelta`/`refillNote` in `gauge.ts`; every mode still converts to a relative delta in the React layer (the §4.1.2/§7.3 CRDT rule). **No schema/migration change** — `user_version` stays **17**; no dependency change; precache 2877.17 KiB (reporter only); 1063 unit / 106 files / 87 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **52** ✅ | Backlog (developer-chosen) — fresh investigation (in-app auditing) | **§4 Activity Log in-app viewer** (a fresh-investigation pick à la P37/P44/P45/P47/P49/P50/P51: the §4 "Activity Log — A Persistent Action History attached to items, retaining an immutable ledger of movements and quantity changes for **long-term auditing**" was *written* by every mutation and *exported* into the §4.5 Markdown vault, but **rendered by no component** — `useItemHistory` existed yet the immutable ledger was invisible in-app, so auditing from inside Gubbins was impossible). The Item Detail dialog gains an **"Activity log"** section (`ActivityLog.tsx`) rendering the per-item ledger newest-first: each row is a pure, unit-tested **`describeHistoryEntry`** (`src/features/inventory/history-format.ts`) → `{ label, detail, delta, tone }` mapping all 21 `HISTORY_ACTIONS` to British-English titles (forward-compat `humanise` fallback for an action a newer peer synced) + the stored note + a signed delta badge. This **also clears the standing Phase-37 residual**: `useItemHistory` was the one infinite query left *unbounded* "if a paginated item-history view is ever surfaced" — it now gets the documented `maxPages` + `getPreviousPageParam` + absolute-index `list-window.ts` treatment, and the new view renders through the same virtualised window as the inventory list (a heavily-used consumable's thousands of `GAUGE_UPDATE` rows stay light). **No schema/migration change** — `item_history` already exists (synced since P11); `user_version` stays **17**; no dependency change; precache 2883.56 KiB (reporter only); 1074 unit / 107 files / 88 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **53** ✅ | Backlog (developer-chosen) — §4 spec gap (attachments) | **§4 "Unlinked Local File" cross-device degradation** (the one genuinely *unbuilt* §4 spec requirement, flagged "considered but not picked" by the P52 handover). §4 Attachments Option B (Hybrid Pointers) mandates that a `LOCAL_POINTER` synced to a *secondary* device — where the literal path is invalid — "gracefully degrade to display an 'Unlinked Local File' placeholder, prompting the user to either supply a new local path for that device or an external URL", and "never attempt to upload or download the heavy file blob". That degradation was unbuilt: a foreign pointer just showed its dead path with a tooltip. Now a device knows which device created a pointer via the additive, **nullable v18 `item_attachments.origin_device_id`** (stamped with the current device's id — a `crypto.randomUUID()` persisted device-local in `localStorage` via the new pure-ish `lib/env/device-id.ts` `getDeviceId`; a URL carries no origin; a legacy pre-v18 NULL-origin pointer is treated as local, non-regressive). The foreign/local/url decision is the pure, unit-tested **`resolveAttachmentLink(attachment, currentDeviceId)`** seam (`src/features/inventory/attachment-link.ts`, mirroring `resolveTheme`/`describeHistoryEntry`). `AttachmentManager` renders an unlinked pointer as an "Unlinked Local File" placeholder with a **Re-link** (supply a new local path → restamps origin to this device) or **Use URL** (replace with a validated external URL → clears origin) inline flow, both routed through `AttachmentRepository.update` (extended to switch `kind` + restamp `origin_device_id`). The column is NOT an FK (a device id is a synthetic identity, no `FK_REFS`/null-out) and SHOULD sync (the receiving device needs the origin to compare), so it is deliberately *not* in `SYNC_EXCLUDED_COLUMNS` — `item_attachments` is already in `SYNC_TABLES` and the LWW schema dictionary reads columns live via `PRAGMA table_info`, so it round-trips automatically. `user_version` is now **18** (first bump since Phase 30's v17). No dependency change; precache 2888.21 KiB (reporter only); 1091 unit / 110 files / 91 smoke. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **54** ✅ | Backlog (developer-chosen) | **Location description + colour swatch** (§4 Locations — richer location metadata). Additive **v19** nullable `locations.description TEXT` + `locations.color TEXT`; the colour is a **semantic swatch key** (`'teal'`) → `text-loc-*`/`bg-loc-*` design tokens via the static-literal maps in `features/inventory/location-color.ts` (never a raw hex — CLAUDE.md). Edited via a `Textarea` + `ColorSwatchPicker`; the new columns were added to `LocationRepository`'s explicit `SELECT_WITH_COUNT`. Both columns auto-join the LWW payload (`locations` ∈ `SYNC_TABLES`); neither is an FK. `user_version` is now **19**. Remaining open items are still triggered Backlog entries (below). |
| **55** ✅ | Backlog (developer-chosen) | **Coloured Add-Item location picker** (§4 — finishing the P54 colour story so *every* location surface shows its swatch). The Add Item form's location field became a tinted **`LocationSelect`** combobox driven by an RHF **`Controller`**, named via a sibling `<span id>` + `labelledBy` (the **`FormField` can't name a custom `role=combobox`** trap) rather than `FormField`. **No schema change** — `user_version` stays **19**; the smoke drives the combobox by open + click-option (never `selectOption`). Remaining open items are still triggered Backlog entries (below). |
| **56** ✅ | Backlog (developer-chosen) — fresh investigation | **Surfaced the §4.1.1 operational-metadata layer** (the one Consumable-Gauge schema field stored/mapped/synced since **v2** yet rendered by **no** component). Promoted from gauge-nested to a **top-level `Item.operationalMetadata: Record<string,unknown> | null`** read for all rows; `UpdateItemInput.operationalMetadata` + an `ItemRepository.update` branch persist it (empty → SQL NULL). Pure **`operational-metadata.ts`** seam (`buildMetadata`/`metadataToRows`/`coerceMetadataValue`, Zod-validated) + an **`OperationalMetadataEditor`** free-form key→value editor saving wholesale via `useUpdateItem`. **Concurrent refactor folded in:** `ItemDetailDialog` reworked into a WAI-ARIA APG vertical **tabs** layout (five tabs) with pure `tab-keyboard.ts` (`resolveTabKey`) — **only the active tab's panel is mounted** (smoke clicks the tab first), and **two section editors can share a button label** → scope by `data-testid`. **No migration** — `user_version` stays **19**; 1153 unit / 117 files / 93 smoke. Remaining open items are still triggered Backlog entries (below). |
| **57** ✅ | Backlog (developer-chosen) — fresh investigation (polish) | **Mutable scanner feedback** (§6.5 — a fresh-investigation pick after the developer correctly flagged the alternative KiCad-XML-netlist candidate as YAGNI: KiCad's first-class BOM export is already CSV, which `bom-import.ts` handles, so an XML-netlist path served only a hypothetical user with no live trigger). The §6.5 non-visual confirmation — a Web-Audio **beep** + `navigator.vibrate` **haptic** — fired on **every** successful scan via `ScanFeedback.confirm()` and was **completely unconfigurable** (no mute anywhere), a real present-day annoyance (quiet/shared workshops, sensory preference). `confirm()` now takes per-call `{ beep, haptics }` flags (both default **on** — never a regression), unit-tested by spying on the browser-only `beep`/`vibrate` members (`feedback.test.ts`, +4). Two boolean Tier-2 prefs **`scannerBeep`/`scannerHaptics`** (default true, mirroring `kioskMode` — booleans need no normalisation seam, so no contrived pure module) + setters in `usePreferencesStore`; `ScannerOverlay` reads both and threads them through both `confirm` call sites (added to the `handleDecode` deps). Two **On/Off** controls (`setting-scanner-beep`/`setting-scanner-haptics`) added to the existing **Scanner** Settings section beside the P34 symbology control. **No schema/migration change** — device-local Tier-2 (`user_version` stays **19**); no dependency change; precache 2940.99 KiB (reporter only); **1159 unit / 118 files / 94 smoke**. **`build:extension` NOT re-run** (no §9 / `extension/` edit). Remaining open items are still triggered Backlog entries (below). |
| **Backlog** | Conditional / YAGNI (revisit on trigger) | multi-scrape UI tray, live distributor selector maintenance, true NTP/cross-origin time source, leaner/precache-excluded WASM decoder (offline-scanning trade-off; **note the precache *budget* was removed in P44, so there is no longer a size gate forcing this**), **KiCad XML intermediate-netlist import** (a P57-audited candidate consciously **deferred as YAGNI** — KiCad 6/7/8 export BOMs as CSV directly and `bom-import.ts` already maps KiCad's CSV columns, so an `.xml` netlist parser serves only a narrow hypothetical with no live trigger; revisit if a user actually arrives with a raw KiCad netlist), **further `aria-live` coverage** (the headline cases — skip-to-content link + Inventory result-count region (P40), Sync outcome + scanner manual-entry feedback (P42), batch-action outcome (P50), **form-field validation errors + the offline/online transition (P51)** — are done; any *new* region now needs a genuinely silent in-place status surface to justify it). *(Retired in P44: the hard-failing bundle-size CI gate — the budget it would have enforced was removed outright. Retired in P46: the fixed-low-stock-threshold scope note — thresholds are now user-tunable preferences. Retired in P47: the §3 "hybrid text-based syntax" roadmap task — now implemented. Retired in P48: the "text-search grammar depth" Backlog note — OR/parenthesised nesting **and** saved searches now ship. Retired in P50: the §6.3 "move all to a location" batch action — now implemented alongside "Check out all". Retired in P52: the Phase-37 `useItemHistory` unbounded residual — the item-history view is now surfaced and the query is bounded. Retired in P53: the §4 "Unlinked Local File" cross-device degradation — now implemented (v18 origin device + `resolveAttachmentLink` + re-link/replace-with-URL flow). Retired in P57: the §6.5 always-on scanner feedback — beep + haptic are now independently mutable Tier-2 preferences.)* |

## Deferred out of Phase 7 (Cloud Sync) — agreed 2026-06-27

Phase 7 ships "Core sync + File System Access" (the full reconciliation engine, tombstones, NTP
offset guard, §7.4 pre-flight Hard Stop, FS Access auto-save, versioned-JSON import/restore, the
Initial-Handshake wizard). The following §7.6 OPFS-quota-recovery pieces were **deferred, not
dropped** — and are now **delivered in Phase 10**:

- [x] **§7.6.2 Storage Triage Dashboard** — **done in Phase 10.** A `StorageTriageDialog` reached from
      the critical/locked `StorageBanners` ("Manage storage"), breaking down OPFS consumption by table
      (`item_images`, `item_history`, `items`) via `StorageRepository.rowCounts()` × the pure
      `AVG_ROW_BYTES` heuristics in `features/storage/triage.ts` (§7.6.2 row-count × avg-byte estimate).
- [x] **§7.6.3 Workflow A — Action History Pruning** — **done in Phase 10.** `archiveAndPruneHistory`
      collects the targeted `item_history` rows (paginated to completion), downloads
      `inventory_history_archive_<stamp>.json` **first**, then `StorageRepository.pruneHistoryBefore`
      DELETEs them. Cutoff via the pure, clamped `pruneCutoff(now, months)`.
- [x] **§7.6.3 Workflow B — Image Downgrading** — **done in Phase 10.** `downgradeImagesBefore` deletes
      each stale full-resolution OPFS file and stamps the additive **v9** `item_images.full_res_downgraded_at`
      marker, keeping the thumbnail. Local-only: `item_images` is not in `SYNC_TABLES`, so it never
      propagates to cloud sync (§7.6.3 B). Both recovery writes deliberately bypass the Hard Stop (a
      DELETE / a space-freeing UPDATE must succeed even when locked, or the user stays bricked).

> **Interaction noted (not a blocker):** pruning `item_history` can drop `GAUGE_UPDATE` rows that the
> §7.3 Delta-CRDT would replay for *unsynced* gauge usage. This is the spec's accepted trade-off — the
> cold-storage JSON is the safeguard — and is consistent with `item_history` still being outside the
> synced set (see below). Revisit if/when the ledger joins `SYNC_TABLES`.

### Sync-set expansion (the synced/backed-up table set)

Phase 7's sync engine, versioned-JSON backup and import cover the **six core entity tables**
(`locations`, `categories`, `items`, `capabilities`, `contacts`, `checkouts` — the §7.1-named tables
plus the Phase 6 borrowing entities). They are all scalar-column, JSON-safe and LWW-simple. The
following tables are **not yet in the synced/backup set** and must be added later so a sync/backup is
genuinely whole (`SYNC_TABLES` in `src/db/repositories/tombstone.ts` is the single point to extend):

- [x] **`item_aliases`** — **done in Phase 8.** It carries its own `updated_at` + auto-stamp trigger,
      so it joined `SYNC_TABLES` (after `items`, FK-safe) and resolves by row-level LWW like the entity
      tables; `setAliases` is now a tombstone-aware diff (stable ids for retained aliases) and the
      reconcile engine resolves the §4 alias-text UNIQUE collision by LWW. So scraped supplier↔item
      mappings now propagate across devices.
- [x] **M:N joins & leaf rows** — **done in Phase 11.** The LWW leaf/definition tables (`tags`,
      `category_fields` + `item_field_values`, `projects` + `project_bom_lines`, `item_attachments`)
      joined `SYNC_TABLES` in FK-safe order and resolve by row-level LWW (each carries its own
      `updated_at`); their repositories now record a tombstone on every independent delete. The one true
      timestamp-less join, **`item_tags`**, is reconciled by **membership** — a tombstone-wins union keyed
      by `itemTagEdgeId(itemId, tagId)` edge tombstones (an unlink propagates; a re-add is possible once
      the edge tombstone is TTL-pruned).
- [x] **Activity Ledger** — **done in Phase 11.** `item_history` is synced as a dedicated snapshot
      section reconciled by **union-by-id** (immutable rows share a UUID across devices). The §7.6.3-A
      local prune divergence is handled by the additive **v10** `sync_meta.history_pruned_before`
      watermark: a device that pruned its ledger refuses to re-import remote rows older than the watermark
      (advanced monotonically by `pruneHistoryBefore`). The §7.3 Delta-CRDT still reads `gaugeHistory`.
- [x] **Images** — **done in Phase 11.** `item_images` joined `SYNC_TABLES`; the `thumbnail_blob` BLOB is
      base64-encoded into the JSON payload (decoded on write) so the snapshot is JSON-safe, while the
      full-res OPFS bytes stay local (§4 strict isolation — the §4.5 vault / raw export carry those). The
      Phase-10 `full_res_downgraded_at` marker is held back via `SYNC_EXCLUDED_COLUMNS` so a local
      downgrade never mis-marks a peer (§7.6.3-B). A clone/restore now carries images, so the §7.2 TTL
      wipe-and-clone no longer loses them.

Structured-data backup/restore is now whole: a versioned-JSON backup round-trips every entity table, the
M:N membership, the Activity Ledger and image thumbnails. (Full-resolution image bytes remain a local /
§4.5-vault concern by design.)

## Deferred out of Phase 8 (External Data Scraping) — agreed 2026-06-27

Phase 8 ships the full §9 secure bridge (origin + Zod validation, silent-drop), the §4 no-overwrite
merge, the Strategy-pattern parsers with DOM-drift handling, the lean companion MV3 extension, and the
create + edit/refresh scrape UI. Deferred (not dropped):

- [x] **Supplier parser coverage** — **done in Phase 13.** Six host-specific §9.4.1 Strategy parsers shipped
      — Mouser, Farnell, LCSC, RS, **Adafruit, SparkFun** — alongside the existing DigiKey + generic-metadata
      fallback, each a one-file config (`src/features/scraping/parsers/<id>-parser.ts`) built by the
      `makeSupplierParser` factory (host CSS selectors first, shared `readStructuredMetadata` fallback, throws
      `DomDriftError` on a genuinely-absent MPN) and registered in `registry.ts`. The production
      `manifest.json` `host_permissions` is narrowed from `<all_urls>` to the supplier domain allowlist
      (`suppliers.ts` `EXTENSION_HOST_PERMISSIONS`, cross-checked by `host-permissions.test.ts` so it can't
      drift back).
- [x] **Scrape notification settings UI** — **done in Phase 12.** The `scrapeNotifications` preference
      (`TOAST` default | `SILENT`, §4) now has a control in the new Settings screen
      (`src/features/settings/SettingsScreen.tsx`), bound to `usePreferencesStore`.
- [x] **Multi-scrape correlation** — **done in Phase 13.** A required `requestId` was added to the
      `SCRAPE_REQUEST`/`SCRAPE_RESULT`/`SCRAPE_ERROR` envelope (a breaking §9 wire change → the extension was
      rebuilt). The bridge reducer is now a **map keyed by `requestId`**, so several scrapes can be in flight
      at once and each outcome routes to the request that started it; a result with an unknown/stale id is
      ignored (no cross-talk). `requestScrape` returns the generated id and `ScrapeSupplierPanel` tracks only
      its own request. The smoke proves a wrong-id result is dropped while the correlated id fills the form.

## Deferred out of Phase 13 (Scraping & extension hardening) — agreed 2026-06-27

Phase 13 shipped the six new §9.4.1 parsers (Mouser/Farnell/LCSC/RS/Adafruit/SparkFun via the
`makeSupplierParser` factory), the narrowed production `host_permissions` (manifest cross-checked by a
test), and full-concurrent multi-scrape `requestId` correlation (map-based bridge reducer; required
envelope field; extension rebuilt). Scope was confirmed with the developer at entry. The following small
residuals are **deferred, not dropped**:

- [ ] **Multi-scrape UI tray** — **→ Backlog** (trigger: a real surface that fires several scrapes at once,
      e.g. bulk BOM ingress). The bridge now *supports* N concurrent scrapes (the reducer is a map and
      `pendingCount` is exposed), but the UI still drives one scrape per `ScrapeSupplierPanel` because only one
      item dialog is open at a time. A "pending scrapes" tray/badge surfacing several in-flight results is only
      worth building when a concurrent-scrape entry-point exists.
- [ ] **Live distributor selector maintenance** — **→ Backlog** (trigger: a real scrape against a live
      supplier failing). The host CSS selectors in each `<id>-parser.ts` are documented **best-effort** and
      will drift as suppliers change their markup; the structured-metadata fallback + `DomDriftError` keep this
      safe (never NaN/partial), and the §9.4.1 one-file design makes a fix a single-file change. There is no
      automated check that the selectors still match real pages (the unit tests run against captured fixtures).
- [x] **`SCRAPE_ERROR` taxonomy depth** — **done in Phase 35.** The §9.4.2 enum gained three HTTP-status-driven
      members — **`BLOCKED`** (401/403/other-4xx), **`NOT_FOUND`** (404/410), **`SERVER_ERROR`** (5xx) — alongside
      the original `DOM_DRIFT` / `NETWORK_TIMEOUT` (now transport-only) / `RATE_LIMITED` (429). The status→type
      mapping is the pure, unit-tested `classifyHttpStatus` (`src/features/scraping/scrape-errors.ts`, shared with
      the extension background worker), and the §9.4.3 per-type degradation toast wording is the pure
      `describeScrapeError`. Breaking §9 wire change → extension rebuilt. (A heuristic `CAPTCHA` body-detection
      tier was consciously left out — see the Phase-35 deferral note below.)

## Deferred out of Phase 14 (Export/import & sync resilience) — agreed 2026-06-28

Phase 14 delivered the full slice the developer confirmed at entry (**"Everything"**): scoped exports
(§4.5 single-item / Project-BOM / whole-inventory), vault asset extraction (full-res images + thumbnails
out of OPFS into `/assets`, datasheet links, project master note), raw `.sqlite` restore (Safe Mode), the
§2.7 mobile weekly Full Archive, an HTTP `Date`-header time source for the §7.3 offset guard, FS Access
directory persistence across sessions, and the three Phase-11 sync residuals (clone-path ledger watermark,
non-item child-FK guard, full-res bytes via vault/archive/raw-restore). **No schema migration was needed**
— the new bookkeeping is device-local (the `lastArchivedAt` preference in `localStorage`, the FS handle in
IndexedDB), so `user_version` stays **10**. The following small residuals are **deferred, not dropped**:

- [x] **Restore-from-archive (re-hydrate OPFS images)** — **done in Phase 17.** Safe Mode now offers
      "Restore full archive (.zip)" alongside the raw-`.sqlite` restore: `restoreArchive`
      (`src/features/archive/restore-archive.ts`) unzips the §2.7 archive (`unzipSync`), validates it via the
      pure `readArchive`/`parseArchive` (reusing `isSqliteFile`; throws `InvalidArchiveError` before any write),
      then disposes the worker, overwrites the OPFS DB through the shared `overwriteOpfsDatabase`, and writes the
      full-resolution images back via the new `writeImageFiles` (each keyed by its original `images/<uuid>.webp`
      name, so it lines up with `item_images.full_res_opfs_path` with no remapping), and reloads. The archive
      layout is now centralised (`ARCHIVE_DB_ENTRY` / `ARCHIVE_IMAGES_PREFIX` in `auto-archive.ts`, shared by
      builder + restore so they can't drift). Pure-unit-tested (`restore-archive.test.ts`) + smoke-asserted
      (a real `buildFullArchive` → wipe OPFS image → `readArchive` + `writeImageFiles` → byte-for-byte re-read).
- [ ] **True NTP server / cross-origin time source** — **→ Backlog** (trigger: same-origin time proves
      insufficient). `httpTimeSource` reads the `Date` header of a same-origin HEAD (the `Date` header is not
      CORS-safelisted, so a public time API would need `Access-Control-Expose-Headers: Date`). This is accurate
      enough for LWW on a GitHub Pages host; a dedicated time endpoint or a JSON time API could replace it.
- [x] **Project-scope folder layout (§4.5 sub-folders)** — **done in Phase 19.** A Project/BOM-scope vault now
      packs into one self-contained project folder: `buildVault` gained a `rootFolder` option that prefixes every
      note and asset, and the pure `buildProjectVault(projectName, vaultItems)` composer roots the vault at the
      sanitised project folder and drops the master note inside it (`<Project>/<Project>.md`), so the layout is
      `<Project>/<Location>/<Item>.md` + `<Project>/assets/…` (the master note's bare wiki-links still resolve to
      the nested component notes). `run-export` reorders the project fetch ahead of the vault build to feed the
      root folder. Pure-unit-tested (`export-data.test.ts`: rootFolder nesting/sanitise/fallback + `buildProjectVault`)
      + smoke-asserted (a real Project-scope vault export whose every entry nests under the project folder, with the
      master note and a component sub-folder note present).
- [x] **Auto-archive smoke coverage** — **done in Phase 15.** A dedicated mobile-emulation Playwright context
      (390×844, `isMobile`, mobile `userAgentData` forced, no Cloud Sync) now drives the §2.7 weekly Full-Archive
      banner end-to-end (`run-archive` → `.zip` download). The same context doubles as the §6.6 WASM-scanner
      smoke (BarcodeDetector forced absent → the fallback engine resolves).

## Deferred out of Phase 15 (Scanner, search & performance polish) — agreed 2026-06-28

Phase 15 delivered the slice the developer confirmed at entry: the §6.6 scanner **WASM fallback**
(lazy `@zxing/browser`, native-first), weighted-capability **"best match" ranking**, **`AVG_ROW_BYTES`
accuracy** (measured OPFS image bytes), a **warn-only bundle-size budget**, and the carried-over §2.7
**auto-archive mobile smoke** (plus the §6.6 WASM-scanner smoke in the same mobile context). **No schema
migration was needed** — nothing added persistent bookkeeping, so `user_version` stays **10**. The
bundle-size budget item was deliberately scoped to warn-only (not a build-failing gate). The following
small residuals are **deferred, not dropped**:

- [ ] **Hard-failing bundle-size CI gate** — **→ Backlog** (trigger: a CI size-gate is wanted). The budget
      reporter is warn-only by the developer's decision; flipping it to exit non-zero past the budget is a
      one-line change in `scripts/check-bundle-size.mjs`.
- [x] **WASM scanner decode performance** — **done in Phase 31.** The fallback no longer decodes on the main
      thread: each frame is captured to an `ImageBitmap` and **transferred** into a Web Worker that runs the
      zxing core decode on an `OffscreenCanvas` (`src/features/scanner/barcode-decode.worker.ts`), so live
      scanning never janks the UI. The worker uses the leaner `@zxing/library` core (the old `@zxing/browser`
      dep was dropped); it replaces the main-thread decoder as the sole `'wasm'` tier, gated by the pure
      `supportsWorkerDecode`. See the Phase-31 section below for the per-piece detail.
- [ ] **Leaner / precache-excluded WASM decoder** — **→ Backlog** (trigger: the bundle budget needs reclaiming).
      The lazy `@zxing/browser` chunk (~460 KiB) is still **precached** so offline Firefox/Safari can scan; if
      the precache budget becomes pressing it could be excluded from the precache glob (sacrificing offline
      fallback scanning) or swapped for a smaller decoder.

## Deferred out of Phase 16 (Backlog consolidation / final polish) — agreed 2026-06-28

Phase 16 delivered the two Backlog items the developer confirmed at entry: **end-to-end currency/locale
propagation** (§3) and the **"System / auto" theme** (§2.1). The formatting debt is now closed — every
`Intl`/currency call site routes through the pure `makeFormatters(locale, currency)` factory bound to
`usePreferencesStore` by the `useFormatters()` hook — and the theme control gained a `'system'` option that
tracks the OS `prefers-color-scheme` live. **No schema migration was needed** (both are device-local Tier-2
preferences already persisted to `localStorage`), so `user_version` stays **10**. The remaining Backlog items
were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals tracked in the
roadmap Backlog row above:

- [x] **Restore-from-archive (re-hydrate OPFS images)** — **done in Phase 17** (see the Phase-14 section
      above for the per-piece detail).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [x] **§4.5 project-scope sub-folders** — **done in Phase 19** (see the Phase-14 section above for the per-piece detail).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Nested multi-level variants / maintenance usage telemetry / In-Transit physical location /
      non-DISCRETE cycle count** — **→ Backlog** (carried from Phase 9).

> These are the genuinely conditional/YAGNI items the specification left to a real trigger. None has a concrete
> trigger today; each remains in the roadmap Backlog row so it can be picked up the moment one appears.

## Deferred out of Phase 17 (Restore-from-archive image re-hydration) — agreed 2026-06-28

Phase 17 delivered the one Backlog item the developer confirmed at entry: **restore-from-archive image
re-hydration** (§2.7/§3) — Safe Mode's "Restore full archive (.zip)" now unzips the §2.7 Full Archive,
overwrites the OPFS database **and** writes the full-resolution OPFS images back, closing the fresh-device
recovery loop Phase 14 left half-open. **No schema migration was needed** (the archive carries the existing
schema's binary; nothing new persists), so `user_version` stays **10**. The remaining Backlog items were
**not in scope and are re-scheduled, not dropped** — all are still triggered conditionals tracked in the
roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [x] **§4.5 project-scope sub-folders** — **done in Phase 19** (see the Phase-14 section above for the per-piece detail).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Nested multi-level variants / maintenance usage telemetry / In-Transit physical location /
      non-DISCRETE cycle count** — **→ Backlog** (carried from Phase 9).

> Every remaining open item is now a genuinely conditional/YAGNI Backlog entry with **no live trigger today**.
> Phase 18 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious
> no-op until a real trigger appears).

## Deferred out of Phase 18 (Nested multi-level variants) — agreed 2026-06-28

Phase 18 delivered the one Backlog item the developer confirmed at entry: **nested multi-level variants**
(§4 Variant/SKU) — the Phase-9 single-level cap is lifted so a variant may itself hold sub-variants to any
depth (grandparent SKUs and deeper). Cycle rejection (§7.5.3) is the sole surviving structural invariant,
enforced by a recursive ancestor-CTE guard in `ItemRepository.assertVariantLinkValid` driving the pruned
pure `validateVariantLink`. **No schema migration was needed** — the `parent_id` self-FK has existed since
the v8 lifecycle migration and nothing new persists, so `user_version` stays **10**. The remaining Backlog
items were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals tracked
in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [x] **§4.5 project-scope sub-folders** — **done in Phase 19** (see the Phase-14 section above for the per-piece detail).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Maintenance usage telemetry / In-Transit physical location / non-DISCRETE cycle count** —
      **→ Backlog** (carried from Phase 9).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 19 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 19 (§4.5 Project-scope vault sub-folders) — agreed 2026-06-28

Phase 19 delivered the one Backlog item the developer confirmed at entry: **§4.5 Project-scope vault
sub-folders** — a Project/BOM Markdown-vault export now nests into one self-contained project folder (master
note + component notes in their Location sub-folders + shared `/assets`), completing the literal §4.5 layout
the Phase-14 flat output approximated. **No schema migration was needed** (the change is in the pure vault
builders + the export orchestrator; nothing new persists), so `user_version` stays **10**. The remaining
Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals
tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Maintenance usage telemetry / In-Transit physical location / non-DISCRETE cycle count** —
      **→ Backlog** (carried from Phase 9).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 20 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 20 (In-Transit physical quantity) — agreed 2026-06-28

Phase 20 delivered the one Backlog item the developer confirmed at entry: **In-Transit physical quantity**
(§4 liminal procurement) — incoming/ordered stock now surfaces as a distinct per-item quantity, derived from
the item's `IN_TRANSIT` BOM lines (`ProjectRepository.inTransitQtyForItem`) and shown beside on-hand stock on
the item detail, so it is no longer overloaded onto on-hand `quantity`. The developer chose the **derived
projection** over a stored `v11` column precisely to avoid denormalisation drift; **no schema migration was
needed**, so `user_version` stays **10**. The remaining Backlog items were **not in scope and are
re-scheduled, not dropped** — all are still triggered conditionals tracked in the roadmap Backlog row above:

- [x] **Per-location stock ledger / literal In-Transit-location stock** — **done in Phase 25.** The
      one-`location_id`-per-item cap is lifted: a new synced **v13** `item_stock` table is the SSOT for *where*
      the units are (one row per `(item, location)`), `items.quantity` becomes the derived `SUM(item_stock.quantity)`,
      and the new pure `planTransfer` + `ItemRepository.transferStock` split an item's stock across locations.
- [x] **Partial / split receipts** — **done in Phase 24.** An `IN_TRANSIT` BOM line is now received into stock in
      instalments: the additive **v12** `project_bom_lines.received_qty` accumulates each received delta, the line
      stays IN_TRANSIT until cumulative receipts meet the requirement (then flips to RECEIVED), and the Phase-20
      derived In-Transit projection becomes `SUM(required_qty − received_qty)` so only the outstanding remainder
      surfaces as incoming. The clamp/accumulate maths is the pure `planReceipt` (`features/projects/receipts.ts`,
      mirroring the `cycle-count.ts` reconciliation seam); `ProjectRepository.receiveLine` trusts it, adds the
      received delta to a matched DISCRETE item's on-hand and logs one `RECEIVED` ledger entry per instalment. The
      BOM table gained a per-line receive-quantity field (defaulting to the outstanding remainder) beside the
      receive action, plus an "N/M received" progress indicator. `received_qty` is the *primary* record of
      instalment progress (history can be pruned per §7.6.3-A; unmatched / non-DISCRETE lines log no item history,
      so there is no ledger to derive it from), hence persisted; it auto-joins the LWW payload
      (`project_bom_lines` ∈ `SYNC_TABLES`). Pure-unit-tested (`receipts.test.ts`), repo-tested
      (`ProjectRepository.test.ts`: instalment keeps the line open + clears the right incoming remainder;
      over-receipt clamps) + smoke-asserted (receive 2 of 5 → "2/5 received", line stays In-Transit; receive the
      remaining 3 → RECEIVED).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Maintenance usage telemetry / non-DISCRETE cycle count** — **→ Backlog** (carried from Phase 9).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today** (plus the new Phase-20 residuals above, likewise trigger-gated). Phase 21 has no pre-assigned slice
> — confirm scope with the developer at entry (or agree it is a conscious no-op until a real trigger appears).

## Deferred out of Phase 21 (Node-25 unit-pool cold-start flake fix) — agreed 2026-06-28

Phase 21 landed the one item the developer confirmed at entry: a fix for the **Node-25 unit-pool cold-start
flake** — the one *fresh* real-world trigger (this machine runs **Node v25.2.1**, where Vitest's default
`forks` pool hit a tinypool `child_process.fork` cold-start race that crashed the whole run once on a cold
cache: every file reported "no tests" with `TypeError: Cannot read properties of undefined (reading 'config')`
after a ~33 s environment setup). The fix pins **`test.pool: 'threads'`** in `vite.config.ts`: the in-process
`worker_threads` pool sidesteps the child-process spawn race, is stable across cold starts (verified green over
five consecutive cold/warm runs) and ~12× faster wall-clock (2.1 s vs ~26 s). The `:memory:` `node:sqlite`
driver runs correctly under `worker_threads` (594/594) and Vitest's default per-file module isolation is
preserved, so no global state leaks. **No app code, schema or migration change** — `user_version` stays **10**,
and `npm run test:run` / `node node_modules/vitest/vitest.mjs run --no-file-parallelism` both stay green. The
remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **Per-location stock ledger / partial-split receipts** — **→ Backlog** (carried from Phase 20).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Maintenance usage telemetry / non-DISCRETE cycle count** — **→ Backlog** (carried from Phase 9).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 22 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears). The Node-25 flake itself is now **resolved**, not merely a
> documented re-run workaround.

## Deferred out of Phase 22 (Automatic maintenance usage telemetry) — agreed 2026-06-28

Phase 22 delivered the one Backlog item the developer confirmed at entry: **automatic maintenance usage
telemetry** (§4.3) — a USAGE maintenance schedule may now opt in to accrue real **checkout-hours** from the
`checkouts` ledger, closing the Phase-9 "no automatic usage accrual" deferral. The accrued figure is a
*derived projection* (never a stored counter), so the only schema change is the additive **v11**
`accrue_checkout_hours` opt-in column — `user_version` is now **11** (the first bump since Phase 11). The
remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **Non-DISCRETE cycle count** — **→ Backlog** (carried from Phase 9; trigger: a serialised-audit requirement).
- [ ] **Per-location stock ledger / partial-split receipts** — **→ Backlog** (carried from Phase 20).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 23 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 23 (Serialised cycle count) — agreed 2026-06-28

Phase 23 delivered the one Backlog item the developer confirmed at entry: **serialised cycle count** (§4.4) —
the Cycle Count / Reconciliation workflow now audits **SERIALISED** instances by *presence* (each qty-1 unit
flagged present or missing, a missing one reconciled by a reversible soft-delete + `RECONCILED` ledger entry),
closing the Phase-9 "non-DISCRETE cycle count" deferral. The resolution toggles only the existing synced
`is_active` column, so **no schema migration was needed** and `user_version` stays **11**. The remaining
Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals
tracked in the roadmap Backlog row above:

- [ ] **Per-location stock ledger / partial-split receipts** — **→ Backlog** (carried from Phase 20).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 24 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 24 (Partial / split BOM-line receipts) — agreed 2026-06-28

Phase 24 delivered the one Backlog item the developer confirmed at entry: **partial / split BOM-line receipts**
(§4 procurement) — one of the two Phase-20 residuals. An `IN_TRANSIT` line can now be received into stock in
instalments (the additive **v12** `received_qty` accumulates; the line stays IN_TRANSIT until fully received;
the Phase-20 In-Transit projection becomes `SUM(required_qty − received_qty)`), closing the "receiving fewer
units than ordered still clears the whole line" gap. This is the **first schema bump since Phase 22** —
`user_version` is now **12**. The remaining Backlog items were **not in scope and are re-scheduled, not
dropped** — all are still triggered conditionals tracked in the roadmap Backlog row above:

- [x] **Per-location stock ledger** — **done in Phase 25** (the larger Phase-20 residual; see the Phase-25
      section below for the per-piece detail).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 25 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 25 (Per-location stock ledger) — agreed 2026-06-28

Phase 25 delivered the one Backlog item the developer confirmed at entry: the **per-location stock ledger**
(§4) — the larger of the two Phase-20 residuals. The developer chose the **full SSOT migration** (not an
additive overlay): a synced **v13** `item_stock` table is now the single source of truth for *where* an item's
units sit (one row per `(item, location)`, deterministic `${itemId}|${locationId}` id), and `items.quantity`
is the derived `SUM(item_stock.quantity)` maintained by `trg_item_stock_recompute_*` triggers (guarded by
`quantity <> SUM`, so a no-op recompute never perturbs `items.updated_at` / FTS / LWW — quantity stays an LWW
field). Every write path routes through the ledger; the new pure `planTransfer` + `ItemRepository.transferStock`
split stock across locations; `move` consolidates; `LocationRepository.delete` and the §7.5.2 sync `applyPlan`
re-home placements at a removed location to Unassigned. `user_version` is now **13** (first bump since Phase 24).
The remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Phase-25 residuals (trigger-gated, not dropped):**
> - **Per-location cycle counting** — **done in Phase 26.** The §4.4 Cycle Count dialog now audits a *specific*
>   placement (`ItemRepository.listStockAtLocation` + the optional `locationId` on `ReconciliationAdjustment`),
>   so the expected figure is the counted location's on-hand and the variance lands on that placement.
> - **Per-location checkout source** — **done in Phase 26.** A DISCRETE loan may be drawn from a chosen placement
>   (`CheckoutItemInput.fromLocationId`) and is returned to where it left from (additive **v14**
>   `checkouts.source_location_id`).
> - **Concurrent location-delete vs. offline stock edit** — re-homing a removed location's placement to Unassigned
>   uses an additive merge; in the rare case the same physical stock was already re-homed by a peer this can
>   transiently over-count until the next reconcile (an accepted LWW-class limitation, parallel to §7.5.2).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 26 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 26 (Per-location cycle count + checkout source) — agreed 2026-06-28

Phase 26 delivered the two Backlog items the developer confirmed at entry — the two *closest-to-triggered*
Phase-25 residuals: **per-location cycle count** and **per-location checkout source** (with return-to-source).
The §4.4 audit and the §4 loan now act on a *specific* `item_stock` placement rather than the item's primary
location, completing the multi-location model Phase 25 opened. The checkout source needed one additive **v14**
column (`checkouts.source_location_id`, nullable FK) so a return restores stock to where it left from; the cycle
count needed **no migration** (an optional `locationId` on `ReconciliationAdjustment` + a ledger read).
`user_version` is now **14**. The remaining Backlog items were **not in scope and are re-scheduled, not
dropped** — all are still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Phase-26 residual (trigger-gated, not dropped):**
> - **Per-location maintenance / batch-aware counts** — the cycle count and loan now act per location, but a
>   SERIALISED audit and a checkout still resolve a single instance; batch/lot-aware per-location reconciliation
>   is a further deepening if multi-batch placements are wanted. No live trigger today.
> - **Concurrent location-delete vs. offline stock edit** (carried from Phase 25) — re-homing a removed location's
>   placement to Unassigned uses an additive merge; the same physical stock re-homed by two peers can transiently
>   over-count until the next reconcile (an accepted LWW-class limitation, parallel to §7.5.2).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 27 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 27 (Node-25 cold-start flake hardening) — agreed 2026-06-28

Phase 27 landed the one item the developer confirmed at entry: hardening the **Node-25 unit-pool cold-start
flake** beyond the Phase-21 `threads` pin — the only *fresh, genuinely-observed* trigger (it fired once more
entering Phase 26 despite the pin). `npm run test:run` now goes through a wrapper (`scripts/run-unit-tests.mjs`)
that streams `vitest run` live, captures its output, and **automatically re-runs it once — but only** when the
finished run carries the exact cold-start fingerprint (`Cannot read properties of undefined (reading 'config')`).
A clean pass returns immediately; a real test failure (or a "no test files found" misconfiguration, or a second
consecutive flake) is surfaced honestly, so a genuine failure is **never masked or slowed**. Crucially, Vitest's
own `test.retry` was **not** the right lever — the flake collapses the *whole run* with zero tests collected,
before any test body executes, so there is no failing test for `retry` to re-run; the documented "re-run once"
mitigation had to be automated at the run level. The retry decision (`isColdStartFlake`) and the bounded
orchestration (`runWithRetry`, with an injectable `runOnce` so the loop is deterministically unit-testable) live
in the pure `scripts/flake-retry.mjs` and are covered by `scripts/flake-retry.test.mjs` (+10 tests, 669 total).
**No app code, schema or migration change** — `user_version` stays **14**; `vite.config.ts`'s `test.pool:
'threads'` pin is untouched (the wrapper complements it, it does not replace it). The remaining Backlog items were
**not in scope and are re-scheduled, not dropped** — all are still triggered conditionals tracked in the roadmap
Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).
- [ ] **Per-location maintenance / batch-aware counts** — **→ Backlog** (carried from Phase 26; trigger:
      multi-batch/lot placements wanted).

> The Node-25 flake is now **resolved at the runner level** (a guaranteed automatic recovery, not merely a
> documented manual re-run). Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with
> **no live trigger today**. Phase 28 has no pre-assigned slice — confirm scope with the developer at entry (or
> agree it is a conscious no-op until a real trigger appears).

## Deferred out of Phase 28 (Batch / lot-aware per-location stock + cycle count) — agreed 2026-06-28

Phase 28 delivered the one Backlog item the developer confirmed at entry — the **batch / lot-aware
per-location stock** half of the Phase-26 residual (developer-chosen **Core slice**): a placement's units
can now split across distinct batches, with batch-aware **receiving**, FEFO **display**, and batch-aware
**cycle count**. `stock_batches` (synced **v15**) is the SSOT below `item_stock`; the latter's quantity (and
`items.quantity`) is a guarded trigger-maintained projection — extending the Phase-25 "demote a quantity to a
`SUM` projection, never a stored counter" pattern one level down. The headline FEFO consumption is the pure,
unit-tested `planBatchConsumption`. `user_version` is now **15** (first bump since Phase 26). The remaining
Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals
tracked in the roadmap Backlog row above:

- [x] **Explicit per-batch transfer / checkout selection** — **done in Phase 29.** The user can now pick the
      *exact* lot to move or lend (the pure `planBatchSelection` alongside the FEFO `planBatchConsumption`), and a
      lent lot is remembered on the loan (additive **v16** `checkouts.source_batch_key`, the canonical key
      round-tripped back to its identity via `batchIdentityFromKey`) so the return restores to *that exact lot*
      rather than the untracked default batch. See the Phase-29 section below for the per-piece detail.
- [ ] **Per-location maintenance scheduling** — **→ Backlog** (the other half of the Phase-26 residual; trigger:
      a DISCRETE tool spread across locations needs per-placement servicing). Maintenance schedules remain
      item-level (a SERIALISED tool is already its own record).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only — now **154.88 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Carried LWW-class limitation (not a Phase-28 change):** concurrent location-delete vs. offline stock edit —
> an additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until
> the next reconcile (accepted, parallel to §7.5.2).

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 29 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 29 (Explicit per-batch transfer / checkout selection) — agreed 2026-06-28

Phase 29 delivered the one Backlog item the developer confirmed at entry: **explicit per-batch transfer /
checkout selection** (§4 perishables) — the closest-to-triggered Phase-28 residual. Transfer and checkout no
longer *only* auto-consume FEFO: the user can pick the exact lot to move or lend (the pure `planBatchSelection`
in `features/inventory/batches.ts`, the explicit-selection sibling of the FEFO `planBatchConsumption`), and a
lent lot is remembered so the return restores to *that exact lot* — the canonical `source_batch_key` round-trips
back to its identity via the new `batchIdentityFromKey` (inverse of `batchKeyOf`). The only persisted bookkeeping
is one additive **v16** `checkouts.source_batch_key` (nullable, *not* an FK — a batch key is a synthetic identity
and the lot's `stock_batches` row may legitimately be emptied while the unit is out, so no FK_REFS / re-home is
needed; it auto-joins the LWW payload as `checkouts` ∈ `SYNC_TABLES`). `user_version` is now **16** (first bump
since Phase 28). The remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all are
still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **Per-location maintenance scheduling** — **→ Backlog** (the other half of the Phase-26 residual; trigger:
      a DISCRETE tool spread across locations needs per-placement servicing). Maintenance schedules remain
      item-level.
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only — now **152.11 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Carried LWW-class limitation (not a Phase-29 change):** concurrent location-delete vs. offline stock edit —
> an additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until
> the next reconcile (accepted, parallel to §7.5.2).

> **Phase-29 design note (semantics worth knowing):** a checkout *return* now restores to the lent lot when one
> was chosen (`source_batch_key` → its identity); a FEFO loan (no chosen lot) still returns to the source
> placement's untracked default batch, exactly as Phase 28. If the lent-from *location* was deleted while the
> unit was out (`source_location_id` nulled to the item's primary), the lot is still rebuilt at that primary —
> restoring a named lot to a different location is a marginal, accepted edge.

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger
> today**. Phase 30 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a
> conscious no-op until a real trigger appears).

## Deferred out of Phase 30 (Per-location maintenance scheduling) — agreed 2026-06-28

Phase 30 delivered the one Backlog item the developer confirmed at entry: **per-location maintenance
scheduling** (§4.3) — the last Phase-26/28 sibling residual. A maintenance schedule can now be scoped to a
*specific placement* of a DISCRETE tool spread across locations (Phase 25 `item_stock`): the additive **v17**
`maintenance_schedules.location_id` (nullable FK; NULL = the whole item, the Phase-9 behaviour, so every
existing schedule reads correctly with no backfill). The scope is **operationally meaningful, not a label** — a
location-scoped USAGE schedule that auto-accrues checkout-hours (Phase 22) attributes only the loans *drawn from
that placement* (`checkouts.source_location_id`, Phase 26): the pure `accruedCheckoutHours` gained an optional
`scopeLocationId` filter, and the `AUTO_USAGE_HOURS` SQL gained the matching `(ms.location_id IS NULL OR
k.source_location_id = ms.location_id)` guard, so each placement accrues against its own service clock. It is a
synced FK, wired exactly like v14's `source_location_id`: a `FK_REFS` entry + `LocationRepository.delete` and the
§7.5.2 sync `applyPlan` both null it out for a removed location (the schedule reverts to item-level rather than
vanishing), and the `FK_REFS` guard nulls an *incoming* schedule whose scope location did not survive the merge.
`user_version` is now **17** (first bump since Phase 29). The remaining Backlog items were **not in scope and are
re-scheduled, not dropped** — all are still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / WASM scanner decode perf / leaner WASM decoder** — **→ Backlog**
      (carried from Phase 15; the budget reporter stays warn-only — now **150.13 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Carried LWW-class limitation (not a Phase-30 change):** concurrent location-delete vs. offline stock edit —
> an additive re-home of a removed location's placement/batches to Unassigned can transiently over-count until
> the next reconcile (accepted, parallel to §7.5.2).

> **Phase-30 design note (semantics worth knowing):** a location-scoped schedule only auto-accrues loans whose
> `source_location_id` matches its scope — a loan with no recorded source location (a NULL pointer) cannot be
> attributed to a placement, so it counts only toward item-level schedules. The per-placement scope is offered in
> the UI only where the tool actually holds stock in more than one place (else a schedule stays item-level, the
> same single-placement reality as before).

> **No spec-numbered or roadmap-enumerated phase remains, and every remaining open item is a genuinely
> conditional/YAGNI Backlog entry with no live trigger today.** Phase 31 has no pre-assigned slice — confirm scope
> with the developer at entry (or agree it is a conscious no-op until a real trigger appears).

## Deferred out of Phase 31 (WASM scanner decode performance) — agreed 2026-06-28

Phase 31 delivered the one Backlog item the developer confirmed at entry: **WASM scanner decode performance**
(§6.6) — moving the fallback barcode decode off the main thread. The §6.6 WASM fallback (used when the native
`BarcodeDetector` is absent — Firefox, and **all** Safari, which has no `BarcodeDetector`) previously snapshotted
each frame to a main-thread canvas and ran the CPU-heavy zxing decode inline (throttled ~8/s), janking the UI.
It now captures each frame to an `ImageBitmap` (`createImageBitmap`, off-thread) and **transfers** it (zero-copy)
into a Web Worker (`src/features/scanner/barcode-decode.worker.ts`) that decodes on an `OffscreenCanvas`, so the
main thread stays free. The worker uses the leaner `@zxing/library` **core** (`MultiFormatReader` +
`RGBLuminanceSource` + `HybridBinarizer`, fed by the pure `rgbaToLuminance`) because `@zxing/browser`'s
`decodeFromCanvas` needs a DOM `HTMLCanvasElement` that does not exist in a worker — so the developer chose the
**worker-only replacement** (leanest): the old `@zxing/browser` dep was dropped, `@zxing/library` promoted to a
direct dep (already in the lockfile at 0.22.0 — no new download), and the worker replaces the main-thread decoder
as the **sole** `'wasm'` tier. The tier is gated by the pure `supportsWorkerDecode` (Worker + OffscreenCanvas +
createImageBitmap); a browser lacking those *and* the native API degrades to manual entry (`'none'`). **No
schema/migration change** — `user_version` stays **17**. Precache is **net leaner** (2825 KiB / 174.63 KiB
headroom, +24 KiB vs Phase 30) since the worker zxing-core chunk replaces the old `@zxing/browser` chunk and is
split out of the main bundle. The remaining Backlog items were **not in scope and are re-scheduled, not dropped**
— all are still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner WASM decoder** — **→ Backlog** (carried from Phase 15; the
      budget reporter stays warn-only — now **174.63 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Phase-31 trade (accepted, trigger-gated, not dropped):**
> - **Live WASM scanning on a no-`OffscreenCanvas` browser** (notably **Safari < 16.4**, which also lacks
>   `BarcodeDetector`) now degrades to **manual entry** rather than a main-thread decode — the cost of the
>   worker-only replacement that keeps the bundle lean (one zxing copy, not two). Trigger to re-add a main-thread
>   `@zxing/library`-core fallback: a real old-Safari user needs live camera scanning. No live trigger today.
> - **WASM scanner battery/perf on very low-end devices** — *adaptive frame-skip* **done in Phase 32** (the worker
>   decode now backs off geometrically while idle and snaps back on a hit — see the Phase-32 section below). A
>   *smaller single-format decoder* remains a further deepening if a real device still reports drain. No live trigger.

> **Every remaining open item is a genuinely conditional/YAGNI Backlog entry with no live trigger today.** Phase 32
> has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op until a
> real trigger appears).

## Deferred out of Phase 32 (Adaptive frame-skip scanner decode) — agreed 2026-06-28

Phase 32 delivered the one Backlog item the developer confirmed at entry: **adaptive frame-skip scanner decode**
(§6.6 / §6.1 battery) — the Phase-31 "WASM scanner battery/perf on very low-end devices" residual. The off-thread
worker decode (the Firefox/all-Safari fallback) no longer decodes every frame at the fixed Phase-31 120 ms
throttle: the new pure `src/features/scanner/decode-cadence.ts` (`initialCadence` / `nextCadence` +
`DEFAULT_WASM_CADENCE`) is a deterministic state-fold that backs the decode interval off geometrically (120 → 240
→ 480 → 600 ms, ×2 after 8 consecutive idle frames, clamped at 600 ms) as the camera stays idle, and **snaps
straight back to the fast 120 ms base cadence the instant a code is decoded**. So a low-end device pointed at an
empty bench stops burning CPU on a per-frame zxing decode, while a barcode actually held up is still acquired
within ≤600 ms. The cadence has no clock or DOM, so it is fully unit-tested (`decode-cadence.test.ts`, +8) and is
threaded through `useScanner`'s RAF loop for the `'wasm'` engine **only** — the native Barcode Detection API stays
per-frame (it offloads to hardware and has no per-frame cost to amortise). **No schema/migration change** —
`user_version` stays **17**; the pure helper adds ~0.4 KiB (precache 2825.79 KiB / 174.21 KiB headroom). The
remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **Single-format worker decode for very low-end devices** — **→ Backlog** (the other half of the Phase-31
      perf residual; trigger: a real device still reports battery drain after the adaptive frame-skip). The worker
      still hints all four symbologies (QR/Code-128/EAN-13/Code-39); a single-format mode would cut decode cost
      further at the cost of scan flexibility.
- [ ] **Main-thread WASM fallback for no-`OffscreenCanvas` browsers (Safari < 16.4)** — **→ Backlog** (carried from
      Phase 31; trigger: a real old-Safari user needs live camera scanning).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner WASM decoder** — **→ Backlog** (carried from Phase 15; the
      budget reporter stays warn-only — now **174.21 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Every remaining open item is a genuinely conditional/YAGNI Backlog entry with no live trigger today.** Phase 33
> has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op until a
> real trigger appears).

## Deferred out of Phase 33 (Main-thread-capture scanner fallback) — agreed 2026-06-28

Phase 33 delivered the one Backlog item the developer confirmed at entry: the **main-thread-capture scanner
fallback** (§6.6) — restoring live scanning for no-`OffscreenCanvas` browsers (Safari < 16.4), which previously
degraded straight to manual entry. A new `'wasm-canvas'` tier captures each frame on the **main thread** with a
regular 2-D `<canvas>` (the API those browsers have — only `OffscreenCanvas` is missing) and transfers the **raw
RGBA pixels** to the **same** decode worker, which decodes them through the shared `createZxingDecode` **without**
touching `OffscreenCanvas`. So the heavy zxing decode still runs **off-thread** and the worker's `@zxing/library`
chunk is **reused, not duplicated** — the developer explicitly chose this main-capture-+-worker-decode design over
a literal main-thread zxing decoder precisely to avoid a ~432 KiB precache duplication that would have blown the
soft budget. The tier reuses the existing single-flight worker machinery (refactored to a shared
`makeWorkerBackedDecoder`) and the Phase-32 adaptive cadence. **No schema/migration change** — `user_version` stays
**17**; precache effectively flat (2826.95 KiB / 173.05 KiB headroom). The remaining Backlog items were **not in
scope and are re-scheduled, not dropped** — all are still triggered conditionals tracked in the roadmap Backlog row
above:

- [x] **Single-format worker decode** — **done in Phase 34** (see the Phase-34 section below). A
      `usePreferencesStore.scannerSymbology` preference narrows the scanner to one symbology so the worker (and
      native detector) hint a single format — ~4× less per-frame decode work.
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner WASM decoder** — **→ Backlog** (carried from Phase 15; the budget
      reporter stays warn-only — now **173.05 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Every remaining open item is a genuinely conditional/YAGNI Backlog entry with no live trigger today.** Phase 34
> has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op until a
> real trigger appears).

## Deferred out of Phase 34 (Single-format scanner symbology) — agreed 2026-06-28

Phase 34 delivered the one Backlog item the developer confirmed at entry: **single-format scanner symbology**
(§6.6/§6.1) — the closest *thematic* sibling of P31–33 and the other half of the Phase-31 perf residual. The
§6.6 tiered decoder hinted **all four** symbologies on every frame; the scanner can now be narrowed to a
**single symbology** (`usePreferencesStore.scannerSymbology`, default `'all'` — never a regression) so the
zxing `MultiFormatReader` and the native `BarcodeDetector` hint just that one format, cutting per-frame decode
cost ~4× on the off-thread worker fallbacks. The format selection is a pure, **main-thread-safe** seam
(`scanner-formats.ts`, no `@zxing/library` import → the enum stays out of the default bundle); the worker-only
`zxing-decode.ts` maps the key → `BarcodeFormat[]` (`zxingFormatsFor`, `createZxingDecode(symbology)`); the
decode worker memoises its hinted reader **by symbology** and each `FrameDecoder` request carries the
symbology, threaded by `createDecoder(symbology)` through all three tiers and surfaced by a new "Scanner"
Settings control. **No schema migration was needed** (the preference is device-local Tier-2 `localStorage`),
so `user_version` stays **17**; precache effectively flat (2828.26 KiB / 171.74 KiB headroom). The remaining
Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals
tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only — now **171.74 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance / `SCRAPE_ERROR` taxonomy depth** —
      **→ Backlog** (carried from Phase 13).

> **Every remaining open item is a genuinely conditional/YAGNI Backlog entry with no live trigger today** — and
> with the single-format decode now landed, there is **no remaining scanner/perf sibling** either. Phase 35 has
> no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op until a
> real trigger appears).

## Deferred out of Phase 35 (Deeper `SCRAPE_ERROR` taxonomy) — agreed 2026-06-28

Phase 35 delivered the one Backlog item the developer confirmed at entry: **deeper `SCRAPE_ERROR` taxonomy**
(§9.4.2/§9.4.3) — the §9.4.2 enum gained three HTTP-status-driven members (**`BLOCKED`** 401/403/other-4xx,
**`NOT_FOUND`** 404/410, **`SERVER_ERROR`** 5xx) so a *received* HTTP failure is no longer mis-reported as a
transport `NETWORK_TIMEOUT` (which now means only an abort/timeout with no response). The status→type decision
is the new pure, unit-tested `classifyHttpStatus` (`src/features/scraping/scrape-errors.ts`, extracted out of
the esbuild-only extension worker and shared with it verbatim), and the §9.4.3 per-type degradation toast
wording is the pure `describeScrapeError` (replacing `ScrapeSupplierPanel`'s inline `DOM_DRIFT`-only ternary).
A latent wrong import was fixed in passing (the extension imported `ScrapeErrorType` from `parsers/types`,
which never exported it → now from `protocol`, the SSOT). This is a **breaking §9 wire change → the extension
was rebuilt** (`build:extension`; the new members are confirmed present in `dist/background.js`). **No schema
migration was needed** (nothing persists; the change is a wider wire enum + pure glue), so `user_version` stays
**17**; precache effectively flat (2828.81 KiB / 171.19 KiB headroom). The developer chose the **HTTP-status
set** specifically — a heuristic `CAPTCHA` body-detection tier was offered and **consciously declined** (risk of
false positives), so it joins the Backlog. The remaining Backlog items were **not in scope and are re-scheduled,
not dropped** — all are still triggered conditionals tracked in the roadmap Backlog row above:

- [x] **Heuristic `CAPTCHA` / challenge-page detection** — **done in Phase 36.** A pure, unit-tested
      `detectChallengePage(html)` in `scrape-errors.ts` flags a 200-OK anti-bot interstitial (Cloudflare /
      Imperva Incapsula / PerimeterX / DataDome — high-confidence, full-page vendor markers only, *not* bare
      captcha widgets) and the content script marshals it as a new `CHALLENGE` `SCRAPE_ERROR` member **before**
      parsing, so it never mis-reports as `DOM_DRIFT`. See the Phase-36 section below.
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only — now **171.19 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).

> **Every remaining open item is a genuinely conditional/YAGNI Backlog entry with no live trigger today.** Phase
> 36 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op
> until a real trigger appears).

## Deferred out of Phase 36 (Heuristic `CAPTCHA` / challenge-page detection) — agreed 2026-06-28

Phase 36 delivered the one Backlog item the developer confirmed at entry: **heuristic `CAPTCHA` / challenge-page
detection** (§9.4.2/§9.4.3) — the item Phase 35 consciously declined over false-positive risk. A 200-OK anti-bot
interstitial is now reported as a distinct **`CHALLENGE`** `SCRAPE_ERROR` member rather than mis-parsed into a
`DOM_DRIFT`: the pure, unit-tested `detectChallengePage(html)` (`src/features/scraping/scrape-errors.ts`, shared
verbatim with the esbuild-only content script) inspects the fetched body for **high-confidence, full-page vendor
markers only** (Cloudflare / Imperva Incapsula / PerimeterX `px-captcha` / DataDome `geo.captcha-delivery.com`) and
**deliberately ignores bare reCAPTCHA/hCaptcha widgets** (real pages embed those in contact/login forms), so the
false-positive rate stays near zero — the conscious under-detect-not-misfire trade-off. The content script runs it
**before** the Strategy parsers and marshals the `CHALLENGE` error; `describeScrapeError` gained the per-type toast
wording (nudges opening the page in a tab). **Breaking §9 wire change → extension rebuilt** (`CHALLENGE`/
`detectChallengePage` confirmed in `dist/content-script.js`; `background.js` unchanged). **No schema migration was
needed** (a wider wire enum + pure glue, nothing persists), so `user_version` stays **17**. The remaining Backlog
items were **not in scope and are re-scheduled, not dropped** — all are still triggered conditionals tracked in the
roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only — now **171.04 KiB** headroom).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).

> **Every remaining open item is a genuinely conditional/YAGNI Backlog entry with no live trigger today** — and the
> §9 scraping-resilience arc (P13, P35, P36) has now exhausted its named deferrals. Phase 37 has no pre-assigned
> slice — confirm scope with the developer at entry (or agree it is a conscious no-op until a real trigger appears).

## Deferred out of Phase 37 (Bounded virtualised-list memory) — agreed 2026-06-28

Phase 37 was a **performance / resource investigation** (the developer asked, in place of picking a pre-listed
Backlog item, whether any perf/resource improvements could be made). The investigation profiled four axes — precache
composition, DB indexes/query patterns, the React render path, and runtime memory — and found the codebase already
well-optimised (DOM virtualised, indexes broad, queries paginated) **except** one real leak: the inventory list's
`useInfiniteQuery` retained every scrolled page, and each row carries a thumbnail BLOB, so a deep scroll accumulated
unbounded blob memory in the TanStack cache — undermining the §2.1 "light memory with 100,000+ items" claim. The
developer chose to land that fix: **bound the resident window** with `maxPages = MAX_LIST_PAGES` (6 × `DEFAULT_PAGE_SIZE`
= 300 items) on both `useInventoryItems` and `useAstSearch`, driving the virtualiser in **absolute index space** (the
pure `list-window.ts`) so a trimmed front page never shifts the rows in view, with `getPreviousPageParam` refilling the
prefix on scroll-up. **No schema migration was needed** (a query-cache cap + pure render math, nothing persists), so
`user_version` stays **17**. The remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all
are still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried from
      Phase 15; the budget reporter stays warn-only — now **170.24 KiB** headroom. The investigation re-confirmed the
      442 KiB zxing scanner-fallback worker is ~16% of the precache, the natural target if the budget ever bites).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).

> **Phase-37 residual (trigger-gated, not dropped):** the `useItemHistory` infinite query (defined in
> `inventory/queries.ts` but **not currently rendered** by any UI) was deliberately left **unbounded** — it has no
> live consumer to leak through. If a paginated history view is ever surfaced, give it the same `maxPages` +
> `getPreviousPageParam` treatment. No live trigger today.

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger today**.
> Phase 38 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op
> until a real trigger appears).

## Deferred out of Phase 38 (Accessible Modal focus management) — agreed 2026-06-28

Phase 38 was a **fresh-investigation pick** (à la Phase 37): with no Backlog item carrying a live trigger, the
developer chose to sweep an axis Phase 37 had not — **accessibility / keyboard / focus** — and land whatever real
issue surfaced. It found one: the Foundry `Modal` declared `role="dialog"` + `aria-modal="true"` but had **no focus
management whatsoever**, so the `aria-modal` contract was broken across all ~45 dialogs (focus never entered the
dialog on open, Tab escaped to the backdrop-obscured page behind it, and focus was dropped to `<body>` on close).
The fix moves focus into the dialog on open, **traps Tab/Shift+Tab within it** (wrapping at both ends via the pure,
unit-tested `nextTrapIndex` in `src/components/foundry/focus-trap.ts`), and **restores focus to the opener** on
close — the standard APG dialog pattern. **No schema migration was needed** (pure render/effect glue, nothing
persists), so `user_version` stays **17**, and the extension was not rebuilt (no §9 / `extension/` edit). The
remaining Backlog items were **not in scope and are re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried from
      Phase 15; the budget reporter stays warn-only — now **169.61 KiB** headroom. The 442 KiB zxing scanner-fallback
      worker remains ~16% of the precache, the natural target if the budget ever bites).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).

> **Phase-38 residual (trigger-gated, not dropped):** the a11y sweep stopped at the highest-leverage finding (the
> Modal — base of every dialog). Other accessible-component polish could follow if wanted but has no live trigger:
> a global skip-to-content link, a roving-tabindex pattern for the `LocationSidebar` tree, and `aria-live` regions
> for the optimistic-update toasts (the Toast primitive already announces; broader `aria-live` coverage is YAGNI
> until a screen-reader audit asks for it). The `useItemHistory` Phase-37 residual (unbounded infinite query, no UI
> consumer) likewise still stands.

> Every remaining open item is still a genuinely conditional/YAGNI Backlog entry with **no live trigger today**.
> Phase 39 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op
> until a real trigger appears).

## Deferred out of Phase 9 (Procurement & Lifecycle Logistics) — agreed 2026-06-27

Phase 9 ships all six §5 deliverables: Expiry/Batch/Lot + Condition (additive v8 columns),
abstract single-level Parent/Child variants (self-FK + repository cycle guard), the In-Transit
dashboard tracker (surfacing Phase-4 `IN_TRANSIT` BOM lines), Tool Maintenance Schedules
(`maintenance_schedules` table, time- + manual-usage based), Borrowing-due + Soon-to-Expire +
Maintenance-due dashboard widgets, and the ephemeral-Tier-3 Cycle Counting / Reconciliation workflow.
Deferred (not dropped):

- [x] **Nested / multi-level variants** — **done in Phase 18.** The single-level cap is lifted: a variant may
      itself hold sub-variants to any depth. The pure `validateVariantLink` was pruned to `SELF_PARENT` |
      `CYCLE` (the `PARENT_IS_VARIANT` / `CHILD_HAS_VARIANTS` single-level rejections removed) and is now
      *wired into* `ItemRepository.assertVariantLinkValid`, which walks the proposed parent's full ancestor
      chain via a recursive CTE (mirroring `LocationRepository.assertParentMoveValid`) so a move that would make
      an item its own descendant is rejected. `createVariant`/`setParent` no longer block nesting; the
      `LifecycleEditor` renders the Variants section on a child too (with a "this is itself a variant" note).
      Unit-tested (`lifecycle.test.ts`, `ItemRepository.phase9.test.ts` deep-nest + cycle cases) + smoke-asserted
      (a grandchild sub-variant added beneath a variant).
- [x] **Usage telemetry for maintenance** — **done in Phase 22.** A USAGE schedule may now opt in to accrue
      real **checkout-hours**: the loan duration of the tool (a contact borrows it, returns it) drives its next
      service instead of the manual `addUsage` counter. The accrued figure is a *derived projection* over the
      `checkouts` ledger (the §2.1 SSOT) — `MaintenanceRepository`'s `AUTO_USAGE_HOURS` subquery sums each loan
      *begun* at or after the service anchor (`last_performed_at ?? created_at`), each open loan accruing to
      `now`, `MAX(0, …)`-clamped — so it can never drift under check-in, revert, FK-cascade delete or LWW sync,
      and `logPerformed` resets it for free by advancing the anchor (mirroring the Phase-20 `inTransitQtyForItem`
      "derive, never store a counter" seam). The only persisted bookkeeping is the per-schedule opt-in, an
      additive **v11** `accrue_checkout_hours` column that auto-joins the LWW payload (the schema dictionary
      reads columns live via `PRAGMA`). Manual `addUsage` is disabled on accrue schedules. Pure-unit-tested
      (`lifecycle.test.ts`: `checkoutHours`/`accruedCheckoutHours`/`effectiveUsage` + due-ness), repo-tested
      (`MaintenanceRepository.test.ts`: derive/anchor/reset/manual-isolation), sync round-trip
      (`sync-engine.test.ts`) + smoke-asserted (opt-in renders the derived "h from loans" figure).
- [x] **`maintenance_schedules` reconcile coverage** — **done in Phase 11.** Audited (a dedicated
      sync-engine test): a schedule whose `item_id` is hard-deleted on a peer is removed by the item
      tombstone's `ON DELETE CASCADE`, with no orphan and no bespoke re-parent. The audit surfaced a
      **latent bug affecting every cascade child** (capabilities, checkouts, …): a cascade leaves no child
      tombstone, so the deleting device would re-download the orphan and trip a foreign key on its next
      sync. Fixed engine-wide by a §7.5 child-FK guard in `reconcile` (`FK_REFS` + `enforceForeignKeys`):
      an upsert whose parent was *known and removed* is dropped (NOT-NULL FK) or has the reference nulled
      (nullable FK, e.g. a BOM line whose item was removed).
- [x] **In-Transit physical location** — **done in Phase 20.** Incoming/ordered stock now surfaces as a
      *distinct per-item quantity* rather than being overloaded onto on-hand `quantity`. The pure
      `ProjectRepository.inTransitQtyForItem(itemId)` derives it as `SUM(required_qty)` over the item's
      `IN_TRANSIT` BOM lines (the §2.1 SSOT) — a projection, never a stored counter, so receiving a line,
      reverting it, deleting it/its project (FK cascade) and LWW sync of the line status all keep it correct
      with no drift (this is *why* the derived model was chosen over a `v11` column). Surfaced on the item
      detail (`LifecycleEditor`) via `useInTransitQty` with a Foundry **Tooltip** explaining it is held in the
      system-locked In-Transit location and counted separately from on-hand. **No migration** (`user_version`
      stays 10). Unit-tested (`ProjectRepository.test.ts`: derive/distinct-from-on-hand, sum across
      lines+projects, clears on receive, drops on revert/remove) + smoke-asserted (the matched BOM line at qty 5
      shows "5 arriving" distinct from on-hand). The seeded `IN_TRANSIT_LOCATION_ID` remains the conceptual
      anchor; Gubbins' single-location-per-item model means a literal per-location stock ledger was *not* built
      (YAGNI) — see the residual below.
- [x] **Cycle count of non-DISCRETE stock** — **done in Phase 23.** The Cycle Count / Reconciliation
      workflow now audits **SERIALISED** instances by *presence*: each qty-1 unit in a counted location is
      flagged present or missing in the same `CycleCountDialog`, and authorising a missing instance reconciles
      it by a **reversible soft-delete** (`is_active = 0` + a `RECONCILED` ledger entry at `quantity_delta = -1`;
      restorable via `restore` if the unit turns up). The present/missing partition is the pure
      `missingInstances` / `serialisedAuditNote` (in `cycle-count.ts`); the persistence is
      `ItemRepository.reconcileSerialised`, mirroring the DISCRETE `reconcile` seam (rejects non-SERIALISED,
      skips an already-inactive instance). The Tier-3 `CycleCountContext` gained the serialised instance list +
      a present/missing map. **No migration** — only the existing synced `is_active` column is toggled, so a
      "marked missing" propagates by LWW and `user_version` stays **11**. Gauges still reconcile only via the
      §4.1.2 weigh-in. Pure-unit-tested (`lifecycle.test.ts`), repo-tested
      (`ItemRepository.phase9.test.ts`: soft-delete + RECONCILED −1, reversible, skip-inactive, reject-discrete)
      + smoke-asserted (flag #2 missing → instance soft-deleted, #1 remains).
- [x] **Settings UI for the expiry window** — **done in Phase 12.** `EXPIRY_SOON_WINDOW_DAYS` (30) is now
      the *default* of a `usePreferencesStore.expirySoonWindowDays` preference, controlled (clamped 1–365)
      from the Settings screen and consumed by `LifecycleAlerts` via `useExpiringItems(window)`.

## Deferred out of Phase 10 (OPFS Quota Recovery & Archiving) — agreed 2026-06-27

Phase 10 delivers the full §7.6 trio (Storage Triage Dashboard + history pruning with cold-storage
download + image downgrading) on the additive **v9** schema. Scope was confirmed **§7.6 only**; the
developer was explicit that the remaining work below **must** be picked up in a later phase (it is the
recommended primary target for Phase 11):

- [x] **Sync-set expansion** — **done in Phase 11.** All of the below landed (see the Phase-7
      "Sync-set expansion" section above for the per-table detail); `SYNC_TABLES` in
      `src/db/repositories/tombstone.ts` now carries the full LWW set, with `item_tags` (membership) and
      `item_history` (union-by-id) reconciled as dedicated non-LWW snapshot sections:
  - **Activity Ledger `item_history`** — union-by-id; the §7.6.3-A divergence is handled by the additive
    **v10** `sync_meta.history_pruned_before` watermark.
  - **M:N joins & leaf rows** — the LWW leaves joined `SYNC_TABLES`; `item_tags` resolves by membership
    (edge tombstones).
  - **Images `item_images`** — base64 thumbnails in the payload; `full_res_downgraded_at` held back via
    `SYNC_EXCLUDED_COLUMNS` so a downgrade never propagates as a change (§7.6.3-B).
- [x] **Storage tuning** (`AVG_ROW_BYTES` accuracy) — **done in Phase 15.** `opfs-images.ts`'s new
      `imagesBytesOnDisk()` sums the real on-disk size of the full-resolution OPFS files (cheap `file.size`
      reads, no byte copy); `estimateTableBytes(counts, { itemImagesBytes })` uses that measured figure (plus a
      small per-row thumbnail estimate) for the `item_images` breakdown instead of the flat heuristic, falling
      back to the heuristic where OPFS can't be measured. The Triage dialog shows whether the figure was
      measured or estimated (`triage-images-source`). Pure-tested + smoke-asserted (measured after an upload).
- [x] **Prune/downgrade window controls + permanent Triage entry-point** — **done in Phase 12.** The Storage
      Triage dashboard now has a permanent entry-point from the Settings screen (no longer banner-only); the
      prune/downgrade windows are user preferences (`usePreferencesStore.pruneWindowMonths` /
      `downgradeWindowMonths`, single source of truth shared by Settings and the dialog); and a
      confirm-before-delete step now guards both space-freeing actions (the prune still downloads its
      cold-storage archive first).

## Deferred out of Phase 11 (Sync-set expansion) — agreed 2026-06-27

Phase 11 made backup/restore/sync genuinely whole (the M:N joins/leaves, the `item_history` ledger and
`item_images` thumbnails all joined the synced set; `item_attachments` was included too, per the
developer's scope confirmation) and cleared the `maintenance_schedules` reconcile audit (plus the
engine-wide §7.5 child-FK guard it surfaced). The following small residuals are **deferred, not dropped**:

- [x] **`item_history` watermark in the §7.2 clone path** — **done in Phase 14.** `buildCloneStatements`
      now takes the local `history_pruned_before` watermark and skips remote ledger rows older than it, so
      the rare 180-day-stale **Pre-Wipe Salvage / full clone** no longer re-pulls a deliberately-pruned era
      (matching the delta-sync guard). `cloneWithSalvage` threads `meta.historyPrunedBefore` through; covered
      by `snapshot.test.ts`.
- [x] **Child-FK guard for non-item parents** — **done in Phase 14.** `FK_REFS.checkouts` gained
      `contact_id → contacts` (NOT-NULL, drop the orphaned loan when a peer hard-deletes a contact), and the
      `category → category_fields → item_field_values` cascade-of-cascade is handled by `cascadeRemovedFields`
      (a field whose owning category was removed is folded into the removed-parent set, so the dependent
      `item_field_values` upsert is dropped). New `reconcile.test.ts` cases cover both.
- [x] **Full-resolution image bytes in sync/restore** — **done in Phase 14.** JSON sync still carries only
      thumbnails (§4 strict isolation). Full-res OPFS bytes now travel via the §4.5 **vault asset extraction**
      (`buildVault` → `/assets`, read from OPFS in `run-export`) and the §2.7 **Full Archive** zip (SQLite
      binary + OPFS images), and re-hydrate on a target device through the **raw `.sqlite` restore**
      (`restoreRawSqlite`). The smoke unzips the vault and asserts an extracted `/assets` image.

## Deferred out of Phase 12 (Settings & preferences UI) — agreed 2026-06-27

Phase 12 shipped the Settings screen (§3): theme application, the `scrapeNotifications` control, the
configurable "expiring soon" window, the prune/downgrade window preferences + a permanent Storage-Triage
entry-point with a confirm-before-delete step, plus base-currency / locale / attachment-mode controls
(all already in `usePreferencesStore`). Scope was confirmed with the developer at entry. One small item
was consciously left for the Backlog:

- [x] **"System / auto" theme option** — **done in Phase 16.** The `Theme` union was widened to
      `'dark' | 'light' | 'system'`; `resolveTheme(theme, prefersDark)` (pure) resolves `'system'` against the
      OS `prefers-color-scheme`, `applyTheme` feeds it `systemPrefersDark()` (feature-detected, dark-first
      fallback), and `useApplyTheme` attaches a `prefers-color-scheme` media listener while the preference is
      `'system'` so the palette re-applies live as the OS flips. The Settings `THEME_OPTIONS` gained a **System**
      choice (Monitor icon). Unit-tested (`resolveTheme`, `applyTheme('system')`); smoke drives it via
      `page.emulateMedia({ colorScheme })`.

> **Resolved in Phase 16.** The base-currency / locale formatting debt is closed: every `Intl`/currency call
> site now flows through the pure `makeFormatters(locale, currency)` factory (`@/lib/format`) bound to
> `usePreferencesStore` via the `useFormatters()` hook. The previously-hard-coded `en-GB` formatters in
> `inventory-ui.ts`, `format.ts` (percent/bytes), `ContactsScreen` and `SyncScreen` (both `toLocale*` dates),
> and the locale-less `formatCurrency` call in `SupplierDataEditor` all honour the chosen values. A non-default
> currency/locale is now exercised end-to-end (unit-tested + smoke-asserted via the project BOM total).

## Carried-over debt (pre-Phase-7)

The live pre-Phase-7 technical-debt items, each now assigned a landing phase (the "dashboard overdue
widget" was **delivered in Phase 9** — `widget-overdue` in `LifecycleAlerts` — and is removed from this
list):

- [x] **Scanner WASM fallback (§6.6)** — **done in Phase 15; decode moved off-thread in Phase 31.**
      `features/scanner/barcode-decoder.ts` resolves a tiered `FrameDecoder`: the native `BarcodeDetector` first,
      else the WASM fallback, else a no-op (manual entry). Native-first holds — the WASM chunk is code-split and
      only loads where the native API is absent (Firefox/Safari). **Phase 31** replaced the original main-thread
      `@zxing/browser` snapshot-decode with an **off-thread Web Worker** (zxing `@zxing/library` core on an
      `OffscreenCanvas`, frames transferred in as `ImageBitmap`s) so live scanning never janks the UI.
      `useScanner` reports the resolved engine; `ScannerOverlay` shows a compatibility-scanner notice on the WASM
      path. **Phase 33** added a `'wasm-canvas'` tier for no-`OffscreenCanvas` browsers (Safari < 16.4): the main
      thread captures frames on a regular 2-D `<canvas>` and transfers the RGBA pixels to the same worker, so those
      browsers scan instead of degrading to manual entry. **Phase 34** added a user-selectable single-format
      `scannerSymbology` (default `'all'`) so the worker + native detector can hint just one symbology for ~4× cheaper
      per-frame decode (`scanner-formats.ts` keeps the zxing enum out of the main bundle). Unit-tested
      (`barcode-decoder.test.ts` + `luminance.test.ts` + `zxing-decode.test.ts` + `scanner-formats.test.ts`);
      smoke-driven in two mobile contexts with `BarcodeDetector` (and, for `'wasm-canvas'`, `OffscreenCanvas`) forced
      absent, plus a Settings persistence step for the symbology preference.
- [x] **Single-item / project export scope + vault asset extraction** — **done in Phase 14.** The Export
      Wizard now offers a §4.5 scope (whole inventory / a single item / a Project-BOM scope), and the Markdown
      vault extracts full-resolution images **and** thumbnails out of OPFS into `/assets` with Obsidian
      wiki-links, plus a Datasheets section of attachment links and a Project master note for project scope.
- [x] **Raw `.sqlite` restore + mobile weekly auto-archive (§2.7) + NTP time source + FS Access provider
      persistence** — **done in Phase 14.** `restoreRawSqlite` (Safe Mode) validates the SQLite header,
      overwrites the OPFS DB file and reloads; the §2.7 mobile **Full Archive** (`runFullArchive`, weekly via
      `isArchiveDue` + a `StorageBanners` nudge) zips the SQLite binary + OPFS images; the §7.3 offset guard
      gained an HTTP `Date`-header time source (`httpTimeSource`, injected into `runSync` as a fallback when
      the provider has no clock); and the chosen FS Access directory handle persists in IndexedDB
      (`fs-handle-store`) so a later session auto-reconnects (or offers a one-click re-grant).
- [x] **Capability ranking** — **done in Phase 15.** When a Visual-Builder query filters on `capability:<key>`
      fields, `ItemRepository.searchByAst` now ranks hits by the summed `weight` of *those* capabilities each
      item carries (a correlated `SUM(weight)` scored subquery), heaviest first, before the alphabetical
      tie-break. The pure `collectCapabilityKeys` extracts the queried keys; a query with no capability
      conditions keeps the plain alphabetical order untouched. Unit-tested (`parseASTtoSQL.test.ts` +
      `ItemRepository.phase5.test.ts`); smoke proves the heavier-weighted item renders first.
- [x] **Theme application (Dark/Light)** — **done in Phase 12.** `usePreferencesStore.theme` is now projected
      onto `<html>` (the class-based `.dark` palette): `applyTheme` runs once before first paint in `main.tsx`
      (no flash) and `useApplyTheme` (mounted in `App`) keeps it in sync with the Settings toggle.
- [x] **Bundle-size budget** — **done in Phase 15 (warn-only form).** `scripts/check-bundle-size.mjs` (wired
      into `build` + `npm run check:bundle`) sums the precache-eligible `dist/` assets and reports them against a
      soft budget (3000 KiB; baseline ~2808 KiB after the lazily-precached WASM scanner). Per the developer's
      decision it is **warn-only** — it flags a regression but never fails the build. A hard-failing CI gate was
      consciously declined → tracked in the Backlog (trigger: a CI size-gate is wanted).

## Deferred out of Phase 38 (Accessible Modal focus management) — agreed 2026-06-28

Phase 38 was a fresh-investigation a11y pick that landed accessible Modal focus management. The a11y sweep
stopped at the highest-leverage finding (the Modal, base of every dialog). The other accessible-component
follow-ups it surfaced have **no live trigger** and were re-scheduled, not dropped:

- [x] **Roving-tabindex for the LocationSidebar tree** — **done in Phase 39** (see the roadmap row 39 above for
      the per-piece detail: a WAI-ARIA APG `tree` with roving tabindex + full arrow-key navigation, pure
      `tree-keyboard.ts` seam).
- [ ] **Skip-to-content link** — **→ Backlog** (trigger: a screen-reader/keyboard audit asks, or a persistent app
      shell lands). There is no global app shell today (each screen renders its own header), so a single global
      skip link has no clean universal placement; revisit when one exists or an audit requests it.
- [ ] **Broader `aria-live` coverage for optimistic-update status** — **→ Backlog** (trigger: an audit asks). The
      Foundry **Toast** viewport already announces (`aria-live="polite"` + `role="status"`); widening live-region
      coverage to inline status (e.g. the "N shown" list header, loading spinners) is marginal until requested.

## Deferred out of Phase 39 (Accessible LocationSidebar tree) — agreed 2026-06-28

Phase 39 delivered the one Backlog item the developer confirmed at entry: the **accessible LocationSidebar
tree** (the Phase-38 a11y follow-up — a WAI-ARIA APG `tree` with roving tabindex + arrow-key navigation, pure
`tree-keyboard.ts` seam). **No schema migration was needed** (focus/keyboard glue + a pure helper; nothing
persists), so `user_version` stays **17**. The remaining open items are **re-scheduled, not dropped** — all are
still triggered conditionals tracked in the roadmap Backlog row above:

- [x] **Skip-to-content link** — **done in Phase 40** (the `SkipLink` Foundry primitive in the root layout +
      per-screen `#main-content` landmarks; see the Phase-40 section below).
- [ ] **Broader `aria-live`** — **partly done in Phase 40** (the Inventory result-count live region); further
      per-surface live regions remain **→ Backlog** (no live trigger — the Toast already announces mutations).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query has no UI consumer; give it the
      `maxPages` + `list-window.ts` treatment if a paginated item-history view is ever surfaced.

> Every remaining open item is a genuinely conditional/YAGNI Backlog entry with **no live trigger today**. Phase 40
> has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op until a
> real trigger appears).

## Deferred out of Phase 40 (Skip-to-content link + result-count `aria-live`) — agreed 2026-06-28

Phase 40 delivered the Backlog item the developer confirmed at entry: the **remaining Phase-38/39 a11y
follow-ups** — a global **skip-to-content** bypass (`SkipLink` Foundry primitive in `routes/__root.tsx`, the first
focusable element on every route, targeting a per-screen `#main-content` landmark added to all six screens) and
the one genuine silent-update **`aria-live`** gap (the Inventory result-count / "Loading…" region is now a polite
`role="status"`). **No schema migration was needed** (a11y render glue + a small component; nothing persists), so
`user_version` stays **17**. The remaining open items are **re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **Broader `aria-live`** (further per-surface live regions) — **→ Backlog** (no live trigger; the Foundry
      Toast already announces mutation outcomes via `aria-live="polite"` / `role="status"`, and the Inventory
      result-count region now announces — additional regions are only worth adding where a real silent-update
      surface appears).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query has no UI consumer; give it the
      `maxPages` + `list-window.ts` treatment if a paginated item-history view is ever surfaced.

> With the skip-to-content link landed, the Phase-38 a11y follow-up bucket is now **exhausted** of high-leverage
> items — every remaining open item is a genuinely conditional/YAGNI Backlog entry with **no live trigger today**.
> Phase 41 has no pre-assigned slice — confirm scope with the developer at entry (or agree it is a conscious no-op
> until a real trigger appears).

## Deferred out of Phase 41 (§3 Kiosk & Tablet Ergonomics) — agreed 2026-06-28

With no enumerated phase and no Backlog item carrying a live trigger, Phase 41 was a **fresh-investigation pick**
(the developer's chosen mode, à la P37/P38). The investigation surfaced the one genuinely-unbuilt *mandated* spec
requirement — **§3 "Kiosk & Tablet Ergonomics"**: the Screen Wake Lock API was feature-*detected* (`hasWakeLock()`)
but **never requested**, and no dashboard view carried the mandated `touch-action: pan-y; user-select: none;`
containment. Both are now delivered behind one opt-in **Tier-2 `kioskMode`** preference (default off; Settings
"Kiosk & display" control): `useWakeLock(kioskMode)` on the Dashboard holds a `'screen'` sentinel, re-acquiring on
`visibilitychange` and degrading silently where the API is absent; the Dashboard `<main>` gets `touch-pan-y
select-none` only in kiosk mode (so casual use keeps pinch-zoom — no P38–40 a11y regression). The decision logic is
the pure `wakeLockAction` (`src/features/dashboard/wake-lock.ts`); the glue uses an injectable `WakeLockApi` seam
(`useWakeLock.ts`), component-tested with a fake. The §2.2.7 multi-tab guard (`tab-lock.ts`) was already done, so
this closes the remaining unbuilt half of the kiosk/tablet story. **No schema migration** — `kioskMode` is a
device-local Tier-2 preference (`user_version` stays **17**). The remaining open items are **re-scheduled, not
dropped** — all are still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **Broader `aria-live`** (further per-surface live regions) — **→ Backlog** (no live trigger; carried from P40).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query has no UI consumer; give it the
      `maxPages` + `list-window.ts` treatment if a paginated item-history view is ever surfaced.

> With kiosk ergonomics landed, **no remaining open item is a mandated spec requirement** — every one is a
> genuinely conditional/YAGNI Backlog entry with **no live trigger today**, and there is **no remaining "closest
> sibling" continuation of any kind**. Phase 42 has no pre-assigned slice — confirm scope with the developer at
> entry (pick a Backlog item deliberately, propose another fresh investigation, or agree it is a conscious no-op
> until a real trigger appears).

## Deferred out of Phase 42 (broader `aria-live` coverage) — agreed 2026-06-28

With no enumerated phase and no mandated requirement remaining, the developer chose the trigger-gated **broader
`aria-live` coverage** Backlog item. The investigation found two genuinely-silent **in-place** status surfaces (i.e.
not already covered by the Toast's mutation announcer or P40's skip-link / Inventory result-count region): the **Sync
screen's `sync-result` line** (a bare `<span>`, fully un-announced after "Sync now") and the **scanner's manual-entry
feedback** (the screen-reader channel of the §6.6 fallback — an unknown code and a successful scan both updated
silently). A new Foundry **`LiveRegion`** primitive (`live-region.tsx`, always-mounted so a later content change is
announced — the region must pre-exist) backed by the pure, unit-tested `liveRegionAttrs` (`aria-live.ts`:
`polite`→`role=status`, `assertive`→`role=alert`, both `aria-atomic`) wraps them: the Sync outcome (polite), the Sync
error banner upgraded to **assertive** `role="alert"`, the scanner manual-entry notice (polite) and a **visually-hidden**
"Scanned <name>" announcement (the visible result card is interactive). **No schema migration** — nothing persists
(`user_version` stays **17**). The remaining open items are **re-scheduled, not dropped** — all are still triggered
conditionals tracked in the roadmap Backlog row above:

- [ ] **Further `aria-live`** (additional per-surface live regions) — **→ Backlog** (the headline silent surfaces are
      now covered; a *new* region needs a genuinely silent in-place status surface to justify it).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query has no UI consumer; give it the
      `maxPages` + `list-window.ts` treatment if a paginated item-history view is ever surfaced.

> The headline `aria-live` cases are now covered; **no remaining open item is a mandated spec requirement** and none
> carries a live trigger today. Phase 43 has no pre-assigned slice — confirm scope with the developer at entry (pick a
> Backlog item deliberately, propose another fresh investigation, or agree it is a conscious no-op until a real trigger
> appears).

## Deferred out of Phase 43 (`prefers-reduced-motion` honouring) — agreed 2026-06-28

With no enumerated phase, no live Backlog trigger and no mandated requirement remaining, the developer asked to see
the Backlog list, then chose **a fresh investigation** (as Phases 37–42 were). The sweep confirmed §7.4 pre-flight
quota Hard Stop, §2.1 optimistic-update rollback and §6.5 scanner haptic+audio are all already built, and surfaced one
genuine gap: **`prefers-reduced-motion` was only partially honoured** (§3 / WCAG 2.3.3). The lone CSS reduce block
neutralised only the four bespoke `animate-*` utilities, leaving the `animate-spin` loader, all Tailwind `transition-*`
effects (31 files) and `scroll-behavior` live, with no JS seam. Landed: a broadened global CSS catch-all (spinner
exempted — functional feedback), a pure `prefersReducedMotion()` (`src/lib/env/motion.ts`), a live `useReducedMotion()`
hook behind an injectable `MediaQueryProvider` (`src/components/foundry/useReducedMotion.ts`), and Foundry Modal/Tooltip
dropping their entrance classes at source. **No schema migration** — nothing persists (`user_version` stays **17**). The
remaining open items are **re-scheduled, not dropped** — all still triggered conditionals tracked in the roadmap Backlog
row above:

- [ ] **Further `aria-live`** (additional per-surface live regions) — **→ Backlog** (carried from Phase 42; needs a
      genuinely silent in-place status surface to justify a new region).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Hard-failing bundle-size CI gate / leaner-or-precache-excluded WASM decoder** — **→ Backlog** (carried
      from Phase 15; the budget reporter stays warn-only).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query has no UI consumer; give it the
      `maxPages` + `list-window.ts` treatment if a paginated item-history view is ever surfaced.

> The reduced-motion gap is now closed; **no remaining open item is a mandated spec requirement** and none carries a
> live trigger today. Phase 44 has no pre-assigned slice — confirm scope with the developer at entry (pick a Backlog
> item deliberately, propose another fresh investigation, or agree it is a conscious no-op until a real trigger appears).

## Deferred out of Phase 44 (PWA install affordance + bundle-budget removal) — agreed 2026-06-28

The developer first asked to **remove the bundle-size budget entirely** ("unnecessarily constraining ourselves for no
real benefit, especially if it means not adding useful new features") — `scripts/check-bundle-size.mjs` is now an
informational size *reporter* only (no `BUDGET_KIB`, no `OVER BUDGET` warning, no headroom; it never warns and never
fails). This **retires** the "hard-failing bundle-size CI gate" Backlog item (the thing it would have enforced no longer
exists) and weakens the trigger on the leaner-WASM-decoder item (there is no longer a size gate forcing it). Then, for a
fresh investigation (as P37/P38/P43), the sweep found one genuine gap against a *mandated* §2 requirement: **the PWA was
not actually installable in one tap.** The manifest was install-ready and the persistence banner *told* the user to
install, but `beforeinstallprompt` was captured nowhere and nothing detected a standalone launch. Landed: a pure
`isStandaloneDisplay()` (`src/lib/env/install.ts`), a live `useInstallPrompt()` hook behind an injectable
`InstallPromptApi` seam (`src/components/foundry/useInstallPrompt.ts`), a one-tap **Install Gubbins** action in the §2
persistence banner (suppressed once installed), and a permanent **App → Install Gubbins** Settings entry. **No schema
migration** — install state is ephemeral/device (`user_version` stays **17**). The remaining open items are
**re-scheduled, not dropped** — all still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **Further `aria-live`** — **→ Backlog** (carried from Phase 42; needs a genuinely silent in-place status surface).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Leaner / precache-excluded WASM decoder** — **→ Backlog** (carried from Phase 15; offline-scanning trade-off,
      and with the P44 budget removal there is no longer a size gate forcing it).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query has no UI consumer; give it the `maxPages`
      + `list-window.ts` treatment if a paginated item-history view is ever surfaced.
- [x] **Hard-failing bundle-size CI gate** — **retired in Phase 44** (the budget it would enforce was removed outright).

> The §2 installability gap is now closed; **no remaining open item is a mandated spec requirement** and none carries a
> live trigger today. Phase 45 has no pre-assigned slice — confirm scope with the developer at entry (pick a Backlog
> item deliberately, propose another fresh investigation, or agree it is a conscious no-op until a real trigger appears).

## Deferred out of Phase 45 (§3 Customisable Dashboard widget board) — agreed 2026-06-28

The developer confirmed a **fresh investigation** at entry; the sweep found a genuine *mandated* §3 gap — the
**Customisable Dashboard** was unbuilt. `DashboardScreen` carried a literal *"the customisable widget dashboard proper
(spec §3) is built out in later phases"* deferral comment and was a fixed board (status cards + a fixed lifecycle-alert
grid); `useLayoutStore` owned only density+sidebar despite §2.1 naming it the home of the "dashboard widget layout
coordinates"; and the §3-named **"Low Stock Alerts"** widget did not exist at all. The developer chose the **full
drag-and-drop grid** depth and to **add the new Low Stock + Project-status widgets**. Landed: a pure coordinate seam
(`features/dashboard/dashboard-layout.ts` — `(x,y)` placement, swap-on-drop `moveWidget`, keyboard `nudgeWidget`,
`setWidgetVisible`, registry `reconcileLayout`), `useLayoutStore.dashboardLayout` (localStorage, **device-local — no DB
migration**), a 10-widget registry (`widgets.tsx`) with the new `Low Stock Alerts` (new `ItemRepository.listLowStock`),
`Project statuses` (reuses `useProjects`) and a `Quick links` widget, and `DashboardGrid` (native HTML5 drag-and-drop +
arrow-key reorder + show/hide + "Customise" edit mode; single-column flow below `sm`). **No schema migration** —
`user_version` stays **17**; 927 unit / 94 files / 79 smoke. The remaining open items are **re-scheduled, not dropped**
— all still triggered conditionals tracked in the roadmap Backlog row above:

- [ ] **Further `aria-live`** — **→ Backlog** (carried from Phase 42; needs a genuinely silent in-place status surface).
- [ ] **True NTP / cross-origin time source** — **→ Backlog** (carried from Phase 14).
- [ ] **Leaner / precache-excluded WASM decoder** — **→ Backlog** (carried from Phase 15; offline-scanning trade-off, no
      size gate since the P44 budget removal).
- [ ] **Multi-scrape UI tray / live distributor selector maintenance** — **→ Backlog** (carried from Phase 13).
- [ ] **Phase-37 `useItemHistory` residual** — the unbounded infinite query still has no UI consumer; give it the
      `maxPages` + `list-window.ts` treatment if a paginated item-history view is ever surfaced.

> **Low-stock thresholds note (not a deferral, just scope):** the §3 Low Stock widget uses fixed default thresholds
> (`LOW_STOCK_QTY_THRESHOLD = 5`, `LOW_STOCK_GAUGE_PERCENT = 15`); `listLowStock` already accepts per-call overrides, so
> surfacing them as a `usePreferencesStore` control (mirroring `expirySoonWindowDays`) is a clean future add if wanted.
>
> With the §3 customisable-dashboard gap closed, **no remaining open item is a mandated spec requirement** and none
> carries a live trigger today. Phase 46 has no pre-assigned slice — confirm scope with the developer at entry (pick a
> Backlog item deliberately, propose another fresh investigation, or agree it is a conscious no-op until a trigger appears).

---

## Phase 54 — Location description & colour

Added a free-text `description` and an optional pastel `color` swatch to locations (additive **v19** nullable
columns `description`/`color`; `user_version = 19`). Colour is stored as a semantic *swatch key* mapped to themed
`text-loc-*` tokens (12 pastels, dark+light), and tints the location *name* in the sidebar, the parent/Move-Item
pickers, and the item cards/rows. Description shows in the Add/Edit dialogs and as a sidebar hover/focus tooltip.

Deferred (re-scheduled, not dropped):

- [x] **Colour the Add Item location picker** — **done in Phase 55.** `CreateItemDialog`'s Location field is now the
      tinted `LocationSelect` listbox (the same one Move Item/parent pickers use), driven by an RHF `Controller` and
      associated via a sibling `<span id>` + `labelledBy` (an implicit `<label>` can't name a `div[role=combobox]`,
      so the field is *not* wrapped in `FormField` — it mirrors `MoveItemDialog`). The three smoke
      `getByLabel('Location').selectOption` calls became open-combobox + click-option, and one asserts the teal
      Workshop option carries its swatch token. No schema change (`user_version` stays **19**). Every location surface
      now shows the colour; no uncoloured selection dropdown remains.

## Phase 55 — Colour the Add Item location picker (Phase-54 residual)

Cleared the one concrete Phase-54 deferral: `CreateItemDialog`'s Location field is converted from a native
`<select>` to the tinted `LocationSelect` combobox (the same accessible select-only listbox the parent / Move-Item
pickers use), driven by an RHF `Controller` and named via a sibling `<span id>` + `labelledBy` rather than
`FormField`'s implicit `<label>` (which can't name a `div[role=combobox]`) — mirroring `MoveItemDialog`. Options come
from the existing pure `buildItemLocationOptions(locations, fmt.quantity)`, so each row shows the location's colour
swatch + item count. **No new schema/migration** (`user_version` stays **19**); no dependency change; the three Add
Item smoke flows now open the combobox + click the option, and the cycle-count flow asserts the teal Workshop option
carries `text-loc-teal`. 1130 unit / 115 files / 92 smoke. **`build:extension` NOT re-run** (no §9 / `extension/`
edit).

No mandated spec gap remains, and there is no further tracked location-UI residual. Remaining open work is the
unchanged trigger-gated Backlog (multi-scrape UI tray, true NTP/cross-origin time source, leaner/precache-excluded
WASM decoder, live distributor selector maintenance, further `aria-live`) — none with a live trigger today.

## Phase 56 — §4.1.1 operational-metadata editor (fresh investigation)

A fresh-investigation pick à la P37–P53. The §4.1.1 "flexible metadata layer for operational parameters" — a
schema-less per-item JSON object (the spec's own example `{ bed_temp_celsius: 60, extrusion_multiplier: 0.98,
drying_time_hrs: 4 }`) — existed in the schema since **v2** (`items.operational_metadata`), was repository-mapped,
accepted by `CreateItemInput`/`UpdateItemInput`, and synced for free (`items` ∈ `SYNC_TABLES`), **but appeared in zero
`.tsx` files** — every *other* Consumable-Gauge field (`unit_of_measure`/`gross_capacity`/`tare_weight`/
`current_net_value`) was surfaced and this one alone was invisible, so a user could neither enter nor see it.

Now surfaced as an **"Operational parameters"** section in `ItemDetailDialog` (`OperationalMetadataEditor.tsx`): a
free-form key→value row editor saved wholesale via the existing `useUpdateItem`. The developer chose to expose it on
**every item** (not just gauges), so the field was **promoted from the gauge-nested `GaugeState.operationalMetadata`
to a top-level `Item.operationalMetadata`** read by `rowToItem` for all rows; `UpdateItemInput.operationalMetadata`
+ a new branch in `ItemRepository.update` persist it (inline `JSON.stringify`, mirroring the create path, so the db
layer holds no feature-layer import). The rows↔record conversion, value coercion (a canonical numeric string →
number per the spec example; `true`/`false` → boolean; non-canonical kept verbatim) and Zod-validation (§2.4.4) are
the pure, unit-tested **`features/inventory/operational-metadata.ts`** seam (`buildMetadata`/`metadataToRows`/
`coerceMetadataValue`), mirroring the `gauge.ts`/`history-format.ts` "logic out of the glue" pattern. An empty set
stores SQL NULL, never `{}`.

**No schema/migration change** — the column already exists (`user_version` stays **19**); no dependency change.
**`build:extension` NOT re-run** (no §9 / `extension/` edit). No mandated spec gap remains; the remaining
trigger-gated Backlog (multi-scrape UI tray, true NTP/cross-origin time source, leaner/precache-excluded WASM
decoder, live distributor selector maintenance, further `aria-live`) is unchanged, none with a live trigger today.

> **Concurrent refactor folded in (not the Phase-56 pick):** alongside this work `ItemDetailDialog` was reworked
> from a flat scroll of `Section` cards into a **WAI-ARIA APG vertical `tabs`** layout — the ten facet editors are
> grouped into five tabs (**Supplier & ops** holding Supplier data + Operational parameters, **Lifecycle**,
> **Media & docs**, **Classification**, **Activity**), with arrow-key navigation in the pure, unit-tested
> `tab-keyboard.ts` (`resolveTabKey`). Only the active tab's panel is mounted; the operational-parameters editor
> lives in the default "Supplier & ops" tab. Every detail-dialog smoke step now clicks its tab first. **Final totals
> for the phase: 1153 unit / 117 files / 93 smoke; build 2931.08 KiB across 32 precache files (reporter only).**
