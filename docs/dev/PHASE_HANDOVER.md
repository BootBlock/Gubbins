# PHASE_HANDOVER.md — Wave 1 (Phases 59–61) → Phase 62

**Project:** Gubbins — local-first inventory tracking PWA
**Wave completed:** **Inventory-depth Wave 1 (Phases 59, 60, 61)** — competitor-gap closure, run as
three parallel git worktrees (one implementation sub-agent each), code-reviewed per phase, and
merged to `main` in ascending migration order by the orchestrator.
**Date:** 2026-06-30
**Status:** ✅ Complete. `npm run type-check` clean (exit 0) · `npm run build` passes (bundle reporter
prints **~3054 KiB across 43 precache files, no budget — informational only**) · **1395/1395 unit
tests pass** across **140 test files** on the **`threads`** pool · the browser smoke gained **3 new
steps** (one per phase). **Schema: `PRAGMA user_version = 22`** (v21 reorder points, v22
supplier-parts; Phase 61 added no migration). **No dependency change.** **`build:extension` NOT
re-run** (no §9 / `extension/` edit in any phase).

> ℹ️ **Plan & execution model.** This wave is part of `docs/todo/inventory-depth_2026-06-30.md`
> (Phases 59–62), a parallelised competitor-gap closure with **pre-allocated migration versions**
> (59→v21, 60→v22, 61→none, 62→v23) so concurrent worktrees never claim the same `user_version`.
> Each phase: its own worktree + implementation sub-agent, a **mandatory code-review gate before
> merge**, then merge in ascending version order resolving the trivial array-append conflicts.
> **Wave 2 = {62} (Formal Purchase Orders, v23) is the remaining, final phase** — see
> `docs/todo/inventory-depth_2026-06-30.md` → "Continuation prompt".

---

## 0. Wave-1 orchestration notes the Phase-62 agent should know

- **Migration-engine contiguity guard.** Phase 60's worktree (run before Phase 59 merged)
  legitimately lacked `v21`, so its agent temporarily relaxed `assertValidSequence`
  (`src/db/migrations/engine.ts`) from strict-contiguity to ascending-unique to boot. On merge the
  registry is contiguous again (v20→v21→v22), so the **strict-contiguity guard was restored**
  (commit `730e93e`). **Phase 62 branches from a `main` already at v22 and appends v23 — that is
  contiguous, so no engine change is needed or wanted.** Just append v23.
- **Merge-conflict surface (as the plan predicted).** The only merge conflicts were trivial:
  array-append clashes in `src/db/migrations/index.ts` and three new `scripts/browser-smoke.mjs`
  steps inserted at the same spot. `mappers.ts`, `src/db/repositories/index.ts`, the icon registry,
  `SYNC_TABLES`, and `FK_REFS` auto-merged. Expect the same shape for Phase 62 (resolve by keeping
  both lines, ascending order; keep all smoke steps, each fully `})`-closed before the next).
- **Worktree dir cleanup on Windows.** `git worktree remove --force` can hit `Permission denied`
  if a file handle lingers; the branch still deletes and `git worktree prune` clears the admin
  record. A leftover dir under `.claude/worktrees/` is harmless.
- **Carried smoke flag (pre-existing, NOT a Wave-1 regression).** The §4 multi-level variants step
  *"nests a sub-variant beneath a variant (Phase 18)"* was reported failing on `main`'s baseline by
  the Phase-61 agent (a `locator.waitFor` timeout in the variants path; untouched by any Wave-1
  diff). Verify and close this during Phase 62. The long-standing **"adds a weighted capability"
  `press('Enter')` flake** also persists — **re-run the smoke once** before investigating a red.

---

## 1. Locked decisions & toolchain (spec §1.2 — binding, unchanged)

| Area | Decision |
| --- | --- |
| SQLite WASM | `@sqlite.org/sqlite-wasm` — official build, FTS5 + **OPFS VFS** (`/gubbins.sqlite3`). FTS5 verified at boot via `probeFts5`. |
| Package manager | **npm** (only `package-lock.json`). |
| Hosting | **GitHub Pages** → Vite `base: '/Gubbins/'` + coi-serviceworker COOP/COEP (`src/sw.ts` injectManifest). PWA `registerType: 'prompt'` — a waiting worker installs but holds until the in-app `PwaUpdatePrompt` "Reload now". |
| Cloud sync | **Provider-agnostic** `CloudProvider` interface; in-memory + File System Access adapters. **No provider SDK** in the dep tree. |
| Conflict resolution | Row-level **LWW** + tombstones (§7.2, 180-day TTL); **Delta-CRDT** gauge replay (§7.3); §7.5 orphan re-parent + cycle rejection + child-FK guard. |
| Extension bridge | **`window.postMessage`** Content-Script bridge (§9); seven-member `SCRAPE_ERROR` set. **Untouched since P36** (and untouched by Wave 1). |
| Test runner | **Vitest**, native `crypto.randomUUID()`, `Intl`, **`test.pool: 'threads'`**, `npm run test:run` wraps `vitest run` with a single auto-retry of the Node-25 cold-start flake (`scripts/run-unit-tests.mjs`). |
| E2E | **Playwright** driving system **Edge** (`channel: 'msedge'`); fake camera; `setOffline` for connectivity; a second device via `localStorage['gubbins:device-id']` + reload. Custom `LocationSelect` combobox driven by role+click, never `selectOption`. |
| Bundle size | **No budget (P44).** `scripts/check-bundle-size.mjs` is informational only. |
| Native-first | Web APIs over NPM bloat; virtualised bounded lists; native BarcodeDetector → off-thread zxing; `Intl` via `makeFormatters`/`useFormatters`; design tokens only. |
| Base currency / locale | **GBP / en-GB** defaults, user-configurable. |

**Installed majors (unchanged by Wave 1):** React 19 · TS 6 · Vite 8 (Rolldown) · Vitest 4 · Tailwind 4 ·
TanStack Router/Query/Virtual · Zustand 5 · React Hook Form 7 + Zod 4 · lucide-react · vite-plugin-pwa ·
react-error-boundary · `fflate` · `@zxing/library`. Node **v25.2.1**.

**Commands:** `npm run dev` · `npm run build` · `npm run type-check` · **`npm run test:run`** (1395) ·
`npm run test:e2e` (live dev server) · `npm run check:bundle` · `npm run build:extension`. Launch the dev
server in a persistent background process (Bash `run_in_background`, or `cmd.exe /c "npm run dev"` —
`Start-Process npm` fails); pass `SMOKE_BASE=http://localhost:<port>/Gubbins/` if not on 5173; stop via PID.
`$pid` is a read-only PowerShell automatic variable — use another loop variable.

> ⚠️ **`npm run type-check` pipe trap:** capture `${PIPESTATUS[0]}` / `$LASTEXITCODE`; piping `tsc` through
> `tail`/`head` masks the exit code. **Route-tree** (`src/routeTree.gen.ts`) is generated by Vite, not `tsc` —
> if you add a `src/routes/*` file (Phase 61 added `reports.tsx`), run `npx vite build` once before type-check.
> `noUnusedLocals` + `noUncheckedIndexedAccess` are on. A pure `.ts` and a component `.tsx` must not share a
> basename (P42). Design tokens only — never raw hex / Tailwind palette classes.

---

## 2. Database schema snapshot — `PRAGMA user_version = 22`

Migration registry (`src/db/migrations/index.ts`) is contiguous **v1 … v22**; `TARGET_SCHEMA_VERSION` is
derived as the max registered version. New since the previous handover (v19/v20):

- **v20 `v20-project-budgets`** (Phase 58, pre-existing at the start of this wave): §4 project budgeting.
- **v21 `v21-item-reorder-point`** (Phase 59): additive **nullable** `items` columns `reorder_point`
  (INTEGER), `reorder_gauge_percent` (REAL), `reorder_qty` (INTEGER). NULL = "use the global default".
  `items` already syncs, so these auto-join the LWW payload — **no** `SYNC_TABLES`/`FK_REFS` edit. They
  round-trip through `mappers.rowToItem`, the `Item`/`ItemRow`/create/update types, and the item
  create/update paths (all `items` reads use `SELECT items.*`, so no explicit read-column list needed).
- **v22 `v22-supplier-parts`** (Phase 60): new **synced** table `supplier_parts` — `id` (UUID TEXT PK),
  `item_id` (TEXT FK → items **ON DELETE CASCADE**), `supplier_name`, `order_code`, `unit_cost` (REAL
  nullable), `currency` (TEXT nullable), `pack_qty`/`min_order_qty` (INTEGER nullable), `price_breaks`
  (TEXT JSON nullable — `[{qty,unitCost}]`), `url` (nullable), `is_preferred` (0/1), `updated_at` + the
  canonical §7.1 `WHEN NEW.updated_at = OLD.updated_at` auto-stamp trigger; STRICT + sane CHECKs. Added to
  `SYNC_TABLES` immediately **after `items`** and to `FK_REFS` (`item_id → items`, non-nullable → an
  incoming orphan is dropped, matching CASCADE). Covered by a two-device LWW + orphan-drop round-trip test.

The `items` auto-stamp + FTS triggers, and all earlier seams (v13 `item_stock`, v15 `stock_batches`,
v12 `received_qty`, etc.), remain untouched.

> ⚠️ `LocationRepository.SELECT_WITH_COUNT` still lists `locations` columns explicitly — any future
> additive `locations` column must be added there. `ItemRepository` item reads use `SELECT items.*`.

---

## 3. What shipped in Wave 1 (new repositories, seams, UI)

### Phase 59 — Per-item reorder points (v21)
- **Pure seam** `src/features/inventory/reorder-policy.ts` (`isLow`, `shortfall`, `effectiveQtyThreshold`,
  `effectiveGaugePercent`) — no DB/clock; unit-tested.
- **`ItemRepository.listLowStock`** (`src/db/repositories/item/feeds.ts`) now `COALESCE`s the per-row
  override over the global default (`MAX(COALESCE(reorder_point, :qty), 1)` zero-floor guard; gauge path
  `current_net_value <= gross_capacity * COALESCE(pct, :pct) / 100.0`, `gross_capacity > 0` filtered).
- **UI:** `ReorderPointEditor.tsx` on the item-detail "Supplier & ops" tab (with `InfoHint`); the Low
  Stock dashboard widget surfaces "reorder N"; Settings relabels the globals as the **default**.

### Phase 60 — Supplier-parts (v22)
- **`SupplierPartRepository`** (`src/db/repositories/SupplierPartRepository.ts`): CRUD + `listForItem` +
  `getPreferred` + `setPreferred` (atomic single-winner per item). Registered in the barrel as
  `getSupplierPartRepository()`. Types in `src/db/repositories/types/supplier-parts.ts` (incl. `PriceBreak`).
- **Pure cost-precedence helper** `src/features/inventory/supplier-cost.ts` → `effectiveUnitCost(item,
  supplierParts)`: manual `items.unitCost` wins, else the preferred supplier-part's `unit_cost`, else null.
  **This is the canonical cost source — Phase 62 valuation/line-cost defaults should reuse it** (and
  Phase 61's report cost seam is the place to later adopt it; see below).
- **Pure scrape-persist planner** `src/features/scraping/supplier-part-plan.ts`: §4 **no-overwrite** —
  only FILLs blank fields or overwrites a CONFLICT field when explicitly opted in.
- **UI:** `SupplierPartsTable.tsx` + `SupplierPartFormDialog.tsx` replace the read-only supplier `<dl>` in
  `SupplierDataEditor.tsx`. The form **validates on submit** (positive-integer pack/MOQ, non-negative cost)
  and renders an accessible `role="alert"` (`data-testid="supplier-part-error"`) rather than letting the
  repository CHECK throw silently.

### Phase 61 — Reporting & valuation (no migration)
- **`ReportRepository`** (`src/db/repositories/ReportRepository.ts`, `getReportRepository()`): read-only
  `inventoryValue()` (overall + by category + by location, reading the `item_stock` ledger for the
  location split), `consumptionRate(window)`, `movement(window)`, `lowStockCount()`, `deadStock(sinceDays)`.
- **Pure aggregation** in `src/features/reports/reports.ts` (grouping, consumption windows, movement
  bucketing, dead-stock boundary) + `report-csv.ts` (RFC-4180 builders). Cost funnels through one internal
  `effectiveUnitCost` seam using **`items.unitCost`** today (Phase 60 ran in parallel, so its
  preferred-supplier helper is not yet wired here — **a worthwhile follow-up is to adopt
  `supplier-cost.ts`'s `effectiveUnitCost` in the report cost seam now that both are on `main`**).
- **UI:** `/reports` route (`src/routes/reports.tsx`) + `ReportsScreen.tsx` (headline value cards,
  `ValueBreakdown` + `MovementChart` token-styled Tailwind/SVG, **no new chart dep**), `useFormatters()`,
  a `<main id={MAIN_CONTENT_ID} tabIndex={-1}>` skip target, and nav entries on Dashboard + Inventory. CSV
  export routes through the existing Export Wizard's remembered-settings path (new `reportKind`).

---

## 4. Testing (TDD-first) — 1395 unit / smoke +3 steps

- **+~91 unit tests** across the wave (reorder-policy + listLowStock override; supplier-part repo +
  single-preferred + cost precedence + no-overwrite planner + sync round-trip; report aggregations + CSV +
  `:memory:` ReportRepository). All over `createMemoryDriver()` (`:memory:`, §8.5.2).
- **Smoke (+3 steps):** set a per-item reorder point and assert the Low Stock widget reacts (P59); add an
  editable supplier part + star it preferred + persist round-trip (P60); open `/reports` and assert a
  non-zero inventory value + the Export-Wizard "Report CSV" format (P61). Each is placed **before** the
  Phase-53 datasheet step (which does a mid-suite `page.reload()` + device-id swap).
- **Established seams unchanged:** Repository/driver; pure helpers out of glue; injectable `lib/env/*` +
  `apiOverride`; the v13/v15 guarded-recompute stock pattern; the Phase-24 `planReceipt` /
  `ProjectRepository.receiveLine` partial-receipt seam and Phase-28 batch landing (**Phase 62 must reuse
  these for PO receiving — do not hand-roll a second stock-mutation path**); the Phase-20 derived
  In-Transit projection pattern (**reuse for on-order qty**).

---

## 5. Files added/changed in Wave 1 (orientation map)

- **New (Phase 59):** `src/db/migrations/v21-item-reorder-point.ts` (+ test),
  `src/features/inventory/reorder-policy.ts` (+ test), `ItemRepository.phase59.test.ts`,
  `src/features/inventory/components/ReorderPointEditor.tsx`.
- **New (Phase 60):** `src/db/migrations/v22-supplier-parts.ts` (+ test),
  `src/db/repositories/SupplierPartRepository.ts` (+ test), `src/db/repositories/types/supplier-parts.ts`,
  `src/features/inventory/supplier-cost.ts` (+ test), `src/features/scraping/supplier-part-plan.ts`
  (+ test), `src/features/inventory/components/SupplierPartsTable.tsx` + `SupplierPartFormDialog.tsx`.
- **New (Phase 61):** `src/db/repositories/ReportRepository.ts`, `src/features/reports/reports.ts` +
  `report-csv.ts` (+ tests), `src/routes/reports.tsx`, `ReportsScreen.tsx` + `ValueBreakdown.tsx` +
  `MovementChart.tsx`.
- **Edited (shared):** `src/db/migrations/index.ts` (v21+v22 appended); `engine.ts`/`engine.test.ts`
  (strict-contiguity guard restored post-merge); `mappers.ts`, `types/items.ts`, `types.ts`, repo barrel
  `index.ts`; `item/{core,create,normalise,feeds}.ts`; `tombstone.ts` (SYNC_TABLES), `reconcile.ts`
  (FK_REFS), `sync-engine.test.ts` (round-trip); `ItemDetailDialog.tsx`, `SupplierDataEditor.tsx`,
  `dashboard/widgets.tsx`, `SettingsScreen.tsx`, the icon registry, the Export Wizard store/screen, nav
  headers; `scripts/browser-smoke.mjs` (+3 steps).
- **Unchanged:** every pre-v20 migration; `protocol.ts`/`scrape-errors.ts`/the §9 path; `extension/dist/*`;
  `package.json`; `vite.config.ts`; the flake-retry runner.

---

## 6. Technical debt, stubs & deferrals

> Tracked in `docs/dev/deferred-features.md` and the plan doc's per-phase Outcome notes.

- **Adopt the Phase-60 cost helper in Phase-61 reports** (above) — `supplier-cost.ts`'s `effectiveUnitCost`
  is now on `main`; the report cost seam still uses `items.unitCost`. A clean, isolated follow-up.
- **Waived NITs (recorded):** P59 — curly-vs-straight apostrophe in the InfoHint copy; `shortfall` returns
  0 for gauges by design. P60 — a redundant `getById` round-trip in `SupplierPartRepository.update`; no
  explicit malformed-`price_breaks`-JSON repository test (the mapper is defensively covered). P61 — add the
  explicit `notAVariantParent` predicate to the per-location valuation query for visible consistency
  (already correct via the `item_stock`/`quantity>0` SSOT invariant); a one-line comment on the
  `consumptionRate` per-row delta assumption.
- **Carried smoke flag:** the §4 multi-level variants step ("nests a sub-variant beneath a variant",
  Phase 18) failing on baseline `main` — verify/close in Phase 62.
- **Carried LWW/attachment notes** (unchanged): concurrent location-delete vs offline stock edit can
  transiently over-count until reconcile; a legacy pre-v18 `LOCAL_POINTER` (NULL origin) stays `local`.

---

## 7. Phase 62 entry checklist (Formal Purchase Orders, v23 — depends on Phase 60, now merged)

- [ ] Read the master spec (§4 BOM/procurement, §7 sync) **and** this handover **and** the Phase 62 section
      of `docs/todo/inventory-depth_2026-06-30.md`; restate the locked decisions before writing code.
- [ ] **Migration `v23-purchase-orders`** (append, never renumber; `user_version` → 23 — contiguous, so
      **do not touch the engine guard**): two synced tables — `purchase_orders` (`id`, `supplier_name`,
      `reference`, `status` TEXT `DRAFT|ORDERED|PARTIAL|RECEIVED|CANCELLED`, `currency`, `created_at`,
      `ordered_at` nullable, `updated_at` + auto-stamp) and `purchase_order_lines` (`id`, `po_id` FK →
      purchase_orders CASCADE, `item_id` FK → items nullable, `supplier_part_id` FK → supplier_parts
      nullable, `description`, `ordered_qty`, `received_qty` accumulates, `unit_cost`, `updated_at`). Add
      both to `SYNC_TABLES` (`purchase_orders` **before** `purchase_order_lines`, both after
      `supplier_parts`/`items`) and the matching `FK_REFS` entries; a removed supplier-part/item **NULLs**
      the line's nullable FK (don't block the delete). Add a migration test (`>=` version asserts).
- [ ] **Derive-don't-store:** ORDERED/PARTIAL/RECEIVED is derived from `SUM(received_qty)` vs
      `SUM(ordered_qty)` via a pure `po-status.ts`; only DRAFT/CANCELLED are persisted. A pure
      `planPoReceipt` **wraps** the Phase-24 `planReceipt` / `ProjectRepository.receiveLine` (+ Phase-28
      batch landing) — **never** a second stock-mutation path. On-order qty is a derived per-item
      projection (Phase-20 In-Transit pattern). Default a line's `unit_cost` from the Phase-60
      `effectiveUnitCost`/preferred supplier where sensible.
- [ ] **`PurchaseOrderRepository`** (`:memory:` tests: partial → PARTIAL, full → RECEIVED, receive-into-
      stock); `po-status` + `planPoReceipt` pure tests; a sync round-trip; a smoke that creates a PO,
      receives a line, and asserts on-hand rose (place it before the Phase-53 step; close each smoke step
      fully). PO list + detail + per-line receive UI (partial allowed, optional destination location/batch);
      design tokens only, British English.
- [ ] Verify four ways green (type-check exit code; `test:run`; `build`; `test:e2e` on a live dev server —
      re-run once for the known flakes; **also verify/close the carried variants-smoke flag**). Run
      `build:extension` only if you touch §9/`extension/` (you should not). `npm install` first in the
      worktree.
- [ ] Code-review the diff before merge; fix or waive findings; merge resolving the trivial array-append
      conflicts; remove the worktree; `test:run` green. Then append the Phase 62 Outcome note, update this
      handover, and record that the inventory-depth plan (59–62) is **complete** (no Wave 3).
