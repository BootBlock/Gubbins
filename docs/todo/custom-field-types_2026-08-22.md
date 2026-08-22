# Custom field types — what exists, what the presets need, what to add next (2026-08-22)

> **Status:** 🟢 ACTIVE — `COLOUR` has shipped and the preset colour fields are retyped onto
> it. The remaining candidates below (`C1`–`C8`) are open, in the order given.

Answers issue [#452](https://github.com/BootBlock/Gubbins/issues/452): *are there more
`Field type`s worth adding, do the built-in category presets use the right ones, and add a
`Colour` type that converts between colour notations.*

The `Colour` half is done. This document is the other half: the audit that decided **which**
types are genuinely missing, and what each one would cost, so the next increment starts from a
decision rather than from a fresh survey.

## Method

Every one of the 72 entries in [`category-presets.ts`](../../src/features/inventory/category-presets.ts)
was read field by field, and each field's declared type compared against what the field
actually holds. A type earns its place here only when a preset **already** wants it — the test
is "some real thing a user tracks is being stored badly today", not "other tools have this".

Reference for the shape of the work: [`weak-item-archetypes_2026-07-31`](weak-item-archetypes_2026-07-31.md),
whose `W1` strand added a custom `DATE` field's due dates, a `NUMBER`'s unit, range and decimal
places, and an actionable `URL`/`FILE` value. Those closed the *per-type settings* gap. This
document is about the *set of types* itself.

## What shipped: `COLOUR`

A colour is stored as one canonical lowercase `#rrggbb` (or `#rrggbbaa` with alpha), parsed
from any of: hex in 3, 4, 6 or 8 digits; `rgb()`/`rgba()`; `hsl()`/`hsla()`; `hsb()`/`hsv()`;
and the CSS/Web colour names (both `gray` and `grey` spellings). The conversions live in the
pure seam [`src/lib/colour.ts`](../../src/lib/colour.ts); the control is the Foundry
`ColourInput`, whose "Show as" menu re-renders the stored value in any of those notations.

**The decision that shapes everything else:** canonicalise **at save**, not at display. Two
users who enter the same colour by different routes then store the same string, so equality,
grouping and search work with no colour parser in the SQL. The cost is that `hsl()` and
`hsb()` are rendered at whole degrees and percent, so reading a colour back in one of those
and re-entering it can shift a channel by a shade. Storage is unaffected — the stored form is
always the hex.

`ON_OFF`-style aliasing was deliberately *not* used: there is one colour type, not a
`HEX`/`RGB` pair, because the notation is how a value is written, not what it is.

### Presets retyped onto it

`Clothing`, `Storage tote`, `Cable`, `3D Filament`, `Fabric`, `Crystals, minerals &
gemstones`, `Die-cast model cars` and `Handbags` each had a `Colour` field declared as `TEXT`;
all eight are now `COLOUR`. Two presets needed more than a retype:

- **Paint** kept `Colour name` as `TEXT` — a manufacturer's name for a shade ("Elephant's
  Breath") is not a colour value — and gained a separate `Colour` field for the colour itself.
- **Gridfinity bin** had one `Filament / colour` field conflating two facts. It is now
  `Filament` (`TEXT`) and `Colour` (`COLOUR`).

Two colour-shaped fields were deliberately **left alone**, because neither holds a colour:

- **Magic: The Gathering cards** → `Colour` is a `SELECT` of the game's five mana colours plus
  `Multicolour`/`Colourless`. That is a game mechanic wearing a colour's name.
- **Shoes / trainers / sneakers** → `Colourway` is the name of a multi-colour scheme ("Bred"),
  not a single colour.

## The candidates, in priority order

### C1 — `MULTI_SELECT`: several values from a defined list

**The strongest gap in the audit.** `SELECT` is single-choice only, so every preset that wants
"one or more of these" falls back to free text and loses the list, the validation and the
ability to filter by a member:

| Preset | Field | Today |
| --- | --- | --- |
| Food | `Allergens` | `TEXT` |
| Book, Movie | `Genre` | `TEXT` |
| Clothing, Handbags, Vintage quilts | `Material` | `TEXT` |
| Everyday Carry (EDC) gear | `Material` | `TEXT` |

The renderer is already built: `CardFieldValue` has a `tags` kind, drawn as a wrapping row of
chips.

**The design decision to settle first is the storage encoding.** Values are TEXT in
`item_field_values`, so a list has to be one string. A JSON array is unambiguous but shows as
JSON in a CSV export and in the `field:` search predicate; a delimiter is readable but needs a
rule for an option that contains it. Note that `field_defs.options` is *already* a JSON array
in its own column, so JSON is the consistent choice — but the CSV round-trip needs deciding
explicitly rather than inheriting.

### C2 — `MONEY`: an amount in a currency

Gubbins has money throughout (cost, current value, budgets), a `MoneyInput` primitive and a
currency preference — but a *custom* field cannot be money. So an "insured value", a "last
sold for", or a per-part price is a bare `NUMBER` that no total, no budget and no currency
conversion can see.

Cost is mostly in deciding whether such a field participates in the existing value roll-ups or
is inert. Inert is the smaller, safer first step.

### C3 — `DURATION`: a length of time

`Movie` → `Runtime (min)`, `Board games` → `Play time (min)`, `Adhesive` → `Cure time (min)`
are all `NUMBER` with the unit written into the field's *name*. A `NUMBER` with a unit (`W1b`)
already covers this adequately, so this is a polish item: the gain is entry as `1h 52m` and
display in the reader's preferred form, not new capability. **Low priority.**

### C4 — `EMAIL` and `C5 — PHONE`

A supplier contact, a warranty line, a repairer. `TEXT` stores them; what is missing is
validation and an actionable `mailto:`/`tel:` value. The `link` arm of `CardFieldValue`
already does the actionable half for `URL`, so the pattern exists. Two small types, or one
`CONTACT` type — decide which before building either.

### C6 — `BARCODE`

`Movie` declares `Barcode (UPC/EAN)` as `TEXT`, and Gubbins already has a scanner. A type that
offers "scan this" beside the box, and validates a UPC/EAN check digit, turns a transcription
into a scan. The value is in the *affordance*, not the storage.

### C7 — `TIME` / `DATETIME`

`DATE` has no time-of-day. Nothing in the current presets needs one, which is why this ranks
low despite being an obvious hole.

### C8 — `COUNTRY`

`Coin`, `Banknote`, `Stamps`, `Military surplus` and `Fossils` all keep a country or locality
as `TEXT`. A curated list would make them consistent and filterable, but it needs a translated
country list and a policy on historic states (a coin's country may not exist any more), which
is more decision than it first appears.

### Considered and rejected

- **`PERCENT`, `WEIGHT`, `TEMPERATURE`, `SLIDER`** — a `NUMBER` with a unit, a range and
  decimal places already expresses every one of these. Adding them would be four spellings of
  one type.
- **`RICH_TEXT`** — `LONG_TEXT` covers the need; formatting is a large surface for little gain.
- **`RELATION` (a link to another item)** — genuinely useful and genuinely out of scope for a
  field type: `item_relations` already exists and is its own feature, not a cell in a table.
- **`GEO` (coordinates)** — no preset wants one, and locations already model *where a thing is*.

## Other typing inconsistencies the audit found

These are not new types; they are presets disagreeing with each other. Worth a tidying pass,
but none of them loses data:

- `Grade` is `TEXT` in `Trading card`, `Coin` and `Baseball cards`, but `SELECT` in `Banknote`.
- `Weight` is a `SELECT` of quantity strings in `Gold & silver bullion`, and `NUMBER`
  everywhere else.
- No preset anywhere uses `BOOLEAN`; every yes/no is `ON_OFF`. That is consistent, so it is a
  question about whether the two types should both exist rather than a preset defect.
- `3D Filament` → `Diameter (mm)` is a `SELECT` of `1.75`/`2.85`. That is deliberate and
  correct: only two diameters are sold.

## Adding a field type: the touchpoints

Every one of these was exercised by the `COLOUR` change, so the list is current. The first
five stop compiling if missed; the rest fail silently.

**Compile errors:**

1. `FIELD_TYPES` in [`constants.ts`](../../src/db/repositories/constants.ts) — the SSOT.
2. The `validateFieldValue` switch in [`custom-fields.ts`](../../src/features/inventory/custom-fields.ts).
3. The `TypedFieldControl` switch.
4. `FIELD_TYPE_LABELS` in `inventory-ui.ts` (a total `Record<FieldType, string>`).
5. `FIELD_TYPE_MESSAGE` in `LookupReviewDialog.tsx` (a total `Record<FieldType, MessageKey>`),
   plus its `lookup.fieldType.*` key in **both** i18n catalogs.

**Silent unless handled:**

6. `customFieldValue` in `card-fields.ts` — an unhandled type falls through to plain text. A
   new `CardFieldValue` kind also needs an arm in `ItemCardFields.tsx`.
7. `commitsOnPick` in `LocationFieldsEditor.tsx` — a type whose value is set by something other
   than the text box it wires `onBlur` to never commits on a location.
8. The prose hint listing the types in `CategoryManagerDialog.tsx`.
9. `fd.field_type <> 'IMAGE'` in `parseASTtoSQL.ts` and in
   `CategoryRepository.listLocationFieldSearchText` — the "not text, don't index it" filters.
   `COLOUR` deliberately stays *in* both: a hex code is short, searchable text.
10. The `IMAGE` arms in `export-data.ts` and `catalog-import.ts` — the "cannot round-trip as a
    CSV cell" filters. `COLOUR` needs neither, and import gains the notation parsing for free
    because it routes through `validateFieldValue`.
11. The golden schema fixture `__fixtures__/schema-baseline.snapshot.json`. The SQLite CHECK is
    interpolated from `FIELD_TYPES`, so `v1-initial.ts` itself needs no edit — but the fixture
    must be regenerated, and the baseline fingerprint changes, so an existing developer
    database is refused at boot with `SCHEMA_STALE` and rebuilt. That is the intended
    pre-release upgrade path, not a defect.
12. `EXPECTED_CONTROL` in `TypedFieldControl.test.tsx` — a total record in a test file, so it
    fails at runtime rather than at compile time.
13. The **wiki** field-type list in
    [`Custom-Fields-and-Capabilities.md`](../wiki/Custom-Fields-and-Capabilities.md).

The bridge needs nothing: it treats `fieldType` as an opaque string throughout, with no enum in
its OpenAPI schema.
