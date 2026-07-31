# Category-scoped capability hiding — feasibility study & plan (issue #618)

> **Status:** ✅ COMPLETE — all four phases shipped. The verdict was **yes (scoped)**, and the
> three §6 decisions were settled as recommended: a populated section is shown with a note, the
> create form was brought in scope, and the contradictory-defaults case is flagged in the editor.
> §9 records where the delivered work deliberately departs from the plan below.

## The question

[Issue #618](https://github.com/BootBlock/Gubbins/issues/618) asks whether a **category preset**
should be able to hide *intrinsic* item fields and sections — the example being that an item in
the `Movie` category has no use for maintenance schedules — with the user able to override the
preset and bring a hidden section back.

## Summary — the verdict

**Yes, this is worth building** — but with three corrections to the shape the issue sketches:

1. **It belongs on the _category_, not the preset.** Presets are pure seed data that materialise
   into an ordinary category; a preset can only carry what `CreateCategoryInput` carries. Model
   it as another **category facet default** and let presets seed it exactly as they already seed
   `defaultTrackingMode` and `defaultWarrantyMonths`. Hand-made categories get it for free.
2. **Hide by _capability_, reusing `FeatureId` — do not invent a section vocabulary.** The item
   detail dialog's sections already carry an optional `feature?: FeatureId`, and the filter that
   consumes it is already the single, pure choke point. `FeatureId` is already a stable persisted
   enum with labels, descriptions and icons — everything a picker UI needs.
3. **The "override" the issue wants already exists.** Because the hidden set lives on the
   category, overriding a preset is just *editing the category* — the same escape hatch every
   other facet default already has. No second per-item intent layer is needed for v1.

The change is **cheap where it touches data and moderate where it touches UI**. The genuinely
open questions are behavioural, not structural, and are listed in §6.

## 1. Why the gap is real

Gubbins already answers *"I never use maintenance"* — that is [Modular UI](../wiki/Modular-UI.md):
`maintenance`, `warranty`, `batches`, `perishables`, `variants`, `kits`, `cycle-counts`,
`tags-attachments`, `custom-fields`, `location-photos`, `sales` and friends are all toggleable
capabilities ([`feature-registry.ts`](../../src/features/modules/feature-registry.ts)).

What it cannot answer is *"maintenance matters for my **Tools** but is noise on my **Movies**"* —
because the axis is **global and per-device**. A mixed inventory is exactly where that fails, and
a mixed inventory is exactly the case the issue raises. Turning `maintenance` off to de-clutter
Movies would also strip it from the power tools that genuinely need it.

So the gap is a **missing axis**, not a missing feature: the app can vary its surface by *device*
but not by *what kind of thing an item is* — even though the category already knows.

## 2. Why the category is the right carrier

An item has exactly one, nullable, `categoryId`
([`types/items.ts`](../../src/db/repositories/types/items.ts)), so a single category resolves the
question unambiguously — no merge or precedence problem between competing sources.

A category is *already* the carrier for per-category shape decisions — it holds six template
defaults plus a glyph today ([`types/categories.ts`](../../src/db/repositories/types/categories.ts)):

| Column | Effect |
| --- | --- |
| `default_tracking_mode` | soft-prefills the create form |
| `default_condition` | soft-prefills the create form |
| `default_warranty_months` | soft-prefills, derives an expiry at submit |
| `default_maintenance_basis` | **applied** after create as a `maintenance_schedules` row |
| `default_maintenance_interval_days` / `_usage` | the matching interval |
| `glyph` | the card watermark |

One more entry — "which capabilities this kind of thing doesn't have" — is the same idea, and
sits beside the ones it interacts with. Presets already seed all of the above through
`CategoryStarterSeed.category`, so seeding the hidden set needs **no change to the preset
materialisation path** (`applyCategoryStarterSeed` → `createCategory` → `addField`).

## 3. Why reuse `FeatureId` rather than name sections

The detail dialog builds its tabs in a pure, exported, already-unit-tested function,
`buildTabs(item, enabled)`
([`ItemDetailDialog.tsx`](../../src/features/inventory/components/ItemDetailDialog.tsx)), and
filters in exactly one place:

```ts
tabs
  .map((tab) => ({
    ...tab,
    sections: tab.sections.filter((s) => s.feature === undefined || enabled.has(s.feature)),
  }))
  .filter((tab) => tab.sections.length > 0);
```

`SectionDef.feature?: FeatureId` is already the declared gating vocabulary, and it already covers
the sections the issue cares about — Maintenance (`maintenance`), Asset details (`warranty`), Kit
(`kits`), Tags/Datasheets (`tags-attachments`), Capabilities + Custom fields (`custom-fields`),
Where it sits (`location-photos`).

**Sections have no ids.** They are keyed by `title` when rendered — and titles are user-facing
copy that will be translated. Persisting a hidden set keyed on titles is not an option, so the
alternative to reusing `FeatureId` is inventing a `SectionId` union and threading it through every
section. That would create a *second* vocabulary running parallel to the capability list, which
has to be kept in sync by hand — the failure mode this codebase already has too much of, in the
way adding one `FieldType` means finding and updating roughly six parallel lists. `FeatureId` is
explicitly documented
as "treat them like a public enum", is already persisted in device state, and already carries the
label, description and icon a picker needs.

**The cost of that choice, stated plainly:** sections that carry no `feature` today cannot be
hidden — Item details, Location, **Lifecycle**, the whole **Supplier & ops** tab, Related,
Substitutions, Images, and Activity. (Two more, Gauge setup and Test & calibration records, are
also untagged but gate on `item.trackingMode` instead, so they are already narrow.)

**Lifecycle** is the one that stings, and it undercuts the issue's own example: that section owns
expiry, batch and condition, so capability-only hiding would *not* strip the expiry date from a
`Movie` item — only the Maintenance and Asset-details sections beside it. Supplier & ops (reorder
points, dead-stock reporting, operational parameters) is the next-most obvious candidate.

The fix is to give those sections the right `feature` tag — which also makes them respond to
Modular UI, a benefit in its own right — not to build a parallel id space. That is phase 3, and
the Lifecycle case is why phase 3 is **not** optional polish: without it the feature only half
answers the case that prompted it.

## 4. Precedence, and the invariant that must hold

The rule is a strict narrowing:

```
visible(feature) = enabled.has(feature) && !category.hiddenCapabilities.has(feature)
```

A category must **never** be able to re-enable something the device has switched off, or the
Modules screen stops being the truth about what this device shows.

**Hiding is presentation-only and must never touch stored data.** The existing test suite already
asserts this contract for Modular UI ("gating hides UI, never touches stored data"), and the same
must hold here: a Movie item that carries a maintenance schedule keeps it, keeps syncing it, and
keeps raising its alerts. Hiding changes what you *see*, never what you *have*.

## 5. Cost

**Data layer — cheap, and mostly mechanical.** Migrations are a single squashed v1 baseline, so
there is no forward migration to write; the column goes into `CREATE TABLE categories` and the
schema snapshot is regenerated with `node scripts/regen-schema-snapshot.mjs`. Sync, backup and
restore need **no changes at all** — snapshot rows are read with `SELECT *` and the allowed column
set is read live from `PRAGMA table_info`, and `categories` is already in `SYNC_TABLES`, so a new
scalar column travels and merges under row-level LWW for free. The table-classification drift test
guards tables, not columns.

The touch-points are the ones the repository pattern demands: the baseline `CREATE TABLE`, the
snapshot regen, `CategoryRow`/`Category`/`CreateCategoryInput`/`UpdateCategoryInput`,
`rowToCategory`, and three spots in `CategoryRepository` — `create`'s INSERT list, one
`if (input.x !== undefined)` block in `update`, and (**easiest to miss**) the explicit column list
in `SELECT_WITH_FIELD_COUNT`, which is what the whole UI actually reads.

One real user-visible cost: the baseline fingerprint is derived from the schema, so changing it
moves `BASELINE_REVISION` and existing local databases hit the reset screen. That is the
documented pre-release behaviour, but it is a cost worth naming before choosing to spend it.

**UI layer — moderate.** A hidden-capability editor in `CategoryDefaultsSection`, an item-aware
gating read to sit beside `useFeature`, the sub-section gates that live *inside* editors rather
than in `buildTabs` (variants in `LifecycleEditor`, batches in `StockBreakdown`, the scan button
in `BarcodeField`), i18n for both `en.json` and `de.json`, and the wiki pages.

**Preset seeding — judgement, not code.** The library is 72 presets. Deciding what `Movie`,
`Coin` or `Fastener` should suppress is a per-preset editorial call, and a wrong default is worse
than no default because it hides something the user expected to find.

## 6. Open decisions

(a) and (c) gate phase 2; (b) gates phase 3.

**(a) What happens when a hidden section has data?** Hidden ≠ absent. An item can acquire
maintenance, batch or warranty data while its category hides it — via bulk edit, spreadsheet
import, sync from a device where it wasn't hidden, or the category's own
`default_maintenance_basis`. Silently hiding real data is the one outcome that would make this
feature a bug rather than a convenience. Options: always show a hidden section that has data
(with a note explaining why it is there), or keep it hidden behind a per-item "show hidden
sections" reveal — Modular UI's existing "module hidden" interstitial is the precedent for the
second. **Recommendation:** show it, with a note. Never hide non-empty data by default.

**(b) Is the create form in scope?** It is currently the sharper edge of the complaint and is
*already* inconsistent: `CreateItemDialog`'s Lifecycle tab renders Expiry date, Warranty (months),
Batch no. and Lot no. unconditionally, and the file contains **no** `useFeature` or
`useEnabledFeatures` call at all — so creating an item today shows warranty and batch fields even
with those modules switched off. That is a **pre-existing Modular UI gap, independent of #618**,
and probably deserves its own issue. Whether #618 fixes it or merely stops making it worse changes
the size of phase 3 substantially, because the create form has no section registry and its
Lifecycle panel is one monolithic grid that would need splitting into addressable groups first.

**(c) Minor, but decide it:** a category carrying both `default_maintenance_basis` *and* a hidden
`maintenance` capability is incoherent — it would auto-create a schedule on every new item and
then hide it. The category editor should refuse the combination, or clear one when the other is
set.

## 7. Phased plan

| Phase | Scope |
| --- | --- |
| **1** | Schema + seam. `categories.hidden_capabilities` (JSON array of `FeatureId`, nullable), the repository/type touch-points listed in §5, snapshot regen. Extend `buildTabs(item, enabled, hidden)` with the narrowing predicate and cover it in `ItemDetailDialog.buildTabs.test.tsx`. A pure resolver seam for `visible()` so precedence is tested once, not at each call site. No UI yet. |
| **2** | The editor. A capability multi-select in `CategoryDefaultsSection`, auto-saving like every other facet default, driven off `FEATURE_REGISTRY` so it can never drift from the capability list. Decisions **(a)** and **(c)** implemented. i18n for `en.json` **and** `de.json`. Wiki: `Custom-Fields-and-Capabilities.md` + a cross-reference from `Modular-UI.md`. |
| **3** | Reach — **not optional** (see §3: without it, Lifecycle stays unhidable and the `Movie` case is only half answered). Tag the currently-ungated sections (Lifecycle, Supplier & ops, Related, Substitutions) with their owning `FeatureId` so they respond to both axes. Push the narrowing into the in-editor sub-section gates. Decision **(b)** settled first — fix the create form here, or split it out as its own issue. |
| **4** | Preset seeding. Author a hidden set per preset, most conservatively for the presets where the win is clearest (`Movie`, `Book`, `Vinyl record`, the collectibles). Ship nothing speculative — an unhidden section is always recoverable by the user, a wrongly hidden one is confusing. |

## 8. What would make this a bad idea

Recorded so a later reader can re-test the verdict rather than inherit it:

- **If it makes the app feel unpredictable.** Two items side by side showing different sections,
  with no visible reason, is worse than clutter. The reveal path in decision (a) is what keeps
  this honest, and it is not optional.
- **If the preset defaults get opinionated.** The value is in the *mechanism*; aggressive
  out-of-the-box hiding turns a curated preset into a guessing game about where a field went.
- **If it becomes a permission system.** This is presentation only. The moment "hidden" starts to
  mean "cannot be set", it collides with [Roles & permissions](../wiki/Roles-and-Permissions.md),
  which is the subsystem that genuinely owns that question.

## 9. What shipped, and where it departed from this plan

Recorded because the sections above are the plan as *written*, not as *built* — a later reader
following §7 as a recipe would otherwise be misled.

**Settled as recommended.** (a) a section the category hides is shown anyway when it holds data,
carrying a note naming the category. (b) the create form was brought into scope. (c) a category
that both applies a maintenance schedule and hides the section shows a warning offering to stop
adding the schedule — the editor does not silently clear either half of the contradiction.

**Where phase 3 differs from §7.** The plan proposed tagging the ungated sections — Lifecycle,
Supplier & ops, Related, Substitutions — with an owning `FeatureId`. Only the Lifecycle case was
actionable, and not in that form:

- **Lifecycle is a composite**, not a section with one owner. It holds expiry (`perishables`),
  batch and lot (`batches`), variants (`variants`) *and* condition, which no capability gates.
  Tagging the section wholesale would have hidden condition along with the rest. The narrowing
  was therefore pushed **inside** the editor, per field, which is what makes the `Movie` case
  actually work — the expiry date disappears while condition stays.
- **Supplier & ops, Related and Substitutions were left ungated.** No registered capability owns
  them, and minting `FeatureId`s to create one would have widened the Modules screen's public,
  persisted vocabulary as a side effect of this issue. They remain hideable only by the device.

**Scope trimmed deliberately.** `sales` and `cycle-counts` are *not* hideable per category. Both
gate behaviour rather than an item-detail section — `sales` is a menu action, and a hidden
`cycle-counts` would imply an exclusion from stock takes that this presentation-only feature does
not deliver. `scanner`, `nfc`, `labels` and `scraping` are excluded as device concerns.

**Left undone, deliberately.** The Modules screen and the feature registry are still untranslated
English, so the picker shows translated chrome around English capability names. Converting
`FEATURE_REGISTRY` to `labelKey`/`descriptionKey` would touch the Modules screen, the cascade
modal, the module guard, first-run and their tests — a Modules-subsystem i18n conversion, not part
of this issue. Worth its own issue.
