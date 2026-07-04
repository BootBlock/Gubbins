# Dashboard & item card customisation — backlog (living plan)

A grouped backlog of card enhancements, to be implemented **one task at a time** in separate
sessions. Each task has a stable ID (`A1`, `B2`, …) so a session can be kicked off with just
"implement `A2`". Customisability is the through-line — users strongly favour making the cards
their own.

**Origin:** grew out of the dashboard nav-tile count pill (merge `d63e273` — each collection
tile now shows a right-aligned, group-coloured count via `useNavCounts`). That work is the
seed for group **A**; the rest generalise the same "make the cards yours" idea to layout,
content and the inventory item cards.

**Scope note — two card surfaces.** Groups **A–D** are the **dashboard nav tiles**
(`src/features/dashboard/DashboardNav.tsx`, `useNavCounts.ts`). Group **E** is the **inventory
item cards** (the item list/grid). They share the customisation theme but live in different
components.

**House rules that apply to every task below** (see `CLAUDE.md`): design tokens only (no raw
colour/spacing literals — add a token if a semantic role is genuinely new), reach for a Foundry
primitive before hand-rolling, keep a11y wiring (labels, roles, `aria-*`, live regions), and
verify token-based Tailwind utilities actually emit. Tunable values follow the **Tier-2
preference pattern** (clamp helpers + bounds, `usePreferencesStore`); per-device layout uses
`useLayoutStore` (the widget board already does drag/reorder/show-hide there); visibility gating
uses **Modular UI** intent.

---

## A. Count-pill enhancements (extend what just shipped)

- **A1 — Per-card configurable count metric. ✅ Done (shipped the mechanism + zero-fetch
  metrics).** `NAV_COUNT_METRIC_CONFIG` (in `settings.ts`) is the SSOT: per configurable tile it
  holds the metric options, the shipped default, and the spoken nouns. `useNavCounts` resolves
  the chosen metric (Tier-2 `navCountMetrics`, normalised per tile) and applies one **pure
  selector** per metric over the rows the tile's read hook already loads — `countProjects`
  (active / all), `countPurchaseOrders` (open / all), `countBookings` (upcoming / starting this
  week / all). The picker is a "Nav tile counts" section in **Settings → Dashboard**, one row per
  tile, feature-gated (a hidden tile shows no picker). Inventory (item total) and Contacts (all)
  stay single-metric — no picker.
  - **Deferred to land with A2:** the "problem" metrics — Projects → *over-budget*, Inventory →
    *low-stock / out-of-stock*, POs → *overdue*. Each needs data **not** on the nav-count path
    (over-budget needs the budget-alerts spend feed; low/out-of-stock need an accurate count
    query — `useLowStockItems` caps at 100 so it can't count) or a column that does not exist (a
    PO has no expected-delivery date, so "overdue" is not derivable). They pair naturally with
    **A2**'s warning `tone`, which is where they earn their keep; add each as a new entry in
    `NAV_COUNT_METRIC_CONFIG` plus its (gated) data source at that point.
- **A2 — Semantic colour for a "problem" count. ✅ Done (shipped the `tone` mechanism + the
  data-backed problem metrics).** Each `NAV_COUNT_METRIC_CONFIG` option gained an optional
  `tone` ('neutral' | 'warning' | 'danger'), threaded through `useNavCounts` onto the resolved
  `NavCount` and mapped to a token in `DashboardNav` (`warning` → `text-warning`, `danger` →
  `text-destructive`; the solid-primary Inventory CTA uses solid fills). The colour is never
  load-bearing — the tile's accessible name states the metric in words ("5 low-stock items").
  New opt-in problem metrics, each on a **gated** count query (fetched only when that metric is
  the tile's current choice): Projects → *over-budget* (danger, shared `projectBudgetHealth` with
  the Budget-alerts widget); Inventory (now configurable) → *low-stock* (warning, true-count
  `useLowStockCount`) and *out-of-stock* (danger, new `ReportRepository.outOfStockCount`).
  - **Still deferred (not derivable):** POs → *overdue* — a purchase order has no
    expected-delivery-date column, so "overdue" cannot be computed. Revisit only if/when a PO
    expected-delivery date is added to the model; then add it as a `tone: 'warning'` metric.
- **A3 — Show-counts toggle (master + per-card override).** A global "Show counts on nav tiles"
  switch in Settings → Dashboard, plus a per-tile override, for users who find them noisy. When
  off, `useNavCounts` short-circuits (no queries) so it also saves the fetches.
- **A4 — Pill style choice.** Let the user pick the count presentation: filled pill / bare
  coloured number / hidden. Device-local Tier-2 preference; a single `variant` prop on the
  count element. Pairs naturally with A3.

---

## B. Layout & appearance

- **B1 — Reorder & pin tiles within a group. ✅ Done (shipped reorder + cross-group move +
  pin).** A "Customise" edit mode on the hub (mirrors the widget board's affordance): drag
  (native HTML5 DnD, no dep) or arrow-key a tile to reorder within a group **or move it to an
  adjacent group** (scope widened from within-group per the developer), plus a per-tile **pin**
  that floats it to the top of its group. Ordering maths is the pure `dashboard-nav-order.ts`
  seam (reconcile / moveTile / nudgeTile / setTilePinned; invariant = stored order == display
  order, pinned-first per group); `useNavOrder` resolves the persisted `useLayoutStore.navTileOrder`
  intent against Modular UI gating + stale saved orders (unknown ids dropped, stale group reverts,
  new tiles append to their default group) and hands `DashboardNav` ready ordered groups + edit
  callbacks (mirrors `useNavCounts`). A hidden tile's placement is kept verbatim and merged back
  on write, so re-enabling its module restores it. Keyboard reorder, roles/aria, a live-region
  move announcement and reduced-motion are all wired.
  - **Deferred:** an always-present placeholder for a fully-emptied group. Today moving *every*
    tile out of a group removes its drop zone; it stays reachable by keyboard (arrow-left/right
    cycle all three groups) and by Reset, so recovery exists — a drop-zone-for-empty-group can
    land with **D1** (favourites/custom groups), which reworks the grouping surface anyway.
- **B2 — Density & columns control.** Compact vs comfortable tile density and a columns choice
  (2 / 3 / auto), as a Tier-2 preference. Coordinate with the large-format layout seam
  (`useLargeFormat`) so tablet/foldable widths still behave.
- **B3 — Per-card accent colour override.** Allow a user to recolour a tile from the decorative
  `loc-*` palette tokens (never raw literals), for personal colour-coding of their workflow.
  Store per-route; fall back to the group tint.
- **B4 — Hide a tile from the tile itself.** A per-card overflow menu (Foundry `Menu`) with a
  "Hide" action that writes Modular UI intent, so hiding is one click from the hub instead of a
  trip to the Modules screen. Keep an obvious path to re-show (Modules screen / first-run).

---

## C. Per-card content & quick actions

- **C1 — Hover/focus quick action.** An optional affordance on relevant tiles — "+ New project"
  on Projects, "+ Add item" / "Scan" on Inventory — turning the hub into a launcher. Must be
  keyboard reachable and not swallow the tile's own activation; toggleable so minimalists can
  switch it off.
- **C2 — Secondary metric / micro-sparkline.** An optional second line or tiny inline trend
  (e.g. Reports → 7-point stock-value trend, Inventory → "12 low" under the total). Off by
  default; reuse the existing report/aggregate hooks; the sparkline should honour reduced-motion
  and stay a static SVG (no animation on the hub).
- **C3 — Custom tile rename (display-only).** Let users relabel a tile ("Purchase orders" →
  "POs") without editing the `NAV_DESTINATIONS` SSOT — an overlay map of route → custom label,
  Tier-2 preference, falling back to the canonical label. Keep the accessible name in sync.

---

## D. Personalisation & organisation

- **D1 — Favourites / pinned row (or custom group).** A user-defined "Pinned" section at the top
  of the hub, or fully user-defined groupings, layered over the fixed `primary/manage/system`
  grouping. Builds on B1's per-device layout store.
- **D2 — Saved layout presets.** Named presets ("Kiosk", "Warehouse", "Admin") that snapshot
  visible tiles + counts + density and swap in one click. Complements the existing kiosk mode;
  presets are device-local.

---

## E. Inventory item cards

The same customisation theme applied to the item list/grid cards (a different component from the
nav tiles).

- **E1 — Configurable card fields + order. ✅ Done.** Users choose which attributes each item
  card/row shows and in what order via a **Settings → Inventory → "Card fields"** picker. The
  offered set is the built-ins **Location, Category, Condition, Total value, Quantity, Last
  updated** plus every category **custom field**; the shipped default shows Location + Category.
  The model is the pure `card-fields.ts` seam (built-in SSOT, `CardFieldsConfig` = ordered
  `{id,visible}[]`, resolve-on-read `normaliseCardFields`, reorder/visibility ops, and
  `resolveCardFields` → one label/value descriptor **per visible field** so a card's height is
  config-driven, never item-driven). The Tier-2 `cardFields` pref stores intent; the config is
  **shared** across the Visual card and Data row (per-view density stays **E2**). Custom-field
  *values* on cards use a bulk read (`CategoryRepository.listAllFields` + `getItemFieldValues`
  via `useItemFieldValues`) fetched only for the on-screen items and **only when a custom field
  is shown** (zero cost otherwise). The reorder/show-hide control is a new reusable Foundry
  primitive, **`ReorderList`** (keyboard-operable move/hide — the accessible 1-D counterpart to
  the widget board's drag affordance; **B1 should reuse it**).
- **E2 — Card ↔ compact-list ↔ table density + thumbnail size.** A view-density switch and a
  thumbnail-size control, persisted per device. Must not regress the virtualised list (fixed row
  heights per density; never entrance-animate the virtualised list).
- **E3 — Colour-code by category / location / condition.** An optional accent/stripe on each
  card driven by a chosen dimension, using `loc-*` / `cond-*` tokens (no raw literals). User
  picks the dimension; provide a clear legend.
- **E4 — Configurable status badges.** A user-selectable set of badges (low-stock, expiring,
  on-loan, incoming, …) shown on the card, reusing existing derived signals. Show/hide per badge
  type.
- **E5 — Inline quick-adjust + pin/favourite.** A compact +/- stock adjust directly on the card
  (writes through the existing mutation path with optimistic update) and a pin/favourite that
  floats chosen items to the top. Keyboard + `aria` first-class.
- **E6 — Per-view saved sort/group preset.** Save a card view's sort + grouping as a named
  preset the user can re-select, sitting alongside the existing search/filter state.

---

## Suggested starting points

Lowest-risk, highest-value first: **A1** (configurable count metric) and **B1** (reorder/pin
tiles) for the nav hub; **E1** (configurable card fields) for the item cards. Each is a
self-contained session.

## Working notes for whoever picks one up

- Confirm the exact metric/label set and the Settings placement with the developer before
  building A1/A3/C3 — these add user-facing preference surface area.
- Prefer extending `useNavCounts`' map/selector shape over branching in `DashboardNav` JSX, so
  the tile stays presentation.
- When a task introduces a new preference, wire both the store field (normalised, persisted) and
  the Settings row (`SettingRow` + `hint`) in one go, and cover it with a component test that
  mocks the store — matching the existing dashboard/settings test patterns.
