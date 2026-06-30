# Inventory-breadth phases (65–68) — second feature-gap closure (2026-06-30)

> **Living document.** Each phase is implemented in its own worktree/session. Tick the
> `[ ]` boxes as work lands, append a one-paragraph **Outcome** note under each phase when it
> completes (mirroring `docs/dev/deferred-features.md`), and re-schedule — never silently
> drop — any deferred item.
>
> **Continuation-prompt rule (mandatory).** When a phase (or a parallel wave) completes you
> **must** do **both** before ending the session:
>
> 1. **Emit the next wave's kick-off prompt directly in the chat reply** as a **raw, fenced
>    Markdown code block** (a ```` ```text ```` block the user can copy verbatim into a new
>    chat). It is the **last thing** in the reply. Do not merely say "added it to the doc".
> 2. **Record that same prompt** under [Continuation prompt](#continuation-prompt) at the foot
>    of this doc (replacing the previous one).
>
> The two must be **identical**.

## Why these phases exist

A second 2026-06-30 feature audit (auto-memory `feature-gap-audit-2026-06-30b`) re-benchmarked
Gubbins against the hobbyist/consumer/pro-sumer/enterprise inventory tools (Sortly, InvenTree,
PartKeepr, Snipe-IT, Grocy) **after** the inventory-depth plan (Phases 59–62) closed reorder
points, supplier-parts, reporting and formal POs. Gubbins already meets or beats the field on
scanning, batch/lot traceability, per-location stock, cycle counting, gauges, BOM+assemblies,
variants, supplier-parts, POs, reporting and sync. Four in-scope **breadth** gaps were confirmed,
in priority order:

1. **Procurement automation** — P59 gives per-item reorder points + `shortfall`; P62 gives formal
   POs; **nothing connects them.** Turn the shortfall into a consolidated "needs reordering" list
   grouped by preferred supplier, with one-click drafting of supplier-keyed DRAFT POs.
2. **Asset lifecycle** — no purchase-date / warranty / value / depreciation fields exist anywhere
   (Snipe-IT-style asset facet). Additive nullable `items` columns; drives warranty alerts (gap #4).
3. **Bulk CSV catalog import/export** — only `bom-import.ts` exists; no whole-catalog spreadsheet
   onboarding. The biggest first-run friction; every consumer tool ships it.
4. **Alert centre** — low-stock / expiry / maintenance-due / warranty-due only surface as separate
   dashboard widgets; no consolidated proactive alerts feed. In-app only (web push needs a server).

Everything else absent (multi-user/roles, multi-currency/FX, AI forecasting, omnichannel/POS, RFID,
accounting integration, generic REST/webhook API beyond the HA bridge) remains deliberately out of
scope for a local-first, single-user, hobbyist-premium PWA and is **not** chased here. Two further
audit candidates (category custom-field templates; advanced analytics / ABC / turnover; label
customisation) are parked for a possible later wave.

## Numbering note

This plan was originally drafted (in another session) as Phases 63–66, colliding head-on with the
parallel **accessibility lineage** that shipped **Phase 63 = broader `aria-live` coverage** (merged
`71324cc`) and reserved **Phase 64 = aria-live Tier B**. Per developer decision (2026-06-30) the
inventory-breadth plan **renumbers to follow that lineage (≥ 65)**. The combined kick-off therefore
finishes the a11y arc first (**Phase 64**, tracked in `docs/dev/deferred-features.md`, *not* this
doc), then opens this plan at **Phase 65**.

## Execution model — worktrees, sub-agents, code-review gates

These phases obey the standing protocols (§8): strict phasing, autonomous TDD (§8.2),
`:memory:` node:sqlite unit tests + a real-browser smoke (§8.5), derive-don't-store seams,
pure `.ts` logic split out of glue (mirror `cycle-count.ts` / `list-window.ts` /
`reorder-policy.ts` / `aria-live.ts`), **British English**, **design tokens only** (CLAUDE.md —
reach for Foundry primitives first), and a PHASE_HANDOVER per phase (§8.1). On top of that, this
plan is **parallelised**:

- **One git worktree per phase**, implemented by a dedicated **implementation sub-agent**
  (`Agent`, `isolation: "worktree"`), so concurrent phases never share a working tree. Each agent,
  **before any work**, MUST: (1) verify its worktree base is current `main` and `git rebase main`
  if not (the harness may branch from an old commit); (2) junction `node_modules` from the main
  checkout if absent (PowerShell `New-Item -ItemType Junction` — Git Bash `mklink /J` mangles the
  flag); (3) confirm the toolchain runs — use `npx tsc -p tsconfig.app.json --noEmit` in a
  junctioned worktree (`tsc -b` can't write `.tsbuildinfo` through a junction). Strict file
  isolation: each agent touches only its surface files + their tests, and runs its own browser smoke.
- **Code-review gate after every phase (mandatory).** When an implementation sub-agent reports
  done, run a **review sub-agent** (or `/code-review high`) against *that worktree's diff* **before
  merge**. Findings must be fixed (or explicitly waived in the Outcome note). No phase merges to
  `main` un-reviewed.
- **Merge discipline.** Octopus-merge a wave's reviewed branches onto an integration branch
  (disjoint files merge cleanly), junction `node_modules`, run `npx tsc -p tsconfig.app.json
  --noEmit` + the full `npm run test:run`, then merge to `main`. **Remove each worktree's
  `node_modules` junction (`cmd /c rmdir`) BEFORE `git worktree remove`**; then `git worktree
  prune` and delete merged branches. Later waves branch from the updated `main`.

### Migration-version allocation (collision-avoidance)

Only **Phase 66** touches schema → **v24** (next free version; the aria-live work added none). Each
agent appends *only* its own migration and registers it in `src/db/migrations/index.ts`, keeping the
strict-contiguity guard intact; trivial merge clashes (`index.ts` / `SYNC_TABLES` in `tombstone.ts`
/ `FK_REFS` in `reconcile.ts` / the repository barrel) resolve by keeping both lines in ascending
order.

| Phase | Migration | `user_version` after |
| --- | --- | --- |
| 65 — Procurement automation | **none** (composes existing seams) | unchanged |
| 66 — Asset lifecycle | `v24-item-asset-lifecycle` | 24 |
| 67 — Bulk CSV catalog import/export | **none** | unchanged |
| 68 — Alert centre | **none** (dismissals device-local) | unchanged |

### Dependency graph & waves

```
Wave 1:            64 (a11y, no migration) — run alone first; merge before Wave 2.
Wave 2 (parallel): 65 (no migration)   66 (v24)   67 (no migration)
Wave 3 (after 66): 68 (no migration — warranty alert lane needs 66's columns)
```

- **64** is part of the accessibility lineage, not this plan's numbering — run + merge it first so
  Wave 2 branches from a `main` that already carries it. Its Outcome note lives in
  `docs/dev/deferred-features.md`.
- **65 ⟂ 66 ⟂ 67** — independent surfaces; safe to run concurrently (only 66 touches schema).
- **68 depends on 66** — the warranty alert lane reads the Phase-66 asset-lifecycle columns, so
  68's worktree must branch from a `main` that already contains the merged Phase 66.

So: run **Wave 1 = {64}**, review + merge; launch **Wave 2 = {65, 66, 67}** in three parallel
worktrees, review + merge each; then **Wave 3 = {68}** alone. Code review after *every* phase.

---

## Phase 65 — Procurement automation: reorder → shopping list → draft POs (no migration)

* **Objective.** Close the P59↔P62 loop: turn the per-item reorder shortfall into a consolidated
  "needs reordering" list grouped by **preferred supplier**, with one-click drafting of
  supplier-keyed DRAFT POs.
* **Pure seam.** `src/features/purchasing/reorder-plan.ts` — given shortfall rows + each item's
  preferred supplier-part, produce
  `{ supplierName, lines:[{itemId, supplierPartId, orderQty, unitCost}] }[]` (group by preferred
  supplier; no-supplier items → an "unassigned" group; `orderQty = max(shortfall, supplier
  pack/MOQ rounding)`). Unit-tested, no DB.
* **Repository.** Read: a `ReportRepository`/`ItemRepository` aggregation reusing `listLowStock` +
  the `reorder-policy` `shortfall` + a correlated preferred-`supplier_parts` join (the P61
  `preferredSupplierCostSql` pattern). Write:
  `PurchaseOrderRepository.createDraftFromReorderPlan(...)` inserting DRAFT POs + lines **through
  the existing insert paths** — never a second PO-creation path; status stays DRAFT
  (`derivePoStatus` authoritative).
* **UI.** A "Reorder / Shopping list" view (new route or Purchasing tab): grouped shortfall,
  editable order quantities, "Create draft PO" per supplier group; CSV export via the existing
  Export Wizard. Design tokens, British English, `<main id>` skip target.
* **Tests.** `reorder-plan` pure tests (grouping, MOQ rounding, no-supplier group); repository
  `:memory:` test that drafting creates the expected DRAFT PO + lines; smoke: drop an item below
  reorder point, open the list, draft a PO, assert it appears in DRAFT.
* **Deliverables checklist.**
  - [x] `reorder-plan.ts` pure seam + tests
  - [x] read aggregation (`listLowStock` + `shortfall` + preferred-supplier join)
  - [x] `PurchaseOrderRepository.createDraftFromReorderPlan` (reuses existing insert path) + `:memory:` test
  - [x] "Reorder / Shopping list" UI + CSV export (design tokens, British English, skip target)
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 2).** Shipped as specified. **No migration** — all reads are projections.
> Pure `src/features/purchasing/reorder-plan.ts` (`buildReorderPlan` + `computeOrderQty`/`roundUpToPack`)
> groups shortfall rows by preferred supplier (`orderQty = max(shortfall, MOQ)` rounded up to whole packs;
> no-supplier items → an "Unassigned" group; deterministic order, Unassigned last). `ReportRepository
> .listReorderShortfall` reuses `listLowStock`'s predicate (per-item `COALESCE` override, `MAX(…,1)`
> zero-floor, DISCRETE/active/non-variant-parent filters) + the preferred-`supplier_parts` correlated
> subquery (the P61 `preferredSupplierCostSql` pattern); `PurchaseOrderRepository
> .createDraftFromReorderPlan` creates one **DRAFT** PO per supplier group **through the existing
> `create` + `addLine` path** (no second PO-creation path; `derivePoStatus` authoritative; Unassigned
> skipped). UI is a "Reorder / Shopping list" tab on the existing `/purchase-orders` route (no new route
> file) with editable order quantities, per-group "Create draft PO", RFC-4180 CSV export, and an
> always-mounted result-count live region. **Code review: CLEAN with NITs.** Three NITs fixed pre-merge:
> the `ReorderTab` `isLoading` early-return was dropped so the WCAG 4.1.3 live region stays mounted
> across loading→loaded→empty (the spinner is now a branch beneath it); the tab strip is a
> `<div role="tablist">` not a `<nav>` whose landmark the role would suppress; a comment documents the
> case-folded supplier-key invariant. Two NITs **waived**: no arrow-key tab navigation (matches the
> existing `BackupDialog`/`ItemDetailDialog` tablists — not a regression); `useCreateDraftFromReorderPlan`
> does not invalidate the reorder plan (correct by design — drafting a PO does not lift stock, so the
> item legitimately stays below its reorder point). +~30 unit tests, +1 smoke step.

## Phase 66 — Asset lifecycle: purchase date, warranty, value/depreciation (v24)

* **Objective.** Let any item carry acquisition + warranty + simple value data (Snipe-IT-style
  asset facet). Additive and non-regressive (all NULL = today's behaviour).
* **Schema (migration `v24-item-asset-lifecycle`).** Additive nullable `items` columns:
  `acquired_at` (TEXT ISO date), `warranty_expires_at` (TEXT ISO date), `purchase_price` (REAL,
  CHECK >= 0), `depreciation_months` (INTEGER nullable, CHECK > 0). `items` already syncs → columns
  auto-join the LWW payload; **no** `SYNC_TABLES`/`FK_REFS` edit. `user_version` → 24.
* **Pure seam.** `src/features/inventory/asset-lifecycle.ts` — `warrantyStatus(item, now)` (active /
  expiring-soon / expired / none) and `currentValue(item, now)` (straight-line residual from
  `purchase_price` over `depreciation_months`, floored at 0; NULL term ⇒ no depreciation). Inject
  `now`; no DB.
* **Repository/UI.** Round-trip the fields through mappers/types/create/update; an "Asset" section on
  the item-detail editor (date pickers + price + term, each with an `InfoHint`); warranty status as a
  token-styled badge (`text-glyph-*` / `text-warning`; add a token only for a genuinely new semantic
  role, never hard-code). British English, design tokens only.
* **Tests.** `asset-lifecycle` pure tests (warranty boundaries, depreciation residual + floor); v24
  migration test (additive, CHECKs); mapper round-trip; smoke sets a warranty date and asserts the
  badge. (`build:extension` NOT re-run — no §9/extension edit.)
* **Deliverables checklist.**
  - [x] `v24-item-asset-lifecycle` migration + test; `user_version` → 24
  - [x] `asset-lifecycle.ts` pure seam (`warrantyStatus`/`currentValue`) + tests
  - [x] fields round-trip through mappers/types/create/update + `:memory:` test
  - [x] "Asset" item-detail section + token-styled warranty badge (design tokens, British English)
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 2).** Shipped as specified. Migration `v24-item-asset-lifecycle`
> (`user_version` → **24**; registry contiguous v1…v24, **strict-contiguity guard untouched**) adds four
> **additive nullable** `items` columns — `acquired_at` TEXT, `warranty_expires_at` TEXT, `purchase_price`
> REAL `CHECK (… IS NULL OR … >= 0)`, `depreciation_months` INTEGER `CHECK (… IS NULL OR … > 0)` — so every
> pre-v24 row reads NULL with zero backfill (today's behaviour). `items` already syncs ⇒ **no
> `SYNC_TABLES`/`FK_REFS` edit** (additive non-FK columns auto-join the LWW payload). Pure
> `src/features/inventory/asset-lifecycle.ts`: `warrantyStatus(item, now)` (active / expiring-soon within
> `WARRANTY_EXPIRING_SOON_DAYS = 30` / expired / none) and `currentValue(item, now)` (straight-line residual
> over `depreciation_months` from `acquired_at`, floored at 0; null term ⇒ flat; null price ⇒ null) — `now`
> injected, no clock inside. The four fields round-trip through `types/items.ts` / `mappers.ts` /
> create+update (the `update()` `if (input.X !== undefined)` guards distinguish SET vs leave-unchanged vs
> clear-to-null); `buildInsert` column/placeholder/param counts verified aligned (28/28/28). UI: an "Asset
> details" section on the item-detail **Lifecycle** tab (date pickers + price + term, each with an
> `InfoHint`) + a token-styled warranty badge (`text-success`/`text-warning`/`text-destructive` — **no new
> token needed**). **Code review: CLEAN with NITs.** One NIT fixed pre-merge: a hardcoded `£0` in the
> depreciation-term hint → currency-agnostic "zero" (the app is multi-currency; the rendered book value
> formats via `fmt.currency`). +~29 unit tests (incl. the v24 migration test), +1 smoke step.
> `build:extension` NOT re-run (no §9/extension edit).

## Phase 67 — Bulk CSV catalog import/export (no migration)

* **Objective.** Whole-catalog spreadsheet onboarding — import many items from CSV (today only
  `bom-import.ts` exists). Removes the biggest first-run friction.
* **Pure seam.** `src/features/inventory/catalog-import.ts` — parse CSV (reuse the RFC-4180-safe
  codec the Export Wizard already uses; NO new dependency), a column-mapping model (CSV header →
  item field), and per-row Zod validation producing a dry-run plan `{ create[], update[], errors[] }`
  (match existing items by a chosen key). Unit-tested.
* **Repository/UI.** A guarded batch apply through the existing `ItemRepository` create/update paths
  (respect the §7.6 storage Hard Stop on growth; one transaction or chunked). An import wizard:
  upload → map columns → preview (counts + per-row errors, accessible `role="alert"`) → apply.
  Export reuses the Export Wizard (catalog CSV). Design tokens, British English, skip target.
* **Tests.** `catalog-import` pure tests (mapping, coercion, dup-key + malformed-row errors, dry-run
  partition); repository `:memory:` batch-apply test; smoke imports a tiny CSV and asserts the new
  items appear.
* **Deliverables checklist.**
  - [x] `catalog-import.ts` pure seam (parse + column map + Zod dry-run plan) + tests
  - [x] guarded batch apply through existing `ItemRepository` paths + `:memory:` test
  - [x] import wizard (upload → map → preview → apply) + Export Wizard catalog export
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 2).** Shipped as specified. **No migration.** Pure
> `src/features/inventory/catalog-import.ts` reuses the existing RFC-4180 `parseCsv` codec (from
> `features/projects/bom-import.ts` — **no new dependency**), a header→field column-mapping model
> (`inferColumnMapping` over `HEADER_SYNONYMS`), and per-row Zod validation producing a dry-run plan
> `{ create[], update[], errors[] }` (match by a chosen key — `name`/`sku`; matched→update, unmatched→
> create, invalid→collected error, never thrown; intra-CSV duplicate keys flagged). `applyCatalogImportPlan`
> goes **through the existing `ItemRepository.create`/`update` only** (no new column SQL / no second path —
> kept clear of the Phase-66 asset-column edits), honouring the §7.6 storage Hard Stop (`assertWritable` →
> a suspended write is recorded as `skipped`, not lost). UI: a four-step Foundry `Modal` wizard
> (upload → map columns → preview with create/update counts + a `role="alert"` per-row error list → apply)
> launched from the Inventory screen (no new route file); the export side adds a round-trip-ready
> **Catalogue CSV** format to the existing Export Wizard (`buildCatalogCsv` headers align with the import
> synonyms). **Code review: CLEAN with NITs.** One SHOULD + one NIT fixed pre-merge: the `CATALOG_CSV`
> export branch now short-circuits **before** the shared `collectItems()` (was fetching the whole list
> twice); `UploadStep` now awaits `onFileLoaded` so a rejection while loading the existing catalogue
> surfaces in the upload-step error region instead of vanishing; plus a British-English comment fix. Two
> cosmetic NITs **waived**: four suppressed (`void`) dead props on `PreviewStep`; the guarded `data.name!`
> non-null assertion in `toCreateInput` (the plan builder pre-checks it). +38 unit tests, +1 smoke step.

## Phase 68 — Alert centre (Wave 3, after 66; no migration)

* **Objective.** One consolidated proactive alerts feed: low-stock (P59 `listLowStock`), expiry
  (`expiry.ts`), maintenance-due (`MaintenanceRepository`), and warranty-due (P66 `asset-lifecycle`).
  In-app only — web push needs a server (backend-less); note push as a Backlog trigger, do **not**
  build it.
* **Pure seam.** `src/features/<area>/alerts.ts` — fold the four sources into a typed, sorted
  `Alert[]` (severity + due date + deep-link target), plus a pure dismissal/grouping helper. Inject
  `now`; unit-tested.
* **State/UI.** Dismissals **device-local** via a Zustand persist store (mirror the P48
  saved-searches pattern) — NO migration, no synced table. New `/alerts` route + nav entry with an
  unread-count badge + `<main id="main-content" tabIndex={-1}>` skip target + an `aria-live`
  announcement of the count (reuse the `<LiveRegion>` seam). Token-styled severity badges. British
  English.
* **Tests.** `alerts` pure tests (each source lane + severity ordering + warranty lane gated on P66
  fields + dismissal); smoke triggers a low-stock alert, asserts it lists, then dismisses it.
* **Deliverables checklist.**
  - [x] `alerts.ts` pure seam (four lanes + severity sort + dismissal/grouping) + tests
  - [x] device-local Zustand persist dismissal store (no migration)
  - [x] `/alerts` route + nav badge + skip target + `aria-live` count (reuse `<LiveRegion>`)
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 3 — final).** Shipped as specified. **No migration** (`user_version` stays
> **24**). Pure `src/features/alerts/alerts.ts` (`buildAlerts(sources, now)` + `applyDismissals` +
> `groupByKind`, `now` injected) folds four already-fetched source arrays into one typed `Alert[]` — kinds
> `low-stock` / `expiry` / `maintenance-due` / `warranty-due`, severity `info|warning|critical`
> (expired/overdue → critical, expiring-soon/low → warning), sorted by severity then soonest `dueAt` then
> id. The four lanes compose existing seams: `listLowStock` (P59), `listExpiringWithin`/`expiryStatus`,
> `MaintenanceRepository.listDue`, and the **Phase-66** `warrantyStatus` over `warranty_expires_at` via a
> new additive `ItemRepository.listWarrantyExpiring` feed (the warranty lane is strictly gated — no
> `warrantyExpiresAt` ⇒ no alert). Dismissals persist **device-local** via a Zustand `persist` store
> (`useDismissedAlertsStore`, mirroring `useSavedSearchesStore`; `Set ↔ string[]` round-trip) — **no
> migration, no synced table**. UI: a new `/alerts` route (file-based, `routeTree.gen.ts` regenerated) +
> a Dashboard nav entry with an undismissed-count badge + `<main id={MAIN_CONTENT_ID}>` skip target + an
> always-mounted `<LiveRegion>` announcing the count; token-styled severity badges (`bg-destructive/10
> text-destructive` / `bg-warning/10 text-warning-foreground` — **no new token**). Web push **deferred to
> Backlog** (backend-less PWA; trigger = a companion backend) in `docs/dev/deferred-features.md`. **Code
> review: CLEAN with NITs.** One SHOULD + one NIT fixed pre-merge: `buildMaintenanceDueAlerts` now takes
> the injected `now` instead of `Date.now()` inside the pure seam (restoring the no-clock contract +
> making the not-yet-overdue branch testable); `listWarrantyExpiring` gained the variant-parent exclusion
> for consistency with `listLowStock`. One NIT **waived**: the `Link to={… as any}` typing suppression in
> `AlertsScreen` (no runtime risk — all current targets are `/inventory`). +36 unit tests, +1 smoke step.
> `build:extension` NOT re-run (no §9/extension edit).

## Deferred / explicitly out of scope

- Multi-user accounts, roles, per-user audit attribution — contradicts single-user local-first.
- Multi-currency purchasing / FX conversion — single base currency locked.
- AI demand forecasting, omnichannel/POS, RFID, accounting integration, generic REST/webhook API
  beyond the HA bridge — enterprise-only; not pursued.
- **Web push for the alert centre** — needs a server; backend-less PWA → Backlog trigger only.
- **Category custom-field templates**, **advanced analytics (ABC / turnover / aging)**, **label
  customisation (multi-symbology / templates / location labels)** — confirmed in-scope audit
  candidates, parked for a possible later wave; not in 65–68.

## Plan complete — no continuation

**The inventory-breadth plan (Phases 65–68) is COMPLETE**, on top of the carried Phase 64 (aria-live
Tier B). All are merged to `main`:

| Phase | Shipped | Migration | `user_version` |
| --- | --- | --- | --- |
| 64 — aria-live Tier B | result-count live regions (Projects/Contacts/PO master) | none | 23 |
| 65 — Procurement automation | `reorder-plan.ts` + `listReorderShortfall` + `createDraftFromReorderPlan` + Reorder tab | none | 23 |
| 66 — Asset lifecycle | `asset-lifecycle.ts` (`warrantyStatus`/`currentValue`) + Asset section | `v24-item-asset-lifecycle` | **24** |
| 67 — Bulk CSV import | `catalog-import.ts` + import wizard + Export Wizard catalogue CSV | none | 24 |
| 68 — Alert centre | `alerts.ts` (four lanes) + `/alerts` + device-local dismissals | none | 24 |

Final state: `user_version = 24`, the migration registry is contiguous v1…v24 (strict-contiguity guard
intact), **1626/1626 unit tests pass across 157 files**, `npx tsc -p tsconfig.app.json --noEmit` clean,
`npm run build` clean (precache **3230.27 KiB**, no budget), and the browser smoke gained one step per
phase (five total). Every phase passed its mandatory pre-merge code-review gate (all **CLEAN with
NITs**); every waived finding is recorded in the per-phase Outcome notes above. `build:extension` was
not re-run in any phase (no §9 / `extension/` edit).

**There is no Wave 4 and no further kick-off prompt.** Future inventory work starts a fresh plan
document. The second feature-gap audit's remaining in-scope candidates (category custom-field templates,
advanced analytics / ABC / turnover / aging, label customisation) are parked in *Deferred / out of
scope* above and in `docs/dev/deferred-features.md` for a possible later wave.
