# Category presets — research into what the library is still missing

> **Status:** 🟢 ACTIVE — research complete; no presets implemented yet. Tier 1 (12 presets) and
> the two new picker sections are the next slice of work. The shared-field-name defect §3 reports
> is a separate piece of work, filed and fixed on its own.

Issue [#443](https://github.com/BootBlock/Gubbins/issues/443) asks two things: what *new*
`Category` presets are worth adding to `CATEGORY_PRESETS`, and what custom fields each one should
carry. This document answers both, records what the existing library already covers so nothing is
proposed twice, and states the rules a candidate has to satisfy before it earns a place.

Nothing here is implemented. It is a shopping list, ordered so that the first slice can be taken
on its own. §3 is the exception: it records a defect in the *existing* library that the research
turned up, and that any new preset has to be written around.

## 1. What the library already holds

`src/features/inventory/category-presets.ts` ships **72** presets across the seven sections
declared in `PRESET_SECTION_IDS`. The distribution is heavily skewed:

| Section | Presets | What is covered |
| --- | ---: | --- |
| `collectibles` | 47 | Cards, coins, banknotes, watches, figures, militaria, minerals, stamps, silver, ceramics, sneakers, bullion, and much else besides |
| `media` | 7 | Book, Movie, Blu-rays, DVDs, Vinyl record, Video games (physical), Vintage movie posters |
| `workshop` | 4 | Tools, Fastener, Adhesive, Wood stock |
| `containers` | 4 | Tool bag, First aid kit, Storage tote, Gridfinity bin |
| `crafts` | 4 | 3D Filament, Fabric, Paint, Model kit |
| `electronics` | 3 | Battery, Electronic component, Cable |
| `household` | 3 | Food, Clothing, Vintage kitchenware |

Two-thirds of the library serves one section. A user who opens the picker to set up a *house* —
appliances, a car, the medicine cabinet, the garden — finds almost nothing, while a user
cataloguing snow globes is spoilt for choice. **Correcting that imbalance is the point of this
research**, and it is why almost every candidate below lands outside `collectibles`.

Two further observations from reading the existing entries:

- **The collectibles set is genuinely saturated.** A sweep of the usual "most collected things"
  lists turns up very little the library does not already have. The handful of real omissions are
  in tier 3 below, and none of them is urgent.
- **The `media` set is disc-shaped.** It covers physical video thoroughly and everything else
  thinly: no music CD, no cassette, no sheet music, no tabletop RPG book, no jigsaw puzzle.

## 2. What makes a candidate worth shipping

The existing library sets an implicit bar. Making it explicit, a candidate has to clear all five:

1. **The item is common.** Enough Gubbins users own one that the preset will be picked. A preset
   nobody imports still costs picker space and search noise for everyone.
2. **The preset saves real work.** The value is the field set, not the name. If the item needs
   nothing beyond the built-in facets (name, quantity, location, condition, purchase price), a
   preset adds nothing — the user should just create a plain category.
3. **The fields are the ones a person actually records**, not the ones a specification sheet
   lists. `Yarn` wants `Dye lot`, because a knitter who mixes dye lots gets a visible stripe. It
   does not want `Twist direction`.
4. **It is generic and brand-free.** Public-repo hygiene: no brand names, no product-specific
   values, no real URLs (`Funko Pop figures` and `Magic: The Gathering cards` are the pre-existing
   exceptions, where the brand *is* the category).
5. **It does not duplicate an existing preset**, and its field names do not collide with the
   library's — see §3, which is a harder constraint than it looks.

Beyond the bar, the strongest candidates **exercise a category facet the library has never used**.
Three are untouched across all 72 presets:

- **`defaultMaintenanceBasis` / `defaultMaintenanceIntervalDays` / `…IntervalUsage`** — no preset
  sets any of them, so every user wires a service schedule by hand. `Appliance`, `Vehicle`,
  `Filters & consumables` and `Garden machinery` all have an obvious, correct default.
- **A `DATE` field's `dueLeadDays`** — the whole opt-in that turns a date into a deadline
  (`FIELD_DUE_LEAD_DAYS_MIN` in `src/db/repositories/constants.ts`). No preset sets it either,
  even though `Expiry date` already appears in several. An expiry, a service date or a certificate
  renewal is precisely what it was built for.
- **A `NUMBER` field's `unit`** — also unused. Every numeric preset field instead bakes the unit
  into the name (`Capacity (mAh)`, `Spool weight (g)`). New presets below follow the existing
  spelling for consistency, but converting the library to `unit` is a worthwhile separate change.

`hiddenCapabilities`, by contrast, is already well used: 28 of the 72 presets set it. Twenty-seven
of those start from `['maintenance', 'batches', 'perishables']` on a collectible, 13 of which also
add `'kits'`; `Food` is the odd one out at `['maintenance']`. New presets should keep that up.

## 3. One constraint governs every field name (and the library already breaks it)

A custom field is **not** owned by its category. `CategoryRepository.addField` looks the name up in
the shared `field_defs` dictionary, and:

- **A name reused with a different `fieldType` is rejected outright** — a `DbError` reading *"The
  field X already exists as a Y field."*
- **A name reused with the same type silently reuses the existing definition, options and all.**
  `dueLeadDays`, `unit`, the bounds and `prominence` are applied on reuse; **`options` are not.**
  The first definition's option list wins, permanently and invisibly.

Both consequences land on presets, because a preset import is just a create-category plus a run of
`addField` calls. So:

> **A `SELECT` field's name must be as specific as its option list is.** `Storage`,
> `Form factor`, `Speed`, `Form` and `Weight` are all names two different domains want, with two
> different option lists, and the second one to be imported quietly gets the first one's options.

**The existing library already breaks this in both directions.** Eight names carry two *types*, so
the two presets holding them are mutually exclusive today — importing the second throws part-way,
leaving a half-populated category behind:

| Field name | Types in the library |
| --- | --- |
| `Colour` | `COLOUR` (10 presets) and `SELECT` (Magic: The Gathering cards) |
| `Material` | `TEXT` and `SELECT` |
| `Edition` | `TEXT` and `SELECT` |
| `Type` | `TEXT` and `SELECT` |
| `Grade` | `TEXT` and `SELECT` |
| `Region` | `TEXT` and `SELECT` |
| `Scale` | `TEXT` and `SELECT` |
| `Size` | `TEXT` and `SELECT` |

And the silent half is already happening too: **`Metal` is a `SELECT` in three presets with three
different option lists** (Coin; Copperware & brass ornaments; Gold & silver bullion), and **`Form`
is a `SELECT` in two** (Gold & silver bullion; Wood stock). Whichever is imported first decides
what the other's dropdown offers, permanently and with no error.

**This is a bug, not a wart, and it should be filed and fixed separately from adding presets.** The
fix is per-name — either settle on one type and one option list, or make the losing name specific
(`Card colour`, `Case material`, `Print edition`, `Bullion metal`, `Timber form`). It also wants the
test the situation is asking for: a unit test over `CATEGORY_PRESETS` asserting that every field
**name** maps to exactly one `fieldType` across the whole library, and that two presets declaring
the same `SELECT` name declare the same options. That test fails today on both counts, which is the
point of writing it.

Every field set proposed below was checked against all 224 distinct field names in the library, and
against the other proposals, for both failure modes. It introduces **no** new type conflict and no
new silent option capture; where a natural name was already taken by a different option list, the
proposal uses a more specific one and says so.

## 4. Two new sections are needed

Four tier 1 candidates do not fit any existing section without distorting it. Adding a section is
cheap in code and not free in copy: `PRESET_SECTION_IDS`, the `SECTION_LABEL_KEY` map in
`CategoryPresetPicker.tsx`, and a translated label in **every** catalog (`en.json` *and*
`de.json` — the catalog tests enforce full coverage).

| New section | Tier 1 members | Later candidates (§7) | Why not an existing section |
| --- | --- | --- | --- |
| `home-garden` | Seeds, Plant | Garden chemicals, Garden machinery, Camping gear | `household` reads as *indoors*, and a lawnmower filed under "Household" is a poor fit. Tier 1 already adds four presets to `household`; putting the garden there too turns it into the catch-all section |
| `vehicle` | Vehicle, Vehicle part | Tyres | Nothing in the taxonomy covers a car, and `workshop` means the bench, not the driveway |

Both sections ship with two presets, which is enough for the test suite (a section must not be
empty) and enough for the rail to read as a real category. "Fluids & lubricants" is deliberately
absent: §7 has not settled whether it belongs here or in `workshop`, and this table is not the
place to decide it.

A third grouping — `health`, for `Medication`, supplements and PPE — is **not** recommended yet.
Three presets is a thin section, and a sparsely populated rail entry looks broken. Put `Medication`
in `household` for now, and revisit if the health set grows.

## 5. Tier 1 — the twelve to ship first

These are the presets a general-purpose home inventory is most visibly missing. Field types are the
real `FIELD_TYPES` values from `src/db/repositories/constants.ts`.

### 5.1 `appliance` — Appliance (`household`, 🧺)

The consumer home-inventory and insurance checklists consulted all list appliances prominently, and
an appliance's details are among the hardest to find when they are wanted: the filter size, the
warranty expiry, the model number behind the machine. Serialised, warranted, maintained.

- Category defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultCondition: 'GOOD'`,
  `defaultWarrantyMonths: 24`, `defaultMaintenanceBasis: 'TIME'`,
  `defaultMaintenanceIntervalDays: 365`.
- Fields: `Manufacturer` (TEXT, reuses the existing definition), `Model number` (TEXT, reuses),
  `Serial number` (TEXT, reuses), `Appliance type` (SELECT — Fridge/freezer, Washing machine,
  Dishwasher, Oven/hob, Microwave, Tumble dryer, Boiler, Air conditioner, Vacuum, Other),
  `Installed on` (DATE), `Consumable part` (TEXT), `Energy rating` (TEXT), `Manual` (URL),
  `Service record` (LONG_TEXT).

### 5.2 `vehicle` — Vehicle (`vehicle`, 🚙)

- Category defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultMaintenanceBasis: 'USAGE'`,
  `defaultMaintenanceIntervalUsage: 10000`.
- Fields: `Make` (TEXT), `Model` (TEXT, reuses), `Year` (NUMBER, reuses), `Registration` (TEXT),
  `VIN` (TEXT), `Fuel` (SELECT — Petrol, Diesel, Hybrid, Plug-in hybrid, Electric, Other),
  `Odometer` (NUMBER), `Service due` (DATE, `dueLeadDays: 30`), `Roadworthiness test due` (DATE,
  `dueLeadDays: 30`), `Insurance renewal` (DATE, `dueLeadDays: 30`).
- "Roadworthiness test", not "MOT" — the library is not UK-only, and MOT means nothing outside
  Great Britain.

### 5.3 `vehicle-part` — Vehicle part (`vehicle`, 🛞)

- Fields: `Part number` (TEXT), `Manufacturer` (TEXT, reuses), `Fits vehicle` (TEXT),
  `Part category` (SELECT — Filter, Brake, Belt/hose, Electrical, Body, Engine, Suspension,
  Consumable, Other), `OEM or aftermarket` (SELECT — OEM, Aftermarket, Reconditioned, Used),
  `Fitted on` (DATE), `Fitted at odometer` (NUMBER).
- `Part type` was the natural name and is avoided: `Type` and its neighbours are already the
  library's most overloaded names (§3).

### 5.4 `medication` — Medication (`household`, 💊)

The medicine cabinet is the classic expiry case, and the one where an expired item actually
matters. This is a category schema, not health advice — the user records what is on the packet.

- Category defaults: `hiddenCapabilities: ['maintenance', 'kits', 'variants']`.
- Fields: `Expiry date` (DATE, reuses the existing definition, `dueLeadDays: 30`),
  `Dose form` (SELECT — Tablet, Capsule, Liquid, Cream/ointment, Inhaler, Injection, Drops,
  Other), `Strength` (TEXT), `Active ingredient` (TEXT), `Prescription` (ON_OFF),
  `Opened on` (DATE), `Storage requirement` (SELECT — Room temperature, Refrigerated, Away from
  light), `Notes` (LONG_TEXT).
- `Form` and `Storage` are both taken by other option lists (`Gold & silver bullion` and
  `Wood stock` for `Form`, `Food` for `Storage`). `Dose form` and `Storage requirement` are the
  names that keep the options correct.
- Setting `dueLeadDays: 30` on the shared `Expiry date` definition also gives the two existing
  presets that carry that exact field — `Food` and `Adhesive` — a 30-day expiry alert. That is the
  documented "set, never clear" behaviour and is the right outcome, but it is a change to existing
  categories, so make it deliberately. `First aid kit` is *not* affected: its dates are named
  `Contents last checked` and `Earliest expiry`, which are different definitions.

### 5.5 `consumable-filter` — Filters & consumables (`household`, 🧽)

The thing a household runs out of and only discovers when it needs one. This is the preset that
makes the maintenance schedule earn its keep.

- Category defaults: `defaultMaintenanceBasis: 'TIME'`, `defaultMaintenanceIntervalDays: 90`.
- Fields: `Fits appliance` (TEXT), `Consumable size` (TEXT), `Consumable kind` (SELECT — Air
  filter, Water filter, Vacuum bag, Bulb, Cartridge, Belt, Other), `Last changed` (DATE),
  `Change due` (DATE, `dueLeadDays: 14`), `Reorder link` (URL).

### 5.6 `cleaning-chemical` — Cleaning & household chemicals (`household`, 🧼)

- Fields: `Cleaner type` (SELECT — Detergent, Bleach, Degreaser, Descaler, Polish, Disinfectant,
  Solvent, Other), `Hazard class` (TEXT), `Safety data sheet` (URL), `Container volume` (TEXT),
  `Concentrate` (ON_OFF), `Opened on` (DATE), `Expiry date` (DATE, reuses), `Dilution` (TEXT).

### 5.7 `computer` — Computer (`electronics`, 💻)

`Electronic component` covers the parts bin; nothing covers the machine. It is also the preset a
self-hoster reaches for first, and the bridge already speaks to that audience.

- Category defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultWarrantyMonths: 12`.
- Fields: `Manufacturer` (TEXT, reuses), `Model` (TEXT, reuses), `Serial number` (TEXT, reuses),
  `Chassis type` (SELECT — Desktop, Laptop, Server, Mini PC, Single-board computer, Tablet,
  Other), `CPU` (TEXT), `Memory (GB)` (NUMBER), `Drives` (TEXT), `Operating system` (TEXT),
  `Hostname` (TEXT), `MAC address` (TEXT).
- `Form factor` is taken by `Battery` (AA, AAA, 18650…), hence `Chassis type`.

### 5.8 `network-equipment` — Network equipment (`electronics`, 🌐)

- Category defaults: `defaultTrackingMode: 'SERIALISED'`.
- Fields: `Manufacturer` (TEXT, reuses), `Model` (TEXT, reuses), `Network device type` (SELECT —
  Router, Switch, Access point, Modem, Firewall, NAS, PoE injector, Media converter, Other),
  `Ports` (NUMBER), `Link speed` (SELECT — 100 Mb, 1 Gb, 2.5 Gb, 5 Gb, 10 Gb, 25 Gb+),
  `PoE` (ON_OFF), `Management address` (TEXT), `Firmware version` (TEXT), `MAC address` (TEXT).
- `Speed` is taken by `Vinyl record` (33⅓/45/78 RPM), hence `Link speed`.

### 5.9 `smart-home-device` — Smart home device (`electronics`, 🏠)

Complementary to the Home Assistant bridge: the fields are the ones a person needs when a device
drops off the network and has to be re-paired or re-flashed.

- Fields: `Manufacturer` (TEXT, reuses), `Model` (TEXT, reuses), `Protocol` (SELECT — Wi-Fi,
  Zigbee, Z-Wave, Thread/Matter, Bluetooth, 433 MHz, Wired), `Smart device type` (SELECT — Light,
  Switch/plug, Sensor, Camera, Lock, Thermostat, Hub, Speaker, Other), `Power source` (SELECT —
  Mains, Battery, PoE, USB), `Firmware version` (TEXT), `Paired to hub` (TEXT),
  `Works without cloud` (ON_OFF).

### 5.10 `yarn` — Yarn (`crafts`, 🪢)

Knitting and crochet come up repeatedly in 2026 hobby-participation write-ups as a growing craft,
and yarn is the textbook preset case regardless: several facts a knitter always records, none of
which a built-in facet holds. `Fabric` is the nearest existing preset and does not overlap.

- Fields: `Fibre` (TEXT), `Yarn weight` (SELECT — Lace, 4-ply/Fingering, Sport, DK, Worsted/Aran,
  Chunky, Super chunky), `Colour` (COLOUR, reuses), `Colourway name` (TEXT), `Dye lot` (TEXT),
  `Length per ball (m)` (NUMBER), `Ball weight (g)` (NUMBER), `Needle / hook size` (TEXT),
  `Care` (TEXT).
- `Weight` is taken by `Gold & silver bullion` (1 g, 1 oz…), hence `Yarn weight`. `Colour` reuses
  the `COLOUR` definition ten other presets already share — which is correct, and is also the name
  §3 flags as broken by the MTG preset. Fixing that is a prerequisite for shipping this one
  cleanly.

### 5.11 `seed-packet` — Seeds (`home-garden`, 🌱)

- Category defaults: `hiddenCapabilities: ['maintenance', 'kits']`.
- Fields: `Variety` (TEXT), `Crop type` (SELECT — Vegetable, Herb, Flower, Fruit, Grass, Tree,
  Other), `Sow from` (DATE), `Sow until` (DATE), `Days to harvest` (NUMBER),
  `Packed for season` (NUMBER), `Best before` (DATE, `dueLeadDays: 60`),
  `Germination rate (%)` (NUMBER), `Sun` (SELECT — Full sun, Partial shade, Shade),
  `Spacing` (TEXT).

### 5.12 `houseplant` — Plant (`home-garden`, 🪴)

- Category defaults: `defaultMaintenanceBasis: 'TIME'`, `defaultMaintenanceIntervalDays: 7`
  (watering *is* the schedule), `hiddenCapabilities: ['batches', 'kits']`.
- Fields: `Species` (TEXT, reuses), `Common name` (TEXT), `Acquired on` (DATE), `Pot size` (TEXT),
  `Light` (SELECT — Bright direct, Bright indirect, Medium, Low), `Watering` (TEXT),
  `Last repotted` (DATE), `Hardiness` (TEXT), `Photo` (IMAGE).

## 6. Tier 2 — the next thirteen

Worth adding, and each defensible on its own, but none is the gap a new user notices on day one.
Fields are given compactly; every one was name-checked against §3 and against tier 1, which is why
several read more specifically than they otherwise would. Glyphs avoid the ones the library already
uses, with one deliberate exception: `Jigsaw puzzle` takes 🧩, which `Model kit` also uses, because
the jigsaw is the more literal owner and the library already tolerates a repeated glyph (🔥 and 🎬
each appear twice).

| Preset | Section | Glyph | Fields |
| --- | --- | --- | --- |
| Power tool consumables | `workshop` | 🪚 | Tooling kind (SELECT: Drill bit, Saw blade, Router bit, Sanding disc, Cutting disc, Tap/die, Insert), Cutting size, Cutter material (SELECT: HSS, Carbide, Cobalt, Diamond, Bi-metal), Shank / arbor, Teeth or grit, Fits tool |
| Metal stock | `workshop` | ⛓️ | Stock metal (SELECT: Mild steel, Stainless, Aluminium, Brass, Copper, Titanium), Stock form (SELECT: Sheet, Bar, Round, Tube, Angle, Plate), Thickness (mm) (NUMBER), Width (mm) (NUMBER), Length (mm) (NUMBER), Alloy / grade, Surface finish |
| Lubricants & chemicals | `workshop` | 🛢️ | Lubricant type (SELECT: Oil, Grease, Penetrating, Cutting fluid, Solvent, Release agent), Safety data sheet (URL), Hazard class, Container volume, Opened on (DATE), Shelf life expiry (DATE, lead 30), Flash point |
| Safety equipment (PPE) | `workshop` | 🦺 | Protection type (SELECT: Eye, Hearing, Respiratory, Hand, Head, Fall arrest, Foot), Standard / rating, PPE size, Manufactured on (DATE), Expiry date (DATE, lead 30), Inspection due (DATE, lead 14) |
| Development board | `electronics` | 📟 | Board family, Microcontroller, Flash (KB) (NUMBER), RAM (KB) (NUMBER), Radio (SELECT: None, Wi-Fi, BLE, Wi-Fi + BLE, LoRa, Zigbee), Logic level (SELECT: 3.3 V, 5 V, Both), Pinout (URL), Firmware version |
| Storage media | `electronics` | 💾 | Media kind (SELECT: HDD, SSD, NVMe, SD card, USB stick, Optical, Tape), Capacity (GB) (NUMBER), Bus interface, Serial number, Power-on hours (NUMBER), Drive health (SELECT: Good, Degraded, Failing, Retired), Encrypted (ON_OFF) |
| Music CD | `media` | 🎵 | Artist, Album, Label, Catalogue number, Release year (NUMBER), Discs (NUMBER), Release edition, Rating (RATING), Cover art (IMAGE) |
| Tabletop RPG book | `media` | 🐉 | Game system, Publisher, Book kind (SELECT: Core rulebook, Supplement, Adventure, Setting, Screen), Ruleset edition, Printing, ISBN, Rating (RATING) |
| Jigsaw puzzle | `media` | 🧩 | Pieces (NUMBER), Brand, Puzzle subject, Completed (ON_OFF), Pieces missing (NUMBER), Difficulty (SELECT: Easy, Moderate, Hard, Very hard), Finished size |
| Sheet music | `media` | 🎼 | Composer, Arranger, Instrumentation, Musical key, Difficulty grade, Publisher, Score format (SELECT: Full score, Part, Songbook, Digital) |
| Embroidery floss | `crafts` | 🪡 | Colour (COLOUR), Colour number, Brand, Thread fibre (SELECT: Cotton, Silk, Rayon, Wool, Metallic), Skeins (NUMBER), Variegated (ON_OFF) |
| Resin & casting supplies | `crafts` | ⚗️ | Casting product (SELECT: Epoxy resin, UV resin, Polyurethane, Silicone, Pigment, Release agent), Mix ratio, Pot life, Full cure time, Opened on (DATE), Expiry date (DATE, lead 30), Safety data sheet (URL) |
| Small parts organiser | `containers` | 📇 | Organiser kind (SELECT: Drawer cabinet, Compartment box, Bin rack, Tackle box, Tray), Compartments (NUMBER), Dividers adjustable (ON_OFF), Footprint, Stackable (ON_OFF), Contents summary (LONG_TEXT) |

`Embroidery floss` takes `Colour` (COLOUR) and so inherits the same prerequisite `Yarn` does in
§5.10: the library's `Colour` conflict has to be settled first.

An **Art supplies** preset was drafted for this tier and demoted to §7. It sits in `crafts`
alongside the existing `Paint`, and four of its seven fields (`Brand`, `Colour`, `Colour name`, and
a medium/type `SELECT` whose options largely repeat) are that preset already. Bar 5 in §2 rules it
out until the overlap is settled — either widen `Paint` to cover dry media, or find the fields that
genuinely distinguish the two.

## 7. Tier 3 — plausible, unranked

Recorded so the research is not repeated, not recommended for the first slice. Each is either a
narrower audience than tier 2, or close enough to an existing preset that the overlap needs
settling first.

- **`workshop`:** Welding consumables, Abrasives, Plumbing fittings, Electrical wire (distinct from
  the existing `Cable`, which is leads and adaptors), Bearings & seals, CNC tooling.
- **`electronics`:** Connectors, Sensors & modules, Bare PCBs, Mobile phone (IMEI, carrier lock),
  Audio equipment, Test equipment (overlaps `Tools` and its calibration certificate).
- **`household`:** Furniture, Light bulbs, Toiletries & cosmetics (period-after-opening is a real
  and under-served field), Bedding & linens, Pet supplies, Baby & child gear, Toys, Documents &
  records, Spices (a narrower `Food`), Coffee & tea.
- **`home-garden`:** Garden chemicals, Garden machinery, Camping gear, Bicycle & parts, Fishing
  tackle, Sports equipment, Beekeeping, Aquarium.
- **`vehicle`:** Tyres (DOT date and tread depth are good fields; thin on its own), Fluids &
  lubricants (duplicates the workshop entry — pick one home for it).
- **`crafts`:** Art supplies (demoted from tier 2 — overlaps the existing `Paint`, see §6), Sewing
  patterns, Beads & findings, Leather, Pottery clay & glaze, Candle & soap
  making, Craft vinyl & HTV, Scrapbooking paper, Homebrew ingredients.
- **`collectibles`:** Keys & keyrings, Vintage tools, Vintage advertising & signage, Bottle caps &
  breweriana, Signed books. The section is saturated; adding to it is the lowest-value work in this
  document.

## 8. Deliberately rejected

- **Firearms and ammunition.** Named on the insurance checklists consulted, and the fields are
  well defined. Rejected anyway: the subject is jurisdictionally fraught, and a preset in the
  shipped library reads as the project endorsing the use case. A user who wants it can build the
  category by hand in a minute, which is what presets exist to shortcut rather than to bless.
- **Subscriptions, licences and warranties as their own preset.** These are not items, they are
  dates attached to items. `Vehicle` and `Appliance` carry their renewal dates as fields, which is
  the right shape. A standalone "Subscription" category would be a to-do list wearing an
  inventory's clothes.
- **A generic "Spare parts" preset.** Too broad to carry a useful field set — the fields that
  matter are the ones specific to what the part is *for*. `Vehicle part` works because the "for
  what" is pinned down; "Spare part" would ship five fields nobody fills in.
- **Cryptocurrency and financial holdings.** Not physical, no location, and every built-in facet is
  meaningless for them.

## 9. Implementation notes

- **Settle §3's `Colour` before shipping `Yarn` or `Embroidery floss`.** Both want the `COLOUR`
  definition ten presets already share, and both therefore land in the existing `Colour` conflict.
  That one name is the only part of §3 that gates tier 1; the other nine names and the parity test
  are their own piece of work and should not be folded into this one.
- **Preset names and descriptions are not translated today**, and none of the 72 existing entries
  goes through `t()`. Converting the existing 72 is a separate change and should not ride along
  with new presets — but CLAUDE.md's i18n rule still says a *new* user-facing string should be
  added via `t()`, so whoever ships tier 1 should decide that deliberately rather than by
  copying the surrounding entries. A **new section label** has no such latitude:
  `SECTION_LABEL_KEY` values are catalog keys, so `en.json` *and* `de.json` both need one, in the
  same change.
- **`category-presets.test.ts` already enforces part of the bar**: unique ids and
  case-insensitive-unique names, `seed.category.name === preset.name`, contiguous 0-based
  positions, a `SELECT` carrying options and a non-`SELECT` carrying none, a non-empty glyph on
  every preset, and every section non-empty. A new section with no presets in it fails the suite,
  so land a section and its presets together.
- **Tier 1 grows the picker by 17%** (12 on 72). Check the picker still reads well at that size
  before starting tier 2 — the section rail and its per-section counts are what keep it navigable,
  and `home-garden` / `vehicle` help by pulling entries out of `household`.
- **Several candidates would pair with a lookup provider** once
  [#616](https://github.com/BootBlock/Gubbins/issues/616) reaches phase L3 — a books provider for
  `Book`, a food-database provider for `Food`, a music provider for `Music CD` and
  `Vinyl record`. Adding the preset now and attaching `lookupSources` later is the right order;
  neither change blocks the other.
- **No wiki change is needed for this document.** One is needed when presets actually ship — the
  categories page lists what the library offers, and a new section changes what the picker looks
  like.

## 10. Method, and what it does not cover

**What was verified.** The existing library was read in full and enumerated programmatically: the
preset and section counts in §1, the unused facets in §2, the eight dual-type names and the
divergent `SELECT` option lists in §3, and the collision check every proposed field name in §5 and
§6 passed. Those claims are reproducible from `src/features/inventory/category-presets.ts` and
`src/db/repositories/CategoryRepository.ts`, and a reader should hold them to that standard.

**What was not.** The demand ranking is not. It draws on consumer home-inventory and insurance
checklists, on general 2026 hobby-participation write-ups, and on the feature sets of comparable
self-hosted inventory tools — none of which is cited here by publisher or URL, and none of which is
a controlled survey. Where the document says a checklist "names" something or a craft is "growing",
read it as the author's reading of a general picture, not as a result. Anyone revisiting the
ranking should redo that part rather than inherit it.

Two further limits. None of this is Gubbins' own usage data — the app has no telemetry that would
say which presets get imported, so "most useful" is an argued judgement throughout. And the field
sets are drawn from what each domain conventionally records; they have not been reviewed by a
practitioner in each one. Expect the first user of `Yarn` or `Vehicle part` to suggest a field this
document missed, and treat that as the design working rather than failing.
