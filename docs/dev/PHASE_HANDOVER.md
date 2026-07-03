# PHASE_HANDOVER.md — Phase 82 (Unlimited-supply items) — ✅ COMPLETE

**Project:** Gubbins — local-first inventory-tracking PWA
**Phase completed:** **Phase 82 — Unlimited-supply items.** Adds support for an item whose supply is
effectively infinite (tap water, mains air/electricity, a bulk sand pile). Modelled as a **boolean
`items.is_unlimited` modifier on a DISCRETE item** — **not** a fifth `TrackingMode` — because
"unlimited" is orthogonal to how you track and only combines sensibly with DISCRETE. Two DB CHECKs
enforce it: `is_unlimited IN (0,1)` and `is_unlimited = 0 OR tracking_mode = 'DISCRETE'`. Additive
synced column on the already-synced `items` table → **no** `SYNC_TABLES`/`FK_REFS` edit (LWW auto);
per the squashed-baseline convention it **edits `v1-initial`** and regenerates the snapshot rather than
adding a forward migration — `user_version` stays **1**.
**Date:** 2026-07-03
**Status:** ✅ **Implemented in an isolated worktree; NOT merged (awaiting the orchestrator's code-review
gate — the in-worktree /code-review gate was run and its one finding fixed).**
`npx tsc -p tsconfig.app.json --noEmit` **clean**; `npx tsc -b --noEmit` **clean**; `npm run build`
**clean** (precache 60 entries / 3487.11 KiB). **App unit tests 2082 pass** (+11 over 2071: new
`unlimited.test.ts`, `unlimited-integration.test.ts`, and cases in reorder-policy / migration /
catalog-import / export-data). **Bridge tests 279 pass** (+1 new `bridge/src/api/dto.test.ts`). The 4
"failed files" seen only under the throwaway worktree Vitest config are the known `virtual:pwa-register`
resolution limit (VitePWA omitted) — they pass under the real config; **re-run the suite from the primary
checkout after merge to confirm.** No dependency change.

### Semantics of `is_unlimited = 1` (DISCRETE only)
- **Quantity** renders **∞** (the stored integer is ignored); no ± stepper.
- **Low-stock / reorder:** never low, never on the shopping list (shortfall always 0).
- **BOM / assembly:** always satisfiable — never a project shortfall; consumption logs `CONSUMED` but is a
  ledger no-op and (crucially) **does not soft-delete** the item — an infinite source survives the build.
- **Valuation / dead-stock / cycle-count / checkout:** excluded (checkout blocked like the UNTRACKED guard).
- **Toggling the flag** is a plain LWW `update` — no new `HISTORY_ACTION`, lossless (never rewrites quantity).

### What changed (files)
- **`src/db/migrations/v1-initial.ts`** — `items` CREATE TABLE gains `is_unlimited INTEGER NOT NULL DEFAULT 0`
  + the two CHECKs. **`__fixtures__/schema-baseline.snapshot.json`** regenerated; **`v1-initial.test.ts`**
  +1 case (DISCRETE+unlimited admitted; SERIALISED/UNTRACKED+unlimited rejected by the CHECK).
- **`src/features/inventory/unlimited.ts`** *(new)* + **`unlimited.test.ts`** *(new)* — the pure SSOT:
  `UNLIMITED_GLYPH` (`'∞'`), `isUnlimited`, `canSupply`, `consumptionLedgerDelta` (0 for unlimited, else `-qty`),
  `formatQuantityDisplay`.
- **`src/features/inventory/reorder-policy.ts`** (+ test) — `isUnlimited` added to `ReorderItem`; `isLow`
  returns false / `shortfall` returns 0 for an unlimited item (early return alongside SERIALISED/UNTRACKED).
- **types / mapper / create / update** — `Item.isUnlimited` (+ `ItemRow.is_unlimited`, `CreateItemInput`,
  `UpdateItemInput`); `rowToItem` maps it; `resolveCreate`/`buildInsert` persist it (DISCRETE-only guard);
  `ItemCoreRepository.update` handles it (DISCRETE-only guard; plain LWW, no history action).
- **glue** — `listLowStock` (+ `lowStockCount`, `listReorderShortfall`) add `is_unlimited = 0`; `getShoppingList`
  shortfall query adds `COALESCE(i.is_unlimited,0) = 0`; `ReportRepository.inventoryValue` (both groupings) +
  `deadStock` add a `notUnlimited()` guard; `CheckoutRepository.checkout` blocks unlimited; the cycle-count
  sheet reads (`listStockAtLocation` / `listStockBatchesAtLocation`) add `i.is_unlimited = 0`;
  `finaliseAssembly` consume path skips the soft-delete for unlimited parts (still logs `CONSUMED`);
  `clone.ts planItemClone` carries the flag.
- **UI (Foundry primitives + tokens, British English)** — a DISCRETE-gated **"Unlimited supply"** toggle with
  an `InfoHint` on Create (`CreateItemDialog`, inside the DISCRETE block) and Edit (`ItemDetailsEditor`);
  `ItemRow`/`ItemCard` render a `text-glyph-scan`-tinted **∞** (accessible label "Unlimited supply") as the
  **first** branch of the quantity ladder, no stepper; a small **∞ `UnlimitedBadge`** next to `TrackingBadge`;
  new `InfinityIcon` in the icon registry.
- **export / import** — `buildItemsCsv` + `buildCatalogCsv` add an `isUnlimited` column (quantity cell left
  **blank** for an unlimited row); `catalog-import.ts` parses an `is_unlimited`/`unlimited` boolean column
  (header aliases), Zod-validated, and rejects `unlimited = true` on a non-DISCRETE row with a clear row error.
- **HA bridge** — `dto.ts` (`ItemSummaryDto.quantity` nullable + `isUnlimited`), `item-view.ts` (registry
  `quantity` resolver returns `null` for unlimited + `isUnlimited` field + summary default), `openapi.ts` +
  regenerated `openapi.yaml` (`ItemSummary` **and** `ItemMatch` quantity nullable, `isUnlimited` documented,
  CSV column note), `odata-metadata.ts` CSDL (`quantity` nullable + `isUnlimited`), `bridge/README.md`. New
  `dto.test.ts`; CSV-header test updated. *(The `ItemMatch.quantity` nullability was the code-review gate's
  one finding — `/api/v1/search` projects via the registry, so an unlimited match serialises `quantity: null`;
  fixed by widening the schema.)*
- **`scripts/browser-smoke.mjs`** — +2 steps (see below).

### The browser-smoke steps appended
1. **After "creates a Bulk item":** *"creates an Unlimited-supply item shown as ∞ with no ± stepper (Phase 82)"* —
   opens Add item, checks `data-testid="item-unlimited"`, asserts the ∞ label renders and the item's card has
   no Increase/Decrease-quantity button.
2. **Before "toggles the BOM costing mode":** *"an Unlimited-supply BOM component is always satisfiable — never
   a shortfall (Phase 82)"* — adds the unlimited item as a BOM line (qty 1000), asserts it shows in the Bill of
   materials but **not** in the Shopping-list section.

> **⚠️ Pre-existing smoke drift discovered (NOT introduced by Phase 82) — re-scheduled, not dropped.** The
> full `browser-smoke.mjs` currently cascades from the **"kiosk mode …"** step, which calls `selectOption(...)`
> on `data-testid="setting-kiosk-mode"` — now a **Foundry Select combobox** (role `combobox`, not a native
> `<select>`), so it throws and leaves the app on the settings screen, failing every later step. This is
> unrelated to Phase 82 (settings screen untouched). **The Phase-82 UI was verified in a real browser via a
> throwaway targeted Playwright script** (toggle checks → ∞ renders → no ± stepper, all ✓). **→ Target: fix the
> kiosk-mode (and any sibling combobox) smoke steps to the click-open + click-option pattern in the next
> maintenance pass / Phase 83**, then re-run the full smoke from the primary checkout.

### Deferred (tracked in the spec)
Unlimited on other modes (CHECK-forbidden); metered cost accrual; per-location unlimited; an unlimited filter
facet — all Backlog with triggers (see `docs/todo/unlimited-supply_2026-07-03.md`).

### Continuation prompt
See `docs/todo/unlimited-supply_2026-07-03.md` → **Continuation prompt**, reproduced identically at the end of
the implementation session's chat reply.
