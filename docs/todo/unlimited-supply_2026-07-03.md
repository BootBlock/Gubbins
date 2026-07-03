# Phase 82 — Unlimited-supply items (living plan)

> **Living document.** Implemented in its own worktree/session. Tick the `[ ]` boxes as work
> lands, append a one-paragraph **Outcome** note when it completes (mirroring
> `docs/dev/deferred-features.md`), and re-schedule — never silently drop — any deferred item.
>
> **Continuation-prompt rule (mandatory).** When the phase completes you **must** emit the
> next kick-off prompt as a **raw, fenced Markdown code block** in the chat reply (the last
> thing in the reply) *and* record it under [Continuation prompt](#continuation-prompt). The
> two must be identical.

## Why this phase exists

Gubbins models four tracking levels (§4 "Tracking Levels", `TRACKING_MODES` in
[constants.ts](../../src/db/repositories/constants.ts)): `DISCRETE`, `SERIALISED`,
`CONSUMABLE_GAUGE`, `UNTRACKED`. None expresses an item whose **supply is effectively
infinite** — the motivating example is *tap water* (sourced on demand, consumed by recipes/BOMs,
never runs out), and the same shape covers mains electricity/compressed air, sand/aggregate from
a bulk pile, or "zip ties from the big tub I never bother to count". Today the only near-fit is
`UNTRACKED`, but that is semantically *presence-only* ("catalogued, but no quantity to count") —
it is **not consumable**. An unlimited item is the opposite: it **is** consumed (by assemblies,
checkouts, cycle counts) yet the consumption never depletes it and it never runs low.

## Core design decision — a modifier, not a fifth mode

"Unlimited" is a property of the item's **source**, orthogonal to *how* you track it — so it is
modelled as a **boolean flag on a `DISCRETE` item**, not a new `TrackingMode`. This is the
right altitude because:

- It only combines sensibly with `DISCRETE`. `SERIALISED` means "exactly one unique unit"
  (contradiction); `CONSUMABLE_GAUGE`'s entire purpose is a depletion percentage (contradiction);
  `UNTRACKED` already means "no quantity" (redundant). A `CHECK` enforces DISCRETE-only.
- A modifier reuses every existing DISCRETE behaviour (it *is* counted and consumed) and only
  overrides the handful of places where "infinite" changes the answer, instead of forcing a new
  branch into every exhaustive `switch`/`Record<TrackingMode, …>` (badge, icons, labels, import,
  export, bridge CSDL) — a far smaller and lower-risk touch surface.
- It composes: a future "unlimited" could be permitted on another mode by relaxing one `CHECK`,
  without reshaping the enum.

**Semantics of `is_unlimited = 1` (DISCRETE only):**

| Facet | Behaviour |
| --- | --- |
| On-hand quantity | Displayed as **∞** (a `text-glyph-*`-tinted infinity glyph), never a number. Whatever integer sits in the `quantity` column is **ignored for display** — the ± stepper is replaced by a static ∞. |
| Low-stock / reorder | **Never** low; **never** on the shopping list (shortfall always 0). |
| BOM / assembly consumption | **Always satisfiable** — reservation and consumption always succeed, never contribute to a project shortfall, and **do not** touch the `item_stock`/`stock_batches` ledger (nothing to decrement). Consumption is still logged (`CONSUMED`) for the activity trail. |
| Valuation / reports | **Excluded** from inventory value (`qty × cost` is undefined for ∞) and from dead-stock (an infinite source is never "dead"). |
| Cycle count | **Excluded** — you do not count an infinite source. |
| Checkout | **Blocked** with a clear message, mirroring the existing `UNTRACKED` guard ([CheckoutRepository.ts:75](../../src/db/repositories/CheckoutRepository.ts#L75)) — an infinite source is not "lent". |
| Bookings | Not applicable — `asset_bookings` are SERIALISED-asset-only, which unlimited (DISCRETE) can never be. |
| Toggling the flag | A plain LWW `update` — **no** new `HISTORY_ACTION`. On/off is lossless (it never rewrites `quantity`). |

## Schema — edit the squashed `v1` baseline (no forward migration)

The migration chain is a **single squashed `v1-initial`** (`user_version` **1**; there are *no*
forward migrations — [index.ts](../../src/db/migrations/index.ts)). Per the established
pre-release convention (add-item-enrichment work: *"wipe local DB on any schema change"*), a
schema change is made by **editing the baseline `CREATE TABLE`** and regenerating the snapshot
fixture — **not** by appending a `v2`. `user_version` stays **1**.

Add to the `items` table in [v1-initial.ts](../../src/db/migrations/v1-initial.ts):

```sql
is_unlimited INTEGER NOT NULL DEFAULT 0
-- alongside the existing CHECKs:
CHECK (is_unlimited IN (0, 1)),
CHECK (is_unlimited = 0 OR tracking_mode = 'DISCRETE')
```

- `DEFAULT 0` ⇒ every pre-existing item is a normal finite item (never a regression).
- The second `CHECK` is the invariant that keeps "unlimited" DISCRETE-only at the database level,
  mirroring the existing `CHECK (tracking_mode <> 'SERIALISED' OR quantity = 1)` pattern.
- **Sync:** `items` is already in `SYNC_TABLES`; an additive non-FK column auto-joins the §7.1
  LWW payload (exactly as the Phase-59 reorder columns did) — **no** `SYNC_TABLES`/`FK_REFS`
  edit. The flag reconciles last-write-wins like any other column.
- **Snapshot:** regenerate `src/db/migrations/__fixtures__/schema-baseline.snapshot.json` and
  extend [v1-initial.test.ts](../../src/db/migrations/v1-initial.test.ts) with a case asserting
  the `is_unlimited = 1 AND tracking_mode <> 'DISCRETE'` insert is **rejected** by the CHECK.

## Pure seams (extract-the-logic, `:memory:`/no-DB, unit-tested)

### `src/features/inventory/unlimited.ts` (+ `unlimited.test.ts`)
The single source of truth for the "infinite source" rules the UI, repositories and reports reuse:
- `isUnlimited(item)` — narrow predicate (`item.isUnlimited === true`).
- `canSupply(item, qty)` — `true` when unlimited **or** finite on-hand ≥ qty (so callers stop
  hand-writing the "is there enough?" check; unlimited short-circuits to always-true).
- `consumptionLedgerDelta(item, qty)` — returns `0` for unlimited (no ledger movement), else the
  usual `-qty`. The one place the "don't decrement infinity" rule lives.
- `UNLIMITED_GLYPH` (`'∞'`) + `formatQuantityDisplay(item, fmt)` — returns `∞` for unlimited,
  else `fmt.quantity(item.quantity)`. Keeps the glyph out of JSX literals.

### `reorder-policy.ts` (extend)
Add `'isUnlimited'` to the `ReorderItem` `Pick`; `isLow()` returns **false** and `shortfall()`
returns **0** for an unlimited item (a new early-return alongside the existing SERIALISED/UNTRACKED
guard). Update the doc-comment.

## Repository & consumption integration

- **`ItemRepository.listLowStock`** — add `AND is_unlimited = 0` to the SQL feed so an unlimited
  item can never surface as low (matches the pure `isLow` guard; the two must agree).
- **Consumption / reservation** ([project/assembly.ts](../../src/db/repositories/project/assembly.ts),
  reservation glue, [item/stock.ts](../../src/db/repositories/item/stock.ts)) — route the "how
  much stock actually moves" decision through `consumptionLedgerDelta`. For an unlimited component:
  reservation always succeeds; consumption writes a `CONSUMED` history row but issues **no**
  `item_stock`/`stock_batches` decrement (so it never trips the `quantity >= 0` CHECK or FEFO
  batch-exhaustion path). **Never** hand-roll a second stock path — this is a guard *inside* the
  existing seam.
- **BOM shortfall** ([project/costing.ts](../../src/db/repositories/project/costing.ts)) — the
  `SUM(required_qty - reserved_qty)` shortfall query must exclude lines whose item `is_unlimited`
  (join `items`, `AND i.is_unlimited = 0`), so an unlimited component never shows a deficit or a
  "needs ordering" estimate.
- **Reports** ([ReportRepository.ts](../../src/db/repositories/ReportRepository.ts)) — exclude
  `is_unlimited = 1` from `inventoryValue` (all three groupings) and from `deadStock`. Leave
  `consumptionRate`/`movement` counting real `CONSUMED` history if desired, but an unlimited
  item's on-hand never changes so it will naturally not appear in movement deltas.
- **Checkout** ([CheckoutRepository.ts:75](../../src/db/repositories/CheckoutRepository.ts#L75)) —
  add an `is_unlimited` reject alongside the `UNTRACKED` guard (same `DbError` shape and tone), so
  an infinite source cannot be checked out.
- **Cycle count** — the count-sheet query (the seam that lists items to count) excludes
  `is_unlimited = 1`, so an infinite source never lands on a stocktake; the pure
  [cycle-count.ts](../../src/features/lifecycle/cycle-count.ts) variance maths needs no change.

## UI (Foundry primitives + design tokens only; British English)

- **Create/Edit** ([CreateItemDialog.tsx](../../src/features/inventory/components/CreateItemDialog.tsx),
  `ItemDetailsEditor`) — an **"Unlimited supply"** toggle (Foundry switch/checkbox) on the Details
  tab, **enabled only when tracking mode is DISCRETE** (disabled + hint otherwise), with an
  `InfoHint` explaining "never runs out; excluded from counts, low-stock and valuation". Switching
  an item *to* unlimited is lossless; switching *off* restores normal stepping.
- **Quantity display** — [ItemRow.tsx:70-78](../../src/features/inventory/components/ItemRow.tsx#L70-L78)
  and the matching `ItemCard` ladder already branch on `gauge`/`SERIALISED`/`UNTRACKED` before the
  `QuantityStepper`; add an **`isUnlimited` branch first** that renders the static `UNLIMITED_GLYPH`
  (∞, tinted with a `text-glyph-*` token) with an accessible label ("Unlimited supply") — no ±
  controls. `QuantityStepper` itself is untouched (it is simply not rendered for unlimited items).
- **Badge** — a small ∞ pill next to the `TrackingBadge` (or a tooltip note on it), reusing the
  badge's existing token classes; add an `InfinityIcon` to the icon set if none exists (SVG,
  `currentColor`, no raw colour).

## Clone / export / import / bridge (round-trip the flag)

- **Clone** ([clone.ts](../../src/features/inventory/clone.ts), Phase 76) — `is_unlimited` is a
  template property, so `planItemClone` must **carry it onto the copy** (add it to the copied
  field set; the "reset quantity to 0" policy is unchanged and harmless for an unlimited item).
- **Export** ([export-data.ts](../../src/features/export/export-data.ts)) — add `isUnlimited` to
  the exported item columns.
- **Import** ([catalog-import.ts](../../src/features/inventory/catalog-import.ts),
  [text-import.ts](../../src/features/inventory/text-import.ts)) — parse an `is_unlimited`/
  `unlimited` boolean column (header aliases), Zod-validated, defaulting `false`; reject
  `unlimited = true` on a non-DISCRETE row with a clear row error (mirror the DB CHECK).
- **HA bridge** ([bridge/src/api/dto.ts](../../bridge/src/api/dto.ts),
  [item-view.ts](../../bridge/src/api/item-view.ts),
  [openapi.ts](../../bridge/src/openapi.ts),
  [odata-metadata.ts](../../bridge/src/api/odata-metadata.ts), README + `openapi.yaml`) — expose
  `is_unlimited` (boolean) in the item DTO/CSV/CSDL. **JSON has no `Infinity`**, so an unlimited
  item serialises `quantity: null` **with** `is_unlimited: true` (document this in the OpenAPI
  description); the CSV `quantity` cell is left blank for unlimited rows. Bump the OpenAPI/CSDL
  field set and add a `dto` test.

## Tests

- `unlimited.ts` unit tests (`isUnlimited`, `canSupply`, `consumptionLedgerDelta`,
  `formatQuantityDisplay`).
- `reorder-policy` — unlimited never low, shortfall 0.
- Migration — regenerated snapshot; the DISCRETE-only CHECK rejects `is_unlimited = 1` on a
  SERIALISED/GAUGE/UNTRACKED row.
- Repository `:memory:` — `listLowStock` excludes unlimited; consuming an unlimited BOM component
  logs `CONSUMED`, leaves the ledger untouched, and never blocks/shortfalls a build; valuation
  excludes unlimited.
- Mapper round-trip (`is_unlimited` ↔ `isUnlimited`).
- Import/export round-trip; import rejects unlimited-on-non-DISCRETE.
- Bridge `dto` test (`quantity: null` + `is_unlimited: true`).
- **Browser smoke (+1 step):** create a DISCRETE item, toggle **Unlimited supply**, assert the
  row shows **∞** (no stepper); add it as a BOM component and assert the project shows **no
  shortfall** for it.

## Deliverables checklist

- [ ] `is_unlimited` column + two CHECKs in the squashed `v1-initial`; snapshot regenerated;
      `user_version` still 1; CHECK-rejection test
- [ ] `unlimited.ts` pure seam + tests; `reorder-policy` extended
- [ ] mapper / types / `create` / `update` / `clone` round-trip the flag
- [ ] `listLowStock`, BOM shortfall, consumption/reservation, reports honour unlimited
- [ ] checkout blocked + cycle-count sheet excludes unlimited
- [ ] Create/Edit toggle (DISCRETE-gated) + ∞ quantity display + ∞ badge (tokens, British English)
- [ ] export/import + HA bridge (`quantity: null` + `is_unlimited: true`) round-trip
- [ ] code review passed (mandatory pre-merge gate); PHASE_HANDOVER updated; Outcome note appended

## Out of scope / deferred (tracked)

- **Unlimited on `CONSUMABLE_GAUGE`/`SERIALISED`/`UNTRACKED`** — forbidden by CHECK; no use case.
  Trigger to revisit: a concrete request for an "infinite gauge".
- **Metered cost accrual** — charging a per-unit `unit_cost` for consumed unlimited stock (so tap
  water still costs something on a BOM even though the *quantity* is infinite). Backlog. Trigger:
  a request to cost unlimited consumption. (The `unit_cost` column already exists, so this is a
  reporting-only follow-up.)
- **Per-location unlimited** — unlimited is an item-level property; it does not model "infinite in
  the workshop but finite in the van". Backlog; contradicts the single-source framing.
- **Unlimited filter facet** — a list filter / saved-search predicate for "show only unlimited
  items". Nice-to-have; Backlog. Trigger: a request to slice the catalogue by supply type.

## Verification

`npx tsc -p tsconfig.app.json --noEmit`, `npm run test:run`, `npm run build` — all green; plus
the bridge test suite if `bridge/` is touched.

## Continuation prompt

_(Populated when the phase completes — see the Continuation-prompt rule above.)_
