# Phase 81 — Supplier price-history tracking

> Wave 3, add-on #7 (the LAST candidate) of the third feature-gap audit
> (`feature-gap-audit-2026-06-30c`). The wave's **one** migration: `user_version` 2 → **3**
> (new synced `supplier_part_price_history` table). Living plan doc.

## Problem

A supplier part's `supplier_parts.unit_cost` is editable manually **and** filled by a
supplier scrape — but both paths simply **overwrite** the previous value, so a part's
price movement over time is lost. This phase records each genuine cost change as a
lightweight history row, and surfaces a compact price-history sparkline + last-N list on
the item's supplier-parts panel.

## Scope decisions (recommended defaults)

- **What records a row:** **every genuine `unit_cost` change**, deduped against the
  previous value (a no-op write records nothing). Both the **manual** edit and the
  **scrape-apply** path flow through `SupplierPartRepository.create` / `.update`
  (the scrape's `resolveSupplierPartWrite` produces a create/update that the same repo
  methods execute), so instrumenting the repository captures both. Tagged by `source`
  (`'MANUAL'` | `'SCRAPE'`) and the cost's `currency`.
  - **create:** record a baseline point when a non-null cost is supplied.
  - **update:** record only when `unitCost` is provided, is non-null, and differs from
    the existing value (dedup). Clearing the cost to null records nothing.
- **Columns:** `id, supplier_part_id (FK→supplier_parts ON DELETE CASCADE, NOT NULL),
  unit_cost REAL (CHECK ≥ 0), currency TEXT, source TEXT (CHECK IN MANUAL/SCRAPE,
  default MANUAL), recorded_at INTEGER, updated_at INTEGER` + the canonical `updated_at`
  auto-stamp trigger. Rows are insert-only in practice, so LWW is degenerate (each row
  syncs once and never updates) — but the table is wired as an ordinary synced LWW table.
- **Surface:** a compact **sparkline + last-N list** under each supplier-part row in
  `SupplierPartsTable` (design tokens only, hand-rolled inline SVG — no chart dep).
- **Retention:** keep all (rows are tiny). Revisit only if it ever becomes a concern.

## Migration — v3 (additive, forward, no wipe)

New `src/db/migrations/v3-supplier-price-history.ts`, appended to `migrations/index.ts`
(contiguous: 1, 2, 3). The engine runs only steps `> from`, so an existing **v2 DB
upgrades cleanly** (creates the new table; no existing table touched). `TARGET_SCHEMA_VERSION`
becomes 3.

```sql
CREATE TABLE supplier_part_price_history (
  id               TEXT    PRIMARY KEY NOT NULL,
  supplier_part_id TEXT    NOT NULL REFERENCES supplier_parts(id) ON DELETE CASCADE,
  unit_cost        REAL    NOT NULL,
  currency         TEXT,                                   -- null ⇒ base currency
  source           TEXT    NOT NULL DEFAULT 'MANUAL',      -- 'MANUAL' | 'SCRAPE'
  recorded_at      INTEGER NOT NULL DEFAULT (now),
  updated_at       INTEGER NOT NULL DEFAULT (now),
  CHECK (unit_cost >= 0),
  CHECK (source IN ('MANUAL', 'SCRAPE'))
) STRICT;
CREATE INDEX idx_supplier_part_price_history_part
  ON supplier_part_price_history(supplier_part_id, recorded_at);
-- + trg_supplier_part_price_history_updated_at auto-stamp trigger (§7.1 LWW)
```

## Sync wiring (a price-history row is a real synced row)

- **`SYNC_TABLES`:** add `supplier_part_price_history` **after** `supplier_parts` (its FK
  parent) so an UPSERT batch never trips the FK.
- **`FK_REFS`** (reconcile): `supplier_part_price_history: [{ col: 'supplier_part_id',
  parent: 'supplier_parts', nullable: false }]` — drop an incoming row whose supplier-part
  did not survive the merge (mirrors the CASCADE). `supplier_parts` is already in the
  reconcile `removed`-parents set, so no new parent wiring is needed.
- **Tombstones:** `.delete` is not exposed for individual price rows (they cascade with the
  supplier part), but the table is a `SyncTable`, so a future delete path tombstones via the
  generic engine. (Cascade deletes leave no tombstone; the FK_REFS guard handles that on the
  peer.)
- **Schema-baseline:** regenerate `__fixtures__/schema-baseline.snapshot.json` via a
  throwaway vitest spec (`captureSchemaSnapshot` after `runMigrations`; don't hand-edit),
  and **retarget `v1-initial.test.ts`** to version **3** (length 3, the new v3 in the chain,
  `TARGET_SCHEMA_VERSION` 3, boots to 3, golden `userVersion` tied to `TARGET_SCHEMA_VERSION`).

## Repository

`SupplierPartRepository`:
- Thread `source?: 'MANUAL' | 'SCRAPE'` through `Create`/`UpdateSupplierPartInput`
  (default `'MANUAL'`); the scrape `resolveSupplierPartWrite` sets `source: 'SCRAPE'`.
- In `create`: if a non-null cost is supplied, append a price-history INSERT in the same
  transaction.
- In `update`: if `unitCost` provided, non-null, and `≠ existing.unitCost`, append the INSERT
  in the same transaction.
- New read `listPriceHistory(supplierPartId, params?)` — bounded, newest-first.

## Pure seam (new, unit-tested)

`src/features/inventory/price-history.ts`:
- `buildPriceSeries(points): PriceSeries` — sorts ascending by `recordedAt`, computes
  `first` / `latest` / `min` / `max` / `changeAbs` / `changePct` (divide-by-zero-safe:
  `first === 0 → null`) / `direction` (`up`/`down`/`flat`/`none`).
- `sparklinePolyline(values, width, height): string` — pure SVG polyline points string,
  normalising values across min..max (flat series → mid-line). No DOM/clock/React.

## Surfaces

- `useSupplierPartPriceHistory(itemId, supplierPartId)` query hook (keyed under
  `inventoryKeys.item(itemId)` so the existing supplier-part invalidation refreshes it).
- A compact `SupplierPartPriceHistory` block in `SupplierPartsTable` — sparkline + the last
  few points (cost + date + source), design tokens only, shown only when ≥1 point exists.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` → `npm run test:run` → `npm run build`, all green.
  (No new route, so no `routeTree.gen.ts` regen needed — but run `npm run build` regardless.)
- New tests: `price-history.test.ts` (series/trend + sparkline, incl. empty / single-point /
  first===0 guard); a `listPriceHistory` + record-on-change `:memory:` SQL test; the v3
  migration round-trip; the two-device sync round-trip (LWW + FK-guard).
- Self-audit `git diff --cached` for secrets; British English.
