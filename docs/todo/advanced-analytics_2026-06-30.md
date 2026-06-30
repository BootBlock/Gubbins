# Advanced inventory analytics — Phase 74 (living plan + outcome)

The second feature-gap audit (`feature-gap-audit-2026-06-30b`, candidate #6) flagged **advanced
analytics** as the last parked prosumer gap after label customisation (Phase 73). Scope: **ABC
analysis, inventory turnover, stock aging, and valuation-over-time** — all read-only projections
that extend the Phase-61 `ReportRepository` and the Reports screen. After this lands, the second
audit's candidate list is fully cleared.

## Decisions (confirmed with the developer, 2026-06-30)

- **Read-only, no migration.** Every figure is a projection over data already stored (`items`,
  `item_history`, `item_stock`, `supplier_parts`). `user_version` stays **1** — verified against
  `v1-initial.ts` (it already carries `unit_cost`, `purchase_price`, `acquired_at`, the
  `item_history` ledger, and the per-location stock SSOT). No new persisted artefact is needed.
- **Turnover denominator = ledger-reconstructed average on-hand value.** We store no historical
  value snapshots, so reconstruct the window-start quantity by reversing the net `item_history`
  quantity delta from the current on-hand count, then average `(startQty + currentQty) / 2 ×
  effectiveUnitCost`. More accurate than a current-value proxy; documented approximation.
- **Surface = new panels on the existing Reports screen.** Extend `ReportsScreen` with new
  sections and **one new aria-live completion region** (Phase-63 pattern), reusing all the
  existing query/CSV plumbing. No new route.
- **Windows = a user-selectable 30 / 90 / 365-day segmented control** driving turnover +
  valuation-trend. **ABC is fixed at the annual (365-day) window** by definition ("annual
  consumption value"); the aging buckets are fixed (0–30 / 31–90 / 91–180 / 180+ days).
- **No charting dependency** (§2.4.3 native-first) — hand-rolled SVG/Tailwind sparkline + bars,
  exactly as `MovementChart`/`ValueBreakdown` already do.
- **Cost precedence stays single-sourced.** Every value figure goes through the existing
  `effectiveUnitCost(ValuedUnit)` seam in `reports.ts` (manual `unit_cost` wins, else preferred
  supplier cost, else unpriced→0). No second cost rule.

## Architecture — pure seams (the house pattern: logic out of the glue)

Four new **pure, dependency-free, unit-tested** modules under `src/features/reports/`, each owning
one analytic's maths and reusing `effectiveUnitCost`/`ValuedUnit` from `./reports`. The
`ReportRepository` runs the SQL and hands minimal raw rows to these helpers; the UI formats the
DTOs with `useFormatters`. Each module is implemented by an isolated sub-agent with its own
`.test.ts`; the shared `ReportRepository` + `queries.ts` + `ReportsScreen` integration is owned by
the lead to avoid file contention.

### 1. `abc-analysis.ts` — `classifyAbc(items, opts?)`

Pareto classification by **annual consumption value** = `consumedUnits × effectiveUnitCost`.

```ts
interface AbcInput extends ValuedUnit { id: string; name: string; consumedUnits: number; }
interface AbcLine { id; name; annualValue; cumulativeShare; tier: 'A' | 'B' | 'C'; }
interface AbcTierSummary { tier: 'A'|'B'|'C'; itemCount; totalValue; valueShare; }
interface AbcReport {
  lines: AbcLine[];               // value-desc, A→C
  tiers: { A: AbcTierSummary; B: …; C: … };
  totalValue: number;
  thresholds: { aCutoff: number; bCutoff: number };
}
function classifyAbc(items, opts?: { aCutoff?: number; bCutoff?: number }): AbcReport
```

- Defaults `aCutoff = 0.8`, `bCutoff = 0.95` (cumulative value share: A ≤ 80 %, next ≤ 95 %, rest
  C). Clamp `consumedUnits ≥ 0`; `annualValue = max(0, consumedUnits) × effectiveUnitCost`.
- Sort by `annualValue` desc, tiebreak `name` (NOCASE-ish `localeCompare`). Walk a running
  cumulative; the **running cumulative share *after* adding the item** decides the tier (standard
  Pareto). Zero-value items → tier C. `totalValue === 0` → every item C, shares 0.
- Edge cases to test: empty input; all-zero values; single item (→ A); exact-boundary ties;
  unpriced items (cost 0 → value 0 → C).

### 2. `turnover.ts` — `summariseTurnover(items, windowDays)`

```ts
interface TurnoverInput extends ValuedUnit { id; name; currentQty; consumedUnits; netQtyDelta; }
interface TurnoverLine { id; name; cogs; avgValue; turnover: number | null; }
interface TurnoverReport {
  windowDays; lines;            // turnover desc, nulls last
  totalCogs; totalAvgValue;
  turnover: number | null;      // portfolio totalCogs / totalAvgValue
  daysOnHand: number | null;    // windowDays × totalAvgValue / totalCogs
}
```

- `cost = effectiveUnitCost(item)`; `cogs = max(0, consumedUnits) × cost`.
- `startQty = max(0, currentQty − netQtyDelta)`; `avgQty = (startQty + currentQty) / 2`;
  `avgValue = avgQty × cost`.
- `turnover = avgValue > 0 ? cogs / avgValue : null` (division-by-zero guard). Aggregate the same
  way over summed totals. `windowDays` clamp `≥ 1`.
- Edge cases: avgValue 0 (unpriced or no stock) → null turnover; negative `netQtyDelta` (net
  inflow) → larger startQty; empty input → zero totals, null ratio.

### 3. `stock-aging.ts` — `bucketStockAging(items, now, bounds?)` + `parseAcquiredAt(text)`

```ts
interface AgingInput extends ValuedUnit {
  id; name; quantity;
  lastInboundAt: number | null;  // MAX(created_at) of positive qty deltas
  acquiredAtMs: number | null;   // parsed items.acquired_at (TEXT ISO) or null
  createdAt: number;
}
interface AgingBucket { label; minDays; maxDays: number | null; itemCount; quantity; value; }
interface StockAgingReport { now; buckets; totalQuantity; totalValue; }
function parseAcquiredAt(text: string | null): number | null   // Date.parse + NaN guard
```

- Reference instant precedence: `lastInboundAt ?? acquiredAtMs ?? createdAt` (most-recent inbound
  movement wins; else acquisition date; else creation). `ageDays = max(0, floor((now − ref)/MS))`.
- Default bounds `[30, 90, 180]` → buckets `0–30`, `31–90`, `91–180`, `180+`. Only `quantity > 0`
  items count. `value = max(0, quantity) × effectiveUnitCost`.
- `parseAcquiredAt`: `acquired_at` is a TEXT ISO date in the schema — `Date.parse`, return null on
  `NaN`. Tested for valid ISO, date-only, empty/garbage, null.
- Edge cases: item with no history & no acquired_at (→ createdAt); future reference (clamp age 0);
  empty input → all-zero buckets still present.

### 4. `valuation-trend.ts` — `buildValuationTrend(currentValue, events, windowStart, windowEnd, points)`

Reconstruct total inventory value backward from the current value over the window.

```ts
interface ValuationEvent { createdAt; valueDelta; }   // qty_delta × effectiveUnitCost(item)
interface ValuationPoint { at; value; }
interface ValuationTrendReport {
  windowStart; windowEnd; points;  // length = points (≥2), chronological
  startValue; endValue; changeValue;
}
function buildValuationTrend(currentValue, events, windowStart, windowEnd, points): …
```

- `value(t) = currentValue − Σ valueDelta for events with createdAt > t` (events after `t`, up to
  `windowEnd = now`). Emit `points` evenly-spaced boundaries from `windowStart` to `windowEnd`
  inclusive. `endValue = value(windowEnd) = currentValue`; `startValue = value(windowStart)`;
  `changeValue = endValue − startValue`.
- Clamp each emitted value `≥ 0` (cost data can make a naive reversal dip below zero); document it.
  `points` clamp `≥ 2`; degenerate window (`windowEnd ≤ windowStart`) → flat 2-point line.
- Edge cases: no events → flat line at `currentValue`; one event; events outside the window
  ignored.

## Repository methods (lead-owned) — `ReportRepository`

All filter `is_active = 1` and exclude abstract variant parents via the existing
`notAVariantParent(col)`; cost falls back through the existing `preferredSupplierCostSql(col)`.

- `abcAnalysis(windowDays = 365, now = Date.now())` — per active item, `consumedUnits =
  -SUM(MIN(quantity_delta, 0))` over `[now − windowDays, now)`, joined to `items` for name +
  `unit_cost` + preferred supplier cost → `classifyAbc`.
- `turnover(windowDays, now)` — per active item: `quantity` (currentQty), costs, `consumedUnits`
  (`-SUM(MIN(qd,0))`), `netQtyDelta` (`SUM(qd)`) over the window → `summariseTurnover`.
- `stockAging(now)` — per active item with `quantity > 0`: `quantity`, costs, `acquired_at` (TEXT),
  `created_at`, and `lastInboundAt = (SELECT MAX(created_at) FROM item_history WHERE item_id = i.id
  AND quantity_delta > 0)` → resolve `acquiredAtMs` via `parseAcquiredAt` → `bucketStockAging`.
- `valuationTrend(windowDays, points, now)` — `currentValue = SUM(quantity × effectiveUnitCost)`
  (reuse the `inventoryValue` headline path), plus per-event rows `{ created_at, quantity_delta,
  unit_cost, preferred_supplier_cost }` over the window; map each to `valueDelta = quantity_delta ×
  effectiveUnitCost(...)` → `buildValuationTrend`.

`ReportRepository.test.ts` gets a `describe` block per method proving the SQL feeds the seams the
right rows over `:memory:` fixtures (mirrors the existing valuation/movement tests).

## UI (lead-owned) — `ReportsScreen` + components

- New constants in `queries.ts`: `ABC_WINDOW_DAYS = 365`, `ANALYTICS_WINDOWS = [30, 90, 365]`,
  `DEFAULT_ANALYTICS_WINDOW = 90`, `VALUATION_TREND_POINTS = 12`. New hooks `useAbcAnalysis`,
  `useTurnover(windowDays)`, `useStockAging`, `useValuationTrend(windowDays)`.
- A local `analyticsWindow` state (segmented control) drives turnover + trend hooks; ABC uses the
  fixed annual window.
- New presentational components (no chart dep, tokens only):
  - `AbcBreakdown.tsx` — A/B/C tier summary bars + counts (new `abc-a/b/c` tokens) and a top-items
    list.
  - `TurnoverTable.tsx` — portfolio ratio + days-on-hand headline and a per-item table (fastest
    movers first).
  - `StockAgingChart.tsx` — four token-styled bucket bars (primary; the 180+ bucket warning-tinted).
  - `ValuationSparkline.tsx` — hand-rolled SVG polyline of the trend points + start/end/change.
- A **second aria-live region** announces analytics readiness (`Analytics ready`), tracked with
  its own `announcedRef` so it fires once (mirrors the existing reports region).
- Design tokens: add `--abc-a/--abc-b/--abc-c` to `:root` **and** `.dark` in
  `src/styles/index.css`, mapped to `--color-abc-*` in `@theme inline`. Everything else reuses
  existing tokens (`primary`, `warning`, `success`, `muted-foreground`, `border`).
- CSV: extend `report-csv.ts` with `buildAbcCsv`, `buildTurnoverCsv`, `buildAgingCsv`,
  `buildValuationTrendCsv` and widen `ReportCsvKind`; wire into the Export Wizard's report list.

## Verification

- `npx tsc -p tsconfig.app.json --noEmit` (junctioned tree can't write `.tsbuildinfo`).
- `npm run test:run` — full suite green (new: 4 seam test files + repository + CSV + screen).
- `npm run build` clean.
- Browser-smoke: add an assertion that the new analytics panels render on the Reports screen.

## Self-review of this plan (correctness / performance / robustness)

- **Turnover reconstruction validity.** `startQty = currentQty − netQtyDelta` is exact for the
  quantity ledger *as recorded*; gauge-only consumption (`net_value_delta`) is intentionally
  excluded from the quantity maths (turnover is a discrete-stock ratio) — documented, consistent
  with `movement`/`consumptionRate` which also key on `quantity_delta`. ✓
- **ABC boundary determinism.** Cumulative-after-add + name tiebreak makes tier assignment
  deterministic across equal values; the `totalValue === 0` short-circuit avoids divide-by-zero. ✓
- **Aging reference fallback.** `acquired_at` is TEXT — parsing is isolated in the tested
  `parseAcquiredAt` so a malformed value degrades to `createdAt`, never `NaN` buckets. ✓
- **Valuation reversal sign.** Subtracting post-`t` deltas from the current value reconstructs the
  past; clamping `≥ 0` prevents a nonsensical negative chart from imperfect cost data. ✓
- **Performance.** ABC/turnover/aging are one aggregate row per active item (tiny); the trend
  fetches windowed history events (bounded, same shape as `movement`). All within the existing
  read-only aggregate envelope. ✓
- **Division-by-zero** is guarded in every ratio (`turnover`, shares, percentages). ✓

## Outcome

Shipped as planned. **No migration** — `user_version` stays **1** (every figure is a read-only
projection over existing data). Four pure, unit-tested seams under `src/features/reports/`:

- `abc-analysis.ts` — `classifyAbc` (Pareto by annual consumption value; default 0.8/0.95 cumulative
  cutoffs; top priced item anchors A so the "vital few" head is never empty). 12 tests.
- `turnover.ts` — `summariseTurnover` (COGS ÷ ledger-reconstructed average on-hand value;
  `safeRatio` guard → null, never NaN/∞). 11 tests.
- `stock-aging.ts` — `bucketStockAging` + `parseAcquiredAt` (reference = newest inbound ?? acquired
  ?? created; default 0–30/31–90/91–180/180+ buckets). 17 tests.
- `valuation-trend.ts` — `buildValuationTrend` (reverse the value-tagged ledger from the current
  total; values clamped ≥ 0; O(points + events log events)). 14 tests.

`ReportRepository` gained `abcAnalysis` / `turnover` / `stockAging` / `valuationTrend` (correlated
subqueries for consumed/net deltas + newest-inbound; cost via the existing `preferredSupplierCostSql`
fallback and the single `effectiveUnitCost` seam). `queries.ts` added the four hooks + the
`ANALYTICS_WINDOWS` 30/90/365 control (default 90; ABC fixed 365). The Reports screen gained an
**Advanced analytics** section — `AbcBreakdown`, `TurnoverTable`, `StockAgingChart`,
`ValuationSparkline` (hand-rolled SVG, no chart dep) — a window segmented control, and its own
Phase-63 aria-live completion region. New design tokens `--abc-a/b/c` (light + dark + Tailwind
mapping). CSV: four new builders wired through the Export Wizard (ABC / turnover / aging /
valuation-trend report kinds).

**Verification:** `tsc -p tsconfig.app.json --noEmit` clean · **1703 unit tests / 146 files**
(+66 over the 1637 baseline) · `npm run build` clean (precache 3320 KiB, informational) ·
browser-smoke extended with turnover/aging/sparkline + analytics-window assertions on the Reports
screen.

After this, the second feature-gap audit's candidate list (`feature-gap-audit-2026-06-30b`) is
**fully cleared**.
