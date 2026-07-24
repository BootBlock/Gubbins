# Volumetric locations — implementation plan (issue #457)

> **Status:** 🟢 ACTIVE — new feature; not yet started. Phase 1 (data + entry) is the first
> shippable slice; phases 2–5 build on it. Grounding analysis for the "why" lives on
> [issue #457](https://github.com/BootBlock/Gubbins/issues/457).

## Summary

Let a `Location` carry **physical dimensions** (width × height × depth) and, from those, a
**usable internal volume** — then use that volume as a first-class signal across the app:
honest *cube-utilisation* fullness (space consumed, not a naive item count), *will-it-fit*
checks when placing an item, and space-planning reporting. This closes a loop the codebase
already has both ends of: items already record `width`/`height`/`depth` in canonical
millimetres (issue #30, [items.ts](../../src/db/repositories/types/items.ts)), and locations
already drive a fullness gauge from a count-based `capacity`
([location-fullness.ts](../../src/features/inventory/location-fullness.ts)). The "demand" side
(space an item consumes) and the "supply" UI (a fullness bar) both exist — this plan adds the
"supply" measurement and teaches the existing seams to reason in volume.

The design deliberately **extends existing seams rather than adding a subsystem**: the same mm
canonical-storage discipline as item dimensions, the same `Fullness` shape the bar already
renders, the same soft at-capacity warning pattern the move flow already shows, and the same
per-location-override-defers-to-global-preference pattern as dead-stock days.

### Design principles

- **Optional and graceful.** Nobody measures every drawer. Every field is nullable; with no
  dimensions a location behaves exactly as today (count capacity, or no fullness at all). A
  location falls back down a ladder: volumetric → count → none.
- **Honest, not precise.** Raw bounding-box volume overstates real capacity (void space,
  irregular shapes, you can't pack to 100%). The model exposes an explicit **usable-volume
  override** and a **packing-efficiency factor**, and the utilisation UI always surfaces
  **measurement coverage** ("based on 12 of 15 items"), so a half-measured location never
  looks deceptively empty. Fit/over-volume checks are **soft heads-ups**, never hard blocks —
  mirroring today's at-capacity move warning.
- **Canonical units, presented at the edges.** Dimensions store in **mm** (reuse
  [lib/dimensions.ts](../../src/lib/dimensions.ts)); volume stores in **mm³** via a new
  `lib/volume.ts` mirroring it. Display/entry unit is a Tier-2 preference applied only at the
  edges — the stored number never changes when the preference does.
- **Direct-containment semantics, matching item counts.** A location's utilisation reflects
  items placed *directly* there, exactly as `location_item_counts` counts direct children — a
  cabinet's own utilisation is not an auto-rollup of its drawers. (A rolled-up "subtree" view
  is noted as a future option, not phase-1 scope.)

---

## 1. Data model

### 1.1 New columns on `locations`

Folded into the single squashed **v1 baseline** migration
([v1-initial.ts](../../src/db/migrations/v1-initial.ts)), immediately after the existing
`kind` / `capacity` / dead-stock ALTERs (~line 1453), mirroring the item-dimension block at
line 1391. Pre-release, so we fold into v1 and regenerate the baseline snapshot rather than
adding a v2 (see memory `migration-baseline-squashed`).

| Column | Type | Meaning |
| --- | --- | --- |
| `width` | `REAL CHECK (width IS NULL OR width >= 0)` | Internal width, **canonical mm**. NULL = not recorded. |
| `height` | `REAL CHECK (height IS NULL OR height >= 0)` | Internal height, **mm**. |
| `depth` | `REAL CHECK (depth IS NULL OR depth >= 0)` | Internal depth, **mm**. |
| `usable_volume` | `REAL CHECK (usable_volume IS NULL OR usable_volume >= 0)` | Optional explicit usable capacity, **canonical mm³**. Overrides the W×H×D product for irregular containers (a bag, a cabinet with framing). NULL = derive from W×H×D. |
| `packing_factor` | `REAL CHECK (packing_factor IS NULL OR (packing_factor > 0 AND packing_factor <= 1))` | Optional per-location packing efficiency (fraction of raw volume realistically fillable). NULL = defer to the global `defaultPackingFactor` preference. |

Rationale for **both** `usable_volume` and `packing_factor` — they are orthogonal and both
serve "as flexible as possible":

- `usable_volume` corrects the **geometry** — the container is not a perfect box (a bag, a
  bin with sloped walls, a shelf with a lip). It is an absolute measurement.
- `packing_factor` corrects the **packing inefficiency** — even a perfect box can't be filled
  to 100% because items are rigid and leave voids. It is a ratio.

**All five columns land together in Phase 1's single migration edit** — touching the squashed
baseline twice is worse than shipping two inert columns early. But the *entry UI* splits: Phase
1 surfaces only the three W×H×D fields; the `usable_volume` / `packing_factor` inputs (an
"Advanced" disclosure so the common case stays three fields) arrive in Phase 2, where they
first do something. Until then the columns simply sit NULL.

### 1.2 Domain types

[types/locations.ts](../../src/db/repositories/types/locations.ts) — extend `LocationRow`
(snake_case, canonical) and `Location` (camelCase), plus `CreateLocationInput` /
`UpdateLocationInput`, exactly mirroring how the item types carry `width`/`height`/`depth`:

```ts
// LocationRow / Location
readonly width: number | null;          // internal width, canonical mm
readonly height: number | null;         // internal height, canonical mm
readonly depth: number | null;          // internal depth, canonical mm
readonly usableVolume: number | null;   // explicit usable volume override, canonical mm³
readonly packingFactor: number | null;  // 0<f≤1 packing efficiency, or null = use global pref
```

`Create/UpdateLocationInput` take the same fields as optional/nullable (omit = leave
untouched, null = clear), matching the item editor's clear-vs-untouched discipline.

### 1.3 Mapper

[mappers.ts](../../src/db/repositories/mappers.ts) `rowToLocation` — pass the five new columns
through (REAL columns are already `number | null` off the driver; no coercion needed, same as
the item mapper does for `width`/`height`/`depth`).

### 1.4 Repository

[LocationRepository.ts](../../src/db/repositories/LocationRepository.ts):

- **`SELECT_WITH_COUNT`** — add the five columns to the explicit projection (it enumerates
  columns rather than `SELECT *`; a new column is invisible to the tree/list until listed
  here — same trap the dead-stock note calls out).
- **`create` / `update`** — thread the new fields through the INSERT column list and the
  `sets`/`params` builder, exactly as `capacity` is threaded today.
- **Normalisers** — add `normaliseDimension` (non-negative finite REAL, else NULL — the mm
  columns are REAL not INTEGER, so *don't* `Math.floor` like `normaliseCapacity` does) and
  `normalisePackingFactor` (clamp to `(0, 1]`, else NULL). `usable_volume` reuses the
  dimension normaliser (non-negative REAL).
- **`createPath`** — the branch shortcut already spreads `...input` onto each leaf, so leaves
  inherit dimensions for free; confirm the intermediate bare-ancestor create doesn't carry
  them (it shouldn't — ancestors are structural).

### 1.5 Sync / backup / snapshot

- The snapshot **column dictionary is schema-derived** (`buildSchemaDictionary` reads live
  `PRAGMA table_info`, and `requireColumns` refuses any hand-picked fallback —
  [snapshot.ts:408](../../src/features/sync/snapshot.ts)). New REAL columns therefore flow
  into backup/sync automatically once they exist in v1; there is **no** hand-maintained column
  list to update. Verify with the snapshot-integrity test (§6).
- These are plain **LWW per-row** fields — no CRDT/delta handling (unlike the gauge net-value
  in [delta-crdt.ts](../../src/features/sync/delta-crdt.ts)). A location's dimensions converge
  by newest-write, which is correct.
- **Do not** bump `package.json` `schemaVersion` — that is the app↔bridge *wire* generation,
  not the DB schema (memory `pwa-update-schema-safety`). Adding nullable columns to the v1
  baseline is a data-safe change; `baselineRevision` auto-derives.
- **Operational consequence of folding into v1:** an existing pre-release DB that already
  applied v1 will *not* re-run the migration, so it will be missing the new columns and throw
  `no such column` on the location reads until it is wiped/reset — the expected reset flow for a
  baseline change pre-release (memories `migration-baseline-squashed`,
  `stale-local-db-missing-baseline-column`). Regenerate the baseline schema snapshot in the
  same change so the drift test stays green.

---

## 2. Units, formatting & preferences

### 2.1 Dimensions — reuse what exists

Location W×H×D entry/display reuses [lib/dimensions.ts](../../src/lib/dimensions.ts) verbatim
(`toMm`/`fromMm`/`formatDimension`, the `dimensionUnit` Tier-2 pref) and the item editor's
field helpers (`measure-draft.ts`'s `resolveMeasureDraft`, and the `dimensionToInput`
round-trip-trim helper — lift the latter out of
[ItemDetailsEditor.tsx](../../src/features/inventory/components/ItemDetailsEditor.tsx) into a
shared module, e.g. `features/inventory/measure-input.ts`, so both editors share one
implementation instead of duplicating it).

### 2.2 Volume — new `lib/volume.ts` (mirrors `lib/dimensions.ts`)

Volume needs its own unit seam because mm³ is unreadable (a 30 cm drawer is 27,000,000 mm³).
Side-effect-free, no `./format` import (so the reactive formatter bundle can depend on it),
mirroring the dimensions module by design:

```ts
export type VolumeUnit = 'mm3' | 'cm3' | 'l' | 'm3' | 'in3' | 'ft3';
// canonical storage is always mm³; MM3_PER_UNIT conversion table (1 l = 1e6 mm³, 1 m³ = 1e9,
// 1 in³ = 16387.064, 1 ft³ = 28316846.592). toMm3 / fromMm3 / normaliseVolumeUnit.
export function volumeFromDimensions(w, h, d): number | null; // null unless all three present
export function formatVolume(mm3, unit, locale): string;      // '—' for non-finite, like the others
export function autoVolumeUnit(mm3, system: 'metric' | 'imperial'): VolumeUnit; // pick a readable unit
```

`autoVolumeUnit` picks a human-scaled unit adaptively (a drawer → litres or in³, a warehouse
bay → m³ or ft³) so nothing renders as `0.0000027 m³`. A dedicated `lib/volume.test.ts`
asserts round-trips, the formatter, and the auto-unit thresholds.

### 2.3 Preferences (Tier-2, via `usePreferencesStore` + a Settings row)

Follow the const→pref pattern with `*_BOUNDS` clamp helpers (memory
`phase-46-scope-decisions`) and register each in
[settings.ts](../../src/features/settings/settings.ts) /
[SettingsDialog.tsx](../../src/features/settings/SettingsDialog.tsx) as a `SettingRow`
(memory `settings-dialog-and-rail-modal`):

- **`volumeUnit`** — `'auto' | VolumeUnit`. Default `'auto'` = derive from `dimensionUnit`
  (metric families → litres/cm³, imperial → ft³/in³) via `autoVolumeUnit`. Lets a user pin a
  fixed unit if they prefer. Add a "Volume unit" control beside the existing "Dimension unit"
  one.
- **`defaultPackingFactor`** — the global fallback when a location leaves `packing_factor`
  NULL. Bounds `(0, 1]`, default `1.0` (trust the raw usable volume; opt into a haircut
  rather than imposing one). Reuse the clamp-on-read discipline so a stale persisted value
  can never break utilisation maths (memory `persisted-state-reconcile-on-read`).

### 2.4 Formatters

[useFormatters.ts](../../src/lib/useFormatters.ts) — add a reactive `volume(mm3)` formatter
(and confirm/expose `dimension(mm)` if not already) that reads `volumeUnit` (resolving
`'auto'`) + `locale`. Component tests that mock `useFormatters` must add the new key (memory
`foundry-money-control` gotcha: an incomplete formatter mock breaks unrelated renders).

---

## 3. Fullness upgraded: cube utilisation (the headline)

### 3.1 Pure seam — extend `location-fullness.ts`

Keep the existing count-based `locationFullness` / `isLocationFull` untouched (many call
sites) and **add** a volumetric layer returning the *same* `Fullness` shape so
[LocationFullnessBar.tsx](../../src/features/inventory/components/LocationFullnessBar.tsx)
renders it with zero change:

```ts
export interface VolumetricFullness extends Fullness {
  readonly usedVolume: number;      // Σ (item volume × qty-here), canonical mm³ (measured items only)
  readonly capacityVolume: number;  // effective usable volume after packing factor, mm³
  readonly coverage: number;        // 0–1: share of on-hand *units here* whose volume is known
  readonly measuredItems: number;   // distinct items here with all three dims (for the caption)
  readonly totalItems: number;      // distinct items present here (for the caption)
}

// effective capacity = (usableVolume ?? width*height*depth) * (packingFactor ?? globalDefault)
export function locationCapacityVolume(loc, globalPackingFactor): number | null;
export function itemVolume(item): number | null; // width*height*depth, or null if any missing
export function locationVolumetricFullness(
  contents: readonly { volume: number | null; quantity: number }[],
  capacityVolume: number | null,
  globalPackingFactor: number,
): VolumetricFullness | null;
```

`used = Σ (volume × quantity)`, where **`quantity` is the units of that item held *at this
location*** — read from the per-location stock ledger `item_stock.quantity` (Phase 25 SSOT),
**not** `items.quantity` (which is the grand total spread across every placement). A location's
used volume must reflect only the stock physically sitting there, exactly as
`location_item_counts` counts direct placements. `percent` clamps 0–100 and `over` reports the
true overflow, as the count version does. `coverage` is **unit-weighted** — measured units ÷
total units here — so one unmeasured but high-quantity item drags coverage down honestly; the
`measuredItems`/`totalItems` *item* counts drive the human-readable "N of M items" caption.

### 3.2 The resolver — pick the honest mode

A single `resolveLocationFullness(location, contents, globalPackingFactor)` chooses the ladder:

1. **Volume mode** when the location has an effective capacity volume **and** coverage clears
   a floor (e.g. ≥1 measured item) — returns `VolumetricFullness`.
2. **Count mode** — existing `locationFullness(itemCount, capacity)`.
3. **null** — no notion of fullness.

Feeding it needs each location's contents' volumes. Add a repository read that returns, per
location, the summed measured volume and the measured/total unit split (a bounded aggregate
over the location hierarchy, joined to `item_stock`/`items` — keep it cache-friendly like
`location_item_counts`; if per-location volume proves hot, a trigger-maintained
`location_volume_totals` cache is the escalation, but start with the aggregate). This is the
one genuinely new query and the main effort of Phase 2.

### 3.3 Wiring

- [LocationInfoCard.tsx](../../src/features/inventory/components/LocationInfoCard.tsx) and the
  Edit-location dialog's metadata block — the bar switches to volumetric when available; add a
  caption showing `usedVolume / capacityVolume` (formatted) and, when `coverage < 1`, a muted
  "based on N of M items measured" note so the number is never read as exact.
- [LocationTreeItem.tsx](../../src/features/inventory/components/LocationTreeItem.tsx) sidebar
  fill bar — same `Fullness`, so it upgrades automatically once fed the volumetric value.
- All colours stay tokens (`bg-primary` / `bg-destructive`, `text-muted-foreground`,
  `text-warning`); no raw literals (CLAUDE.md design-token rule).

---

## 4. Fit-checking on placement (second headline)

### 4.1 Pure seam — `features/inventory/box-fit.ts`

```ts
// Orientation-aware: a box fits inside another (axis-aligned, any 90° rotation) iff its sorted
// dimensions are each ≤ the container's sorted dimensions. Necessary AND sufficient for
// axis-aligned rotation — the standard result.
export function boxFitsIn(
  item: { width: number; height: number; depth: number },
  location: { width: number; height: number; depth: number },
): boolean;
export function wouldExceedVolume(usedVolume, capacityVolume, addingVolume): boolean;
```

Both are approximations by nature (measurements are rough; true multi-item packing is
NP-hard), so they drive **soft heads-ups only**. We deliberately model **only axis-aligned
orientations** (the 6 face-rotations) — no diagonal tilting — which is the conservative,
predictable answer a user wants for "does this go in the drawer". Unit-tested with a
`box-fit.test.ts` covering: fits only after a 90° rotation (item wider than the box on one
axis but not another), the sorted-dimension equality edge (exact fit), and a clear no-fit.

### 4.2 Wiring — reuse the existing soft-warning pattern

The Location facet of the item detail dialog
([LocationEditor.tsx](../../src/features/inventory/components/LocationEditor.tsx)) already
shows a non-blocking `text-warning` heads-up when moving to an at-capacity location. Extend
that exact pattern (don't invent a new one) to also warn when:

- the item's bounding box **won't fit** the destination's internal dimensions
  (`boxFitsIn` false, only when both item and location have full dimensions), and/or
- the move would push the destination **over its volume** capacity.

Apply the same to the standalone **Move** dialog, the **Add-item** dialog's location picker,
and the placement picker
([PlacementPickerDialog.tsx](../../src/features/inventory/components/PlacementPickerDialog.tsx)).
The warnings are advisory — the move/add always proceeds (measurements are optional and
approximate; blocking would punish incomplete data).

---

## 5. First-class reach across the app

Each of these is a distinct, independently-shippable tie-in (Phase 4), turning the data from
"a field on the edit form" into a feature woven through the app. **Every user-visible item
here updates the wiki in the same change** (CLAUDE.md wiki rule) and routes all strings
through `t()` in both `en.json` and `de.json` (CLAUDE.md i18n rule).

1. **Location dimensions/volume in the info & edit UI** (Phase 1/2) — a "Dimensions" field
   group in [CreateLocationDialog.tsx](../../src/features/inventory/components/CreateLocationDialog.tsx)
   and the location editor, with a live derived-volume preview ("≈ 12.5 L") and the Advanced
   disclosure for usable-volume / packing-factor. Each field is a `FormField` with an
   `InfoHint` (register hints in
   [location-field-help.ts](../../src/features/inventory/components/location-field-help.ts)),
   `mb-field-gap` spacing, numeric `Input`s — all Foundry primitives, no bodges.
2. **Space-utilisation report** — a new report (or column set) in
   [features/reports](../../src/features/reports): cube-utilisation % per location, free
   volume remaining, fullest/emptiest locations, and total measured-volume coverage. Slots
   into the existing report registry and the `tabular-export` seam.
3. **Dashboard widget** — a "Storage space" widget in
   [widgets.tsx](../../src/features/dashboard/widgets.tsx) (`DASHBOARD_WIDGETS` registry):
   overall utilisation and the top-N fullest locations. Its `en.json` title must stay
   byte-identical to the registry `title` (the catalog-drift test enforces this — memory
   `i18n-typed-catalog-seam`).
4. **Location list export** — add width/height/depth/volume/utilisation columns to the
   locations tabular export (memory `tabular-export-seam`).
5. **Search facets** — item search already exposes `width:`/`height:`/`depth:`
   ([fields.ts:29](../../src/features/search/fields.ts)); add location-oriented facets for the
   location sidebar/search (e.g. filter to `full` / `over` / low-`coverage` locations) via the
   existing AST seam — build the AST, never hand-build SQL (memory `phase-47-scope-decisions`).
6. **Insurance / moving schedule** — [insurance-schedule.ts](../../src/features/reports/insurance-schedule.ts)
   gains a total-contents-volume figure per location (moving-van / storage-unit estimation is
   the natural user story for a home-inventory audience).
7. **Location labels** (optional/minor) — offer dimensions on the printed location label
   ([PrintLocationLabelDialog.tsx](../../src/features/inventory/components/PrintLocationLabelDialog.tsx)).

---

## 6. Testing

- **Unit (pure seams):** `lib/volume.test.ts` (conversions, formatter, auto-unit);
  `location-fullness.test.ts` extend with volumetric mode, coverage, over-capacity, the
  mode-selection ladder; `box-fit.test.ts` (rotation cases + equality edge);
  normaliser tests in the repository suite.
- **Repository:** `LocationRepository.test.ts` — create/update round-trips the five fields;
  normalisation clamps (negative → null, packing factor out of `(0,1]` → null, blank → null);
  `createPath` leaves carry dimensions, ancestors don't.
- **Component:** location create/edit dialog shows, validates and saves dimensions + advanced
  fields; the derived-volume preview updates; the fullness bar switches count↔volume and shows
  the coverage caption; the placement warnings appear only with full dimensions and never
  block. Follow the Foundry test gotchas (mock every hook incl. the new `volume` formatter;
  click-open Selects; `waitFor` async RHF — memory `component-test-gotchas`).
- **Sync/backup:** snapshot-integrity + backup-format tests confirm the new columns
  round-trip (schema-derived dictionary), and that CHECK constraints reject bad values on
  restore. Run `npm run smoke:bridge` if any bridge-imported module changes (none expected,
  but the DB layer is bridge-adjacent).
- **i18n:** catalog + drift tests are build-enforced — every new key lands in `en.json` and
  `de.json` with a real translation and preserved `{placeholders}`.
- **Docs:** `src/lib/docs-todo-status.test.ts` enforces this plan's status banner; flip to
  `✅ COMPLETE` and `git mv` into `done/` when the feature ships (memory
  `docs-todo-status-convention`).
- **Runtime:** drive the real app with the `verify` skill for each user-visible phase (enter a
  location's size, see utilisation flip to volume, trigger a fit warning) — types alone don't
  prove the wiring.

## 7. Wiki

Per the CLAUDE.md wiki mandate, update [docs/wiki](../wiki) in the same change as each
user-visible phase: the Locations page(s) gain a "Dimensions & space" section (recording a
container's size, what usable-volume/packing-factor mean, how utilisation and fit-warnings
read), with a regenerated screenshot via `scripts/wiki-screenshots.mjs` using synthetic data
only. Add the space-utilisation report and the storage-space dashboard widget to the page map
in [docs/todo/wiki_2026-07-11.md](wiki_2026-07-11.md). Run `npm run wiki:check`.

---

## 8. Phasing

Each phase is independently shippable, verified, review-clean (`/code-review high`), and
merged `--no-ff` from its own worktree (CLAUDE.md). Wiki + i18n travel *with* the phase that
introduces the user-visible surface.

| Phase | Scope | Ships |
| --- | --- | --- |
| **1 — Data & entry** | All five schema columns (in one migration edit), types, mapper, repository (+normalisers, `SELECT_WITH_COUNT`), `lib/volume.ts`, `volumeUnit` pref + formatter, shared `measure-input.ts`, location create/edit dialog **W×H×D** fields + derived-volume preview, i18n, wiki. | "You can record a location's size and see its volume." |
| **2 — Cube utilisation** | Volumetric `location-fullness` layer + resolver + coverage, per-location volume-totals read, `defaultPackingFactor` pref, the **Advanced** disclosure (usable-volume / packing-factor inputs), wire LocationInfoCard / tree bar / edit dialog with coverage caption. | The honest fullness headline. |
| **3 — Fit-checking** | `box-fit.ts` + `wouldExceedVolume`, soft warnings in LocationEditor / Move / Add-item / placement picker. | "Will it fit?" heads-ups. |
| **4 — First-class reach** | Space-utilisation report, storage-space dashboard widget, location export columns, search facets, insurance/moving volume, (optional) label dimensions. | Woven through reports, dashboard, search, export. |
| **5 — Polish** | Adaptive-unit tuning, empty/edge states, docs pass, screenshot refresh; consider the rolled-up subtree-utilisation view if wanted. | Finish. |

## 9. Open questions / deferred

- **Subtree roll-up.** Phase 1–4 use direct-containment utilisation (matching `itemCount`).
  A "cabinet shows the sum of its drawers" rolled-up view is a real feature (needs a recursive
  volume aggregate and a clear UI to distinguish direct vs. rolled-up) — deferred to Phase 5
  as an option, with a concrete target rather than dropped (memory
  `feedback-deferred-work-tracking`).
- **Bin-packing / cartonization** ("which items fit together in box X", "suggest a home").
  Genuinely valuable but leans on NP-hard approximation and a heavier UI; **out of scope**
  here — record as a follow-up issue if wanted, don't smuggle it in.
- **Dimensional (DIM) shipping weight.** Volume × carrier divisor for postage estimation —
  a natural future tie-in once contents-volume exists; note, don't build.
- **Packing-factor default.** Ships at `1.0` (no haircut) so the feature never silently
  understates capacity; revisit whether a gentler default (e.g. 0.7) is a better first
  impression once real usage exists.
