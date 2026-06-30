# Phase 79 — Procurement / spend analytics

> Wave 2, candidate #5 (the last) of the third feature-gap audit
> (`feature-gap-audit-2026-06-30c`). **Read-only — NO migration** (`user_version` stays 2).
> Completes Wave 2. Living plan doc.

## Problem & distinction

There is no view of **money out over time**. The Phase-74 valuation-trend tracks *inventory
value* (what the stock is worth, reconstructed backward); this tracks **spend** (cash that left,
summed forward). They are complementary and must **not** overlap — different question, different
maths.

Spend is composed from three sources already stored, each **tagged by source** for transparency
(an item bought via a PO can appear in two sources — that is surfaced, not silently de-duplicated):

1. **Received purchase-order lines** — `received_qty × unit_cost`, dated by the PO's
   `COALESCE(ordered_at, created_at)`, supplier = `purchase_orders.supplier_name`, category = the
   line's item category.
2. **Manual project expenses** — `project_expenses.amount` at `incurred_at`. No supplier, no item
   category (its `category_id` is a *project budget* category, a different taxonomy) → grouped under
   "No supplier" / "Uncategorised".
3. **Item acquisition prices** — `items.purchase_price` at the parsed `items.acquired_at` (ISO
   TEXT). No recorded supplier; category = the item's category.

## Scope decisions (recommended defaults)

- **Sources:** all three, each tagged by `source` so the breakdown is auditable.
- **Bucketing:** a **selectable trailing window** reusing the Phase-74 `ANALYTICS_WINDOWS`
  segmented control (30 / 90 / 365 days); spend bucketed into equal half-open spans (mirrors
  `bucketMovement`'s rigour).
- **Dimensions:** total; over time (buckets); by source; by supplier; by category.
- **CSV:** yes, via the Export Wizard (the Phase-74/77 pattern — 5 touchpoints).

## Pure seam — `src/features/reports/spend-analytics.ts`

Clock/DB/React-free, exhaustively unit-tested (mirrors `valuation-trend.ts` / `reports.ts`):

```ts
type SpendSource = 'PURCHASE_ORDER' | 'PROJECT_EXPENSE' | 'ACQUISITION';
interface SpendEvent { instant: number; amount: number; source: SpendSource;
                       supplier: string | null; categoryId: string | null; categoryName: string | null }
interface SpendBucket { start: number; end: number; total: number }   // half-open [start,end)
interface SpendGroup  { id: string | null; name: string; total: number; share: number }
interface SpendReport {
  windowStart; windowEnd; total;
  buckets: SpendBucket[];
  bySource:   { source: SpendSource; total: number; share: number }[];
  bySupplier: SpendGroup[];   // id=supplier name; null → "No supplier"
  byCategory: SpendGroup[];   // id=category id;  null → "Uncategorised"
}
function buildSpendReport(events, windowStart, windowEnd, buckets): SpendReport
```

- Drop events outside `[windowStart, windowEnd)` (half-open) and any with a non-finite/≤0 amount.
- `share` = `safeRatio(groupTotal, total)` (guard divide-by-zero → 0). Groups sorted by total desc,
  then name asc; `bySource` in a fixed display order.
- Bucket index via `floor((instant − windowStart) / span × count)`, clamped — same as `bucketMovement`.

## Repository — `ReportRepository.spendAnalytics(windowDays, buckets, now)`

Three SQL queries → `SpendEvent[]` → `buildSpendReport`:
- PO lines: `JOIN purchase_orders po`, `LEFT JOIN items/categories`, `WHERE l.received_qty > 0 AND
  l.unit_cost IS NOT NULL AND COALESCE(po.ordered_at, po.created_at) BETWEEN window`.
- Project expenses: `WHERE incurred_at >= ? AND < ? AND amount > 0` (supplier/category null).
- Acquisitions: `WHERE purchase_price IS NOT NULL AND acquired_at IS NOT NULL` — parse `acquired_at`
  to ms in JS (reuse `parseAcquiredAt` from `stock-aging.ts`), filter to the window in JS.
- **New `:memory:` `ReportRepository.test.ts` block** (the Phase-77 lesson), not only the pure-seam
  tests.

## Surfaces

- `queries.ts`: `useSpendAnalytics(windowDays)` + `SPEND_BUCKETS` constant (reuse `ANALYTICS_WINDOWS`
  / `DEFAULT_ANALYTICS_WINDOW`).
- `ReportsScreen.tsx`: a **Spend analytics** `<section>` with the existing `WindowToggle`, a small
  bucket bar strip + by-source / by-supplier / by-category breakdown tables (design tokens only),
  and its own Phase-63 aria-live completion region. A one-line note that sources may overlap.
- CSV: `buildSpendCsv` in `report-csv.ts` (+ the `'SPEND'` kind) wired through the 5 export
  touchpoints (`report-csv.ts` type+builder, `useExportStore.ts` union, `run-export.ts` import +
  filename map + switch case, `ExportWizard.tsx` option).

## Design tokens

No new token — bars/badges reuse `primary` / `muted` / `muted-foreground` / `border`. Confirm none
is a raw colour.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit`, `npm run test:run`, `npm run build` — all green.
- Pure-seam unit tests (window half-open edges, divide-by-zero guard, source/supplier/category
  grouping, empty window). Repository `:memory:` SQL test across all three sources.
- British English, design tokens, no secrets, no migration (`user_version` unchanged at 2).
