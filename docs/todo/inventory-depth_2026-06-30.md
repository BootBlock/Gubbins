# Inventory-depth phases (59–62) — competitor-gap closure (2026-06-30)

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

A 2026-06-30 feature audit benchmarked Gubbins against the direct competitors (InvenTree,
PartKeepr) and the home/SMB tools (Sortly) and enterprise suites (NetSuite, Cin7, Fishbowl).
Gubbins already meets or beats them on scanning, batch/lot traceability, cycle counting,
consumable gauges, BOM, variants and sync. Four expectations that *every* direct competitor
ships and Gubbins lacks were identified, in priority order:

1. **Per-item reorder point** — Gubbins has only one global low-stock threshold
   (`ItemRepository.listLowStock`); PartKeepr/InvenTree/Sortly all carry a per-part minimum.
2. **Supplier-parts** — Gubbins stores one MPN/manufacturer/`unitCost` + alias strings; the
   competitors model N suppliers per part, each with its own order code and price breaks (and
   the scraper already *fetches* per-supplier pricing it cannot fully store).
3. **Reporting / valuation** — Gubbins has dashboard widgets + a per-item ledger but no
   aggregate inventory-value / consumption / movement report; every competitor ships these.
4. **Formal Purchase Orders** — procurement today is BOM-line `Ordered → In-Transit → partial
   receipt`; there is no supplier-keyed PO document spanning multiple items.

Everything else absent (multi-user/roles, multi-currency, AI forecasting, omnichannel/POS,
RFID, accounting integration) is deliberately out of scope for a local-first, single-user,
hobbyist-premium PWA and is **not** chased here.

## Execution model — worktrees, sub-agents, code-review gates

These phases obey the standing protocols (§8): strict phasing, autonomous TDD (§8.2),
`:memory:` unit tests + a real-browser smoke (§8.5), derive-don't-store seams, pure `.ts`
logic split out of glue, **British English**, **design tokens only** (CLAUDE.md), and a
PHASE_HANDOVER per phase (§8.1). On top of that, this plan is **parallelised**:

- **One git worktree per phase.** Create with
  `git worktree add ../gubbins-p59 -b phase/59-reorder-points` (etc.). Each phase is
  implemented by a dedicated **implementation sub-agent** (`Agent`, `isolation: "worktree"`),
  so concurrent phases never share a working tree.
- **Code-review gate after every phase (mandatory).** When an implementation sub-agent
  reports done, run a **review sub-agent** (or `/code-review high`) against *that worktree's
  diff* **before merge**. Findings must be fixed (or explicitly waived in the Outcome note).
  No phase merges to `main` un-reviewed. This is the user's hard requirement.
- **Merge discipline.** Merge a reviewed phase to `main`, then `git worktree remove` it. Later
  waves branch from the updated `main` so they inherit earlier schema changes.

### Migration-version allocation (collision-avoidance)

Schema-touching phases run in parallel, so their `user_version` numbers are **pre-allocated**
to prevent two worktrees both claiming the next integer. Each agent appends *only* its own
migration and registers it in `src/db/migrations/index.ts`; the only merge-time conflicts are
trivial array-append clashes in `index.ts`, `SYNC_TABLES`
(`src/db/repositories/tombstone.ts`), the `FK_REFS` table (`src/features/sync/reconcile.ts`)
and the repository barrel (`src/db/repositories/index.ts`) — resolve by keeping both lines in
ascending order.

| Phase | Migration | `user_version` after |
| --- | --- | --- |
| 59 — Reorder points | `v21-item-reorder-point` | 21 |
| 60 — Supplier-parts | `v22-supplier-parts` | 22 |
| 61 — Reporting/valuation | **none** (read-only aggregates) | unchanged |
| 62 — Purchase Orders | `v23-purchase-orders` | 23 |

### Dependency graph & waves

```
Wave 1 (parallel):   59 (v21)      60 (v22)      61 (no migration)
                        \             |
                         \            v
Wave 2 (after 60):                   62 (v23, needs suppliers)
```

- **59 ⟂ 61 ⟂ 60** — independent feature surfaces; safe to run all three concurrently given the
  pre-allocated versions above. (61 touches no schema at all, so it is the cleanest.)
- **62 depends on 60** — a PO line links to a `supplier_part`. 62's worktree must branch from a
  `main` that already contains the merged Phase 60.

So: launch **Wave 1 = {59, 60, 61}** in three parallel worktrees; review + merge each; then
launch **Wave 2 = {62}** alone. Code review after *every* phase regardless of wave.

---

## Phase 59 — Per-item reorder points (v21)

* **Objective.** Let any DISCRETE / CONSUMABLE_GAUGE item carry its **own** low-stock trigger,
  falling back to the global default when unset. Close the single biggest competitor gap with
  the smallest additive change.
* **Schema (migration `v21-item-reorder-point`).** Additive nullable columns on `items`:
  `reorder_point` (INTEGER — discrete qty floor) and `reorder_gauge_percent` (REAL — gauge %),
  plus optional `reorder_qty` (INTEGER — suggested top-up amount for the shopping list). NULL =
  "use the global default" (never a regression). `items` is already in `SYNC_TABLES`, so the
  columns auto-join the LWW payload — **no** `SYNC_TABLES`/`FK_REFS` edit needed.
* **Pure seam.** `src/features/inventory/reorder-policy.ts` — `isLow(item, defaults)` and
  `shortfall(item, defaults)` (how many to reorder), unit-tested, no DB/clock. Mirrors the
  `cycle-count.ts` / `list-window.ts` extract-the-logic seam.
* **Repository.** Rework `ItemRepository.listLowStock` so the SQL honours
  `COALESCE(reorder_point, :defaultQty)` / `COALESCE(reorder_gauge_percent, :defaultPct)` per
  row; keep the existing global thresholds as the fallback. Add `reorderShortfall` projection
  if the shopping-list view wants it.
* **UI.** A "Reorder point" field on the item-detail editor (with an `InfoHint`); the existing
  Settings global low-stock controls become the *default* and say so. The Low Stock dashboard
  widget needs no change (it consumes `listLowStock`). Optionally surface "reorder N" on the
  Low Stock list using `shortfall`.
* **Tests.** `reorder-policy` unit tests; `listLowStock` per-item-override `:memory:` tests;
  extend the inventory smoke to set a per-item reorder point and assert the widget reacts.
* **Deliverables checklist.**
  - [x] `v21` migration + test; `user_version` → 21
  - [x] `reorder-policy.ts` pure seam + tests
  - [x] `listLowStock` honours per-item override
  - [x] item-detail field + Settings "default" relabel (design tokens, British English)
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 1).** Shipped as specified. Additive nullable `items` columns
> `reorder_point`/`reorder_gauge_percent`/`reorder_qty` via `v21-item-reorder-point`
> (`user_version` → 21, registry contiguous); no `SYNC_TABLES`/`FK_REFS` edit needed (`items`
> already syncs; columns are additive non-FK). Pure `src/features/inventory/reorder-policy.ts`
> (`isLow`/`shortfall`) unit-tested; `ItemRepository.listLowStock` now `COALESCE`s the per-row
> override over the global default (with a `MAX(…,1)` zero-floor guard); the new fields
> round-trip through the mapper/types/create/update; item-detail "Reorder point" field (with
> `InfoHint`) + Settings "default" relabel + a "reorder N" surfacing on the Low Stock widget.
> **Code review: clean — no blockers** (two cosmetic NITs **waived**: a curly-vs-straight
> apostrophe in the InfoHint copy, and `shortfall` returning 0 for gauges by design). Merged to
> `main` (`1c522c6`); `npm run test:run` green afterwards. +26 unit tests, +1 smoke step.

## Phase 60 — Supplier-parts (v22)

* **Objective.** Model **N suppliers per item**, each with an order code, unit cost, pack/MOQ
  and optional quantity price-breaks; mark one **preferred**. Upgrades the alias-only supplier
  facet and gives the scraper somewhere to persist the per-supplier pricing it already fetches.
* **Schema (migration `v22-supplier-parts`).** New synced table `supplier_parts`:
  `id` (UUIDv4), `item_id` (FK → items, ON DELETE CASCADE), `supplier_name`, `order_code`,
  `unit_cost` (REAL, nullable), `currency` (TEXT, nullable — defaults to base), `pack_qty`
  (INTEGER, nullable), `min_order_qty` (INTEGER, nullable), `price_breaks` (TEXT JSON, nullable
  — `[{qty,unitCost}]`), `url` (nullable), `is_preferred` (INTEGER 0/1), `updated_at`. Add to
  `SYNC_TABLES` **after `items`** (dependency-safe order) and a `FK_REFS` entry
  (`item_id → items`). Keep `item_aliases` as the scan-resolution layer; a supplier-part may
  reference an alias's order code but aliases are not removed.
* **Repository.** New `SupplierPartRepository` (CRUD + `listForItem` + `setPreferred` single-
  winner). The preferred supplier-part's `unit_cost` may feed item valuation; keep `items.unitCost`
  as the manual override and document precedence (manual `unitCost` wins; else preferred
  supplier cost) via a pure helper so Phase 61 can reuse it.
* **Scraper.** On an applied scrape, offer to persist the fetched `scraped_pricing` as/into a
  `supplier_part` (respecting §4 no-overwrite — never clobber an existing supplier row without
  explicit opt-in). **§9 wire schema unchanged** ⇒ `build:extension` only if `extension/` is
  actually touched (it should not be).
* **UI.** Replace the read-only supplier `<dl>` in `SupplierDataEditor.tsx` with an editable
  supplier-parts table (add/edit/remove rows, star the preferred, show price-breaks). Design
  tokens only.
* **Tests.** Repository `:memory:` tests (CRUD, single-preferred invariant, cost precedence);
  sync round-trip test that `supplier_parts` reconciles by LWW; smoke that adds a supplier row.
* **Deliverables checklist.**
  - [x] `v22` migration + test; `user_version` → 22; `SYNC_TABLES` + `FK_REFS` entries
  - [x] `SupplierPartRepository` + cost-precedence pure helper + tests
  - [x] editable supplier-parts UI; scraper persists pricing (opt-in, no-overwrite)
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 1).** Shipped as specified. New synced `supplier_parts` table
> (UUID PK, `item_id` FK→items ON DELETE CASCADE, the standard §7.1 auto-stamp trigger, STRICT
> + sane CHECKs) via `v22-supplier-parts` (`user_version` → 22); added to `SYNC_TABLES`
> immediately after `items` and `FK_REFS` (`item_id→items`, non-nullable → orphan-drop matching
> CASCADE), with a two-device LWW + orphan-drop round-trip test. `SupplierPartRepository`
> (CRUD + `listForItem` + atomic single-winner `setPreferred`); pure `supplier-cost.ts`
> `effectiveUnitCost` (manual `unitCost` wins, else preferred supplier cost) for Phase 61 reuse;
> pure `supplier-part-plan.ts` enforces §4 **no-overwrite** (never clobbers an existing supplier
> field without explicit opt-in); editable supplier-parts table replaces the read-only `<dl>`;
> the scraper offers to persist fetched pricing. **Code review: clean — no blockers.**
> **Orchestrator integration note (recorded, not a waiver):** the implementation worktree, run
> in parallel before Phase 59 merged, legitimately lacked `v21`, so the agent relaxed the
> migration engine's strict-contiguity guard to ascending-unique to boot. On merge the registry
> is contiguous again (v20→v21→v22), so the orchestrator **restored the strict-contiguity guard**
> (preserving fast-fail detection of a forgotten/misnumbered migration) in commit `730e93e`.
> Same commit fixed a review **[SHOULD]**: a non-integer pack/MOQ or negative unit cost typed
> into the supplier form hit the repository CHECK and threw with no UI feedback — the form now
> validates on submit and shows an accessible `role="alert"`. Two NITs **waived** (a redundant
> `getById` round-trip in `update`; no explicit malformed-`price_breaks`-JSON repository test —
> the mapper is already defensively covered). Merged to `main` (`0238521` + `730e93e`);
> `npm run test:run` green. +~40 unit tests, +1 smoke step.

## Phase 61 — Reporting & valuation (no migration)

* **Objective.** A first-class **Reports** screen: total inventory value (with breakdown),
  consumption rate, stock movement over time, low-stock & dead-stock rollups — all from data
  already stored. **No schema change** (`user_version` unchanged).
* **Repository.** New read-only `ReportRepository` aggregations:
  `inventoryValue()` (`SUM(quantity * effectiveUnitCost)` overall + grouped by category and by
  location), `consumptionRate(window)` (from `item_history` negative deltas), `movement(window)`
  (ins/outs over time buckets), `lowStockCount()`, `deadStock(sinceDays)` (no movement in N
  days). Pure aggregation/bucketing logic lives in `src/features/reports/*.ts`, unit-tested with
  `:memory:` fixtures. Honour the Phase-60 cost-precedence helper if merged; otherwise
  `items.unitCost`.
* **Routing/UI.** New `/reports` route + nav entry + per-screen `<main id="main-content">` skip
  target (matches the Phase-40 a11y convention). Headline value cards + simple token-styled bar/
  line visualisations (no new chart dependency — compose with Tailwind/SVG per the §2.4 native-
  preference rule). Export each report via the existing **Export Wizard** (CSV), reusing its
  remembered-settings behaviour (§3).
* **Tests.** Pure aggregation unit tests (valuation grouping, consumption windows, dead-stock
  boundary); a smoke that opens `/reports` and asserts a non-zero total renders.
* **Deliverables checklist.**
  - [x] `ReportRepository` + pure `features/reports` seams + tests
  - [x] `/reports` route, nav entry, skip target, token-only visuals
  - [x] CSV export via the Export Wizard
  - [x] code review passed; PHASE_HANDOVER updated; Outcome note appended

> **Outcome (2026-06-30, Wave 1).** Shipped as specified. **No schema migration** —
> `user_version` unchanged. New read-only `ReportRepository` (`inventoryValue` overall + by
> category + by location, `consumptionRate`, `movement`, `lowStockCount`, `deadStock`) with all
> aggregation/bucketing in pure `src/features/reports/*.ts` (`:memory:`-fixture unit tests).
> Cost lookups funnel through one internal `effectiveUnitCost` seam using `items.unitCost`
> today (Phase 60 ran in parallel, so its preferred-supplier helper is not wired here — the seam
> is the single swap-point for a later phase to adopt it). New `/reports` route + nav entries +
> `<main id="main-content" tabIndex={-1}>` skip target (Phase-40 convention); headline value
> cards + token-styled Tailwind/SVG bar/line visuals (**no new chart dependency**); CSV export
> routed through the existing Export Wizard's remembered-settings path (RFC-4180 safe).
> **Code review: clean — no blockers** (two NITs **waived**: add the explicit
> `notAVariantParent` predicate to the per-location valuation query for visible consistency — it
> is already correct via the `item_stock`/`quantity>0` SSOT invariant; a one-line comment noting
> the `consumptionRate` per-row delta assumption). Merged to `main` (`145de0f`);
> `npm run test:run` + `npm run build` green afterwards. +~25 unit tests, +1 smoke step.
>
> **Carried flag (pre-existing, unrelated to Wave 1):** the Phase-61 agent reported the
> §4 multi-level variants smoke step *"nests a sub-variant beneath a variant (Phase 18)"*
> failing on its baseline `main` (a `locator.waitFor` timeout in the variants path, untouched by
> any Wave-1 diff). Flagged for investigation; **not** a Wave-1 regression. Re-run the smoke once
> (the documented "adds a weighted capability" `press('Enter')` flake remains).

## Phase 62 — Formal Purchase Orders (v23) — depends on Phase 60

* **Objective.** A supplier-keyed **PO document** with multiple lines that **receives into the
  existing per-location/batch stock machinery**, distinguishing committed-on-order from on-hand.
* **Schema (migration `v23-purchase-orders`).** Two new synced tables:
  - `purchase_orders`: `id`, `supplier_name` (or `supplier_part`-derived), `reference`,
    `status` (TEXT enum `DRAFT|ORDERED|PARTIAL|RECEIVED|CANCELLED`), `currency`, `created_at`,
    `ordered_at` (nullable), `updated_at`.
  - `purchase_order_lines`: `id`, `po_id` (FK → purchase_orders, CASCADE), `item_id` (FK →
    items, nullable), `supplier_part_id` (FK → supplier_parts, nullable — the Phase-60 link),
    `description`, `ordered_qty`, `received_qty` (accumulates, mirroring v12 `received_qty`),
    `unit_cost`, `updated_at`.
  Add both to `SYNC_TABLES` (`purchase_orders` before `purchase_order_lines`, both after
  `supplier_parts`/`items`) and the matching `FK_REFS` entries; a removed supplier-part nulls
  the line's `supplier_part_id` (don't block the delete).
* **Derive-don't-store.** `status` between ORDERED/PARTIAL/RECEIVED is **derived** from
  `SUM(received_qty)` vs `SUM(ordered_qty)` via a pure `po-status.ts`; only DRAFT/CANCELLED are
  user-set persisted states. Receiving reuses the Phase-24 `planReceipt` / `ProjectRepository.receiveLine`
  seam (and Phase-28 batch landing) — a new pure `planPoReceipt` wraps it; **never** hand-roll a
  second stock-mutation path. On-order qty surfaces as a derived per-item projection like the
  Phase-20 In-Transit one.
* **UI.** PO list + detail (lines, statuses) + a receive flow (per-line, partial allowed,
  optional destination location/batch). Token-styled; British English.
* **Tests.** `po-status` + `planPoReceipt` pure tests; `PurchaseOrderRepository` `:memory:`
  receive-into-stock tests (partial → PARTIAL, full → RECEIVED); sync round-trip; smoke that
  creates a PO, receives a line, and asserts on-hand rose.
* **Deliverables checklist.**
  - [ ] `v23` migration + test; `user_version` → 23; `SYNC_TABLES` + `FK_REFS` entries
  - [ ] `po-status.ts` + `planPoReceipt` pure seams + tests
  - [ ] `PurchaseOrderRepository` reusing the existing receipt machinery
  - [ ] PO list/detail/receive UI
  - [ ] code review passed; PHASE_HANDOVER updated; Outcome note appended

## Deferred / explicitly out of scope

- Multi-user accounts, roles, per-user audit attribution — contradicts single-user local-first.
- Multi-currency purchasing / FX conversion — spec locks a single base currency (`supplier_parts.currency`
  is stored for fidelity but not converted).
- AI demand forecasting, omnichannel/POS, RFID, accounting (QuickBooks) integration, generic
  REST/webhook API beyond the existing HA bridge — enterprise-only; not pursued.

## Continuation prompt

_(Replaced as each wave completes — keep identical to the raw block emitted in chat.)_

**Wave 1 = {59, 60, 61} is complete and merged to `main`** (`user_version` → 22; reorder points
v21, supplier-parts v22, Reports screen). The current kick-off prompt launches **Wave 2 = {62}**,
the final wave:

```text
You are the ORCHESTRATOR for Wave 2 (the final wave) of the inventory-depth plan
(docs/todo/inventory-depth_2026-06-30.md). Wave 1 (Phases 59–61) is already merged to main:
per-item reorder points (v21), supplier-parts (v22, with SupplierPartRepository + the pure
supplier-cost.ts `effectiveUnitCost` helper), and the read-only Reports screen. user_version is
now 22, the migration registry is contiguous, and the strict-contiguity guard has been restored.

Read docs/todo/inventory-depth_2026-06-30.md in full (especially the Phase 62 section and the
Wave-1 Outcome notes), the Master Specification at docs/todo/done/_specification.md, and the
latest docs/dev/PHASE_HANDOVER.md before writing any code. You are the orchestrator — do NOT
implement the phase yourself in the main tree.

Launch Wave 2 = Phase 62 — Formal Purchase Orders in ONE git worktree, implemented by a dedicated
sub-agent with isolation: "worktree":
  - Migration v23-purchase-orders (user_version → 23): two new synced tables purchase_orders +
    purchase_order_lines (a line links to a Phase-60 supplier_part via supplier_part_id).
  - Append (never renumber) the migration in src/db/migrations/index.ts; register BOTH tables in
    SYNC_TABLES (src/db/repositories/tombstone.ts) — purchase_orders before purchase_order_lines,
    both after supplier_parts/items — and add the matching FK_REFS entries
    (src/features/sync/reconcile.ts). A removed supplier-part NULLs the line's supplier_part_id
    (nullable FK — don't block the delete); a removed item likewise.
  - Derive-don't-store: ORDERED/PARTIAL/RECEIVED status is derived from SUM(received_qty) vs
    SUM(ordered_qty) via a pure po-status.ts; only DRAFT/CANCELLED are persisted user states. A
    pure planPoReceipt wraps the existing Phase-24 planReceipt / ProjectRepository.receiveLine
    (and Phase-28 batch landing) — never hand-roll a second stock-mutation path. On-order qty is
    a derived per-item projection like the Phase-20 In-Transit one.
  - PO list + detail + receive flow UI (per-line, partial allowed, optional destination
    location/batch); design tokens only, British English.

Give the sub-agent the Phase 62 spec section and the binding conventions (§8 protocols, :memory:
unit tests + a real-browser smoke per §8.5, pure-.ts-seam split, derive-don't-store, British
English, design tokens only per CLAUDE.md, no secrets). It must use migration version v23
exactly, run `npm install` first (worktrees don't share node_modules), launch its dev server on a
free port (pass SMOKE_BASE), verify four ways (type-check exit code, test:run, build, e2e), and
commit its work on the worktree branch. Tests: po-status + planPoReceipt pure tests;
PurchaseOrderRepository :memory: receive-into-stock tests (partial → PARTIAL, full → RECEIVED);
a sync round-trip; a smoke that creates a PO, receives a line, and asserts on-hand rose.

After the sub-agent reports done, you MUST run a code-review pass on that worktree's diff (a
review sub-agent or /code-review high) BEFORE merging. Fix all findings (or record an explicit
waiver in the Outcome note). Only then merge the branch to main, resolving the trivial
array-append conflicts in index.ts / SYNC_TABLES / FK_REFS / the repository barrel, and remove the
worktree. Run `npm run test:run` green after the merge.

When Phase 62 is merged and reviewed: append an Outcome note under Phase 62 in the doc, update
docs/dev/PHASE_HANDOVER.md, and record that the inventory-depth plan (Phases 59–62) is COMPLETE —
there is no Wave 3, so end with a brief completion note rather than a further kick-off prompt.
Known carried flag to verify and close out: a pre-existing §4 multi-level variants smoke step
("nests a sub-variant beneath a variant", Phase 18) was already failing on main before Wave 2 and
is unrelated to it.
```
