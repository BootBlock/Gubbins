# Category presets — research into what the library is still missing

> **Status:** 🟢 ACTIVE — **tier 1 has shipped**: the twelve presets in §5 and the two new
> `home-garden` / `vehicle` picker sections in §4 are in the library, along with the parity test §3
> asks for. Tier 2 (§6) and tier 3 (§7) are open and unstarted. Of the shared-field-name defect in
> §3, only the `Colour` conflict was settled (the `Magic: The Gathering cards` field is now
> `Card colour`), because it gated `Yarn`; the rest is filed as
> [#715](https://github.com/BootBlock/Gubbins/issues/715) and pinned by the parity test.
>
> **Extended 2026-08-29 with §§11–14**, which are additions rather than revisions — §§1–10 stand as
> the record of what was argued on 2026-08-28. §11 works §7's bare tier 3 names up into real
> proposals; §12 does the same for the thin `media` and `household` sections; §13 turns the research
> inward and audits the 84 shipped presets; §14 supplies the cited evidence base §10 says the demand
> ranking never had, and **contradicts the ranking in four places** — read §14.5 before treating
> §§5–7 as settled.

Issue [#443](https://github.com/BootBlock/Gubbins/issues/443) asks two things: what *new*
`Category` presets are worth adding to `CATEGORY_PRESETS`, and what custom fields each one should
carry. This document answers both, records what the existing library already covers so nothing is
proposed twice, and states the rules a candidate has to satisfy before it earns a place.

When §§1–10 were written nothing here was implemented; tier 1 has since shipped, and the rest is
still a shopping list, ordered so that the next slice can be taken on its own. §3 is the exception:
it records a defect in the *existing* library that the research turned up, and that any new preset
has to be written around.

## 1. What the library already holds

`src/features/inventory/category-presets.ts` ships **72** presets across the seven sections
declared in `PRESET_SECTION_IDS`. The distribution is heavily skewed:

*(As surveyed on 2026-08-28. Tier 1 has since added twelve presets and the `home-garden` and
`vehicle` sections, so the library now stands at 84 across nine. The table below is the "before"
this document argued from, and is left as the record of it.)*

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

> **Correction (tier 1, 2026-08-29).** The two names above were found by hand, and the sweep for
> the silent half stopped there. The parity test written when tier 1 shipped runs it exhaustively,
> and the real figure is **twelve** names with divergent `SELECT` option lists, not two: `Metal` and
> `Form`, the four that also carry two types (`Material`, `Region`, `Scale`, `Type`), and six more
> the table above misses entirely — `Condition`, `Rarity`, `Format`, `Finish`, `Completeness` and
> `Movement`, the grading and edition vocabularies each collectibles preset spells slightly
> differently. Counting both halves, **fifteen** names are affected rather than ten. The exact lists
> are pinned in `src/features/inventory/category-presets.test.ts`; read them, not this section, when
> picking the defect up.

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

> **Worked up since.** This section is the bare list as first written. **§11** turns every name in
> the `workshop`, `electronics`, `home-garden`, `vehicle`, `crafts` and `collectibles` buckets into a
> full proposal or a reasoned demotion, and **§12** does the same for `household` and for the `media`
> gaps §1 identifies. §14.5 also finds that four candidates listed here are better evidenced than
> most of tier 2.

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
  **Decided when tier 1 shipped: new preset names and descriptions stay untranslated, like the
  existing 72.** A preset's `name` is written straight into the database as the created category's
  name, and is the case-insensitive key the picker's "Added" guard matches on. Translating it would
  make the same preset import as a differently-named category per UI language, so a German user's
  second import would create a duplicate rather than being blocked. The reason is recorded on the
  `CategoryPreset` interface so the next author does not have to re-derive it. The two new section
  labels went through `t()` in both catalogs, as this bullet already required.
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
  like. Done for tier 1: `docs/wiki/Custom-Fields-and-Capabilities.md` now names the new presets
  and both new sections, and describes the seeded service schedules and due-date leads. No
  screenshot needed regenerating — the wiki has never carried a shot of the preset picker.

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

> **Redone since (2026-08-29).** §14 does what the paragraph above asks for: it gathers the
> checklists, participation figures and comparable tools with a publisher, a URL and a date for each,
> and reports what they support, what they contradict and what has no source at all. It settles the
> household half of the ranking and leaves the hobby half unevidenced. The paragraph above stands as
> the record of what §§1–9 were argued from; §14 is what they can now be checked against.

## 11. Tier 3, worked up — workshop, electronics, garden, vehicle, crafts, collectibles

**What this covers.** The six §7 buckets `workshop`, `electronics`, `home-garden`, `vehicle`,
`crafts` and `collectibles` — 36 bare names — worked up to the same standard as §5 and §6. Twenty-five
become real proposals with a section, a glyph, a description, a field set and category defaults;
eleven are demoted with a reason rather than padded out. Every §7 caveat in these buckets is settled:
`Fluids & lubricants` gets one home, `Bicycle & parts` gets a section, `Tyres` gets a field set thick
enough to stand on, `Test equipment` is ruled a duplicate of `Tools`, `Art supplies` is narrowed until
it no longer restates `Paint`, and `Abrasives` / `CNC tooling` are folded into the tier 2 preset that
already covers them. The `household` bucket and the `media` gaps are deliberately untouched.

**Checked, not eyeballed.** All 223 proposed fields were run against the 308 distinct field names in
the shipped library **and** against the thirteen unshipped tier 2 field sets in §6, for both §3 failure
modes. **Zero type clashes and zero silent option captures**, with the avoidances recorded in the table
at the end. Nothing here introduces a new instance of the §3 defect.

**Not settled, and left for a human.** One glyph swap on a shipped preset (§11.4) and one section
question that will come back when the outdoor set grows (§11.3).

### 11.1 `workshop` — four proposals, two demotions

The section ships only four presets, so it is the thinnest of the nine after `vehicle` and
`home-garden`. Everything below is stores stock: the things that live in drawers and get consumed,
which is what the section is for.

| Preset | id | Glyph | Fields |
| --- | --- | --- | --- |
| Welding consumables | `welding-consumable` | 🔥 | Welding process (SELECT: MIG/MAG, TIG, Stick / MMA, Flux-cored, Gas, Brazing), Consumable form (SELECT: Wire spool, Electrode / rod, Filler rod, Gas cylinder, Contact tip, Nozzle, Flux), Rod diameter (mm) (NUMBER), Alloy / grade (TEXT), Shielding gas (TEXT), Suits thickness (TEXT), Batch / lot (TEXT), Opened on (DATE, reuses) |
| Plumbing fittings | `plumbing-fitting` | 🚿 | Fitting kind (SELECT: Elbow, Tee, Coupler, Reducer, Valve, Tap connector, Trap, Pipe, End cap), Joint type (SELECT: Compression, Push-fit, Solvent weld, Solder / end feed, Threaded, Push-on hose), Nominal bore (TEXT), Thread size (TEXT, reuses), Fitting material (SELECT: Copper, Brass, Stainless steel, Cast iron, PVC, PEX, Polybutylene), Pressure rating (TEXT), Potable water (ON_OFF), Compliance standard (TEXT, reuses) |
| Electrical wire | `electrical-wire` | ⚡ | Cross-section (mm²) (NUMBER), Conductor gauge (AWG) (NUMBER), Cores (NUMBER), Conductor (SELECT: Solid copper, Stranded copper, Tinned copper, Copper-clad aluminium, Aluminium), Insulation (SELECT: PVC, Silicone, PTFE, XLPE, Rubber, LSZH), Colour (COLOUR, reuses), Voltage rating (V) (NUMBER), Current rating (A) (NUMBER), Length (m) (NUMBER, reuses), Sheathed (ON_OFF) |
| Bearings & seals | `bearing-seal` | 🌀 | Bearing kind (SELECT: Deep groove ball, Angular contact, Taper roller, Needle roller, Thrust, Plain bush, Linear, Oil seal, O-ring), Bore (mm) (NUMBER), Outside diameter (mm) (NUMBER), Width (mm) (NUMBER, reuses), Seal or shield (SELECT: Open, Shielded (Z), Double shielded (ZZ), Sealed (RS), Double sealed (2RS)), Seal material (SELECT: Nitrile, Viton-type fluoroelastomer, Silicone, PTFE, Polyacrylate), Fits machine (TEXT), Precision class (TEXT) |

- **Welding consumables** — *"Rods, wire and gas for the welder — process, alloy, diameter and how long
  the packet has been open."* No category defaults; a consumable is `DISCRETE`, which is already the
  default. Rods absorb moisture once the packet is opened, which is why `Opened on` earns its place
  rather than being decoration.
- **Plumbing fittings** — *"Pipe, valves and connectors — bore, joint type, material and pressure
  rating."* No defaults. This is the bucket's strongest entry: almost every household that keeps any
  spares at all keeps plumbing spares, and the fact that decides whether a fitting is usable — 15 mm
  compression versus 15 mm push-fit — is exactly what the built-in facets cannot hold.
- **Electrical wire** — *"Cable on the reel — cross-section, cores, insulation and how much is left."*
  No defaults. Distinct from the shipped `Cable`, which is leads and adaptors identified by their two
  connectors; this is bulk conductor identified by what it is made of. It is also the library's most
  natural first `CONSUMABLE_GAUGE` preset — wire on a reel is precisely the "continuously degrading
  material" that mode exists for — but **no** preset sets that mode today, so introducing it here
  would be a facet decision riding along with a preset addition. Left at the default deliberately, and
  worth revisiting as its own change.
- **Bearings & seals** — *"Rotating-part spares — bore, outside diameter, width and the seal fitted."*
  No defaults. The weakest of the four on bar 1: a machinist and a bike mechanic both keep a bearing
  drawer, but most households do not. Kept because the field set is unusually crisp — four numbers and
  a shield code identify a bearing completely — and ranked last.

**Demoted: `Abrasives`.** Tier 2's `Power tool consumables` (§6) already carries `Sanding disc` and
`Cutting disc` in its `Tooling kind` list and `Teeth or grit` as a field, so an abrasives preset would
restate it for the sake of sheets and blocks. Bar 5. The better change is one option: add `Abrasive
sheet` to `Tooling kind` when tier 2 ships.

**Demoted: `CNC tooling`.** Same argument and a narrower audience. `Tooling kind` should gain
`End mill` (it already has `Insert`), and `Cutter material` already offers Carbide, Cobalt and
Diamond. What a CNC-specific preset would add over that is flute count and coating, which does not
justify a separate entry in a picker that is already growing.

### 11.2 `electronics` — four proposals, two demotions

| Preset | id | Glyph | Fields |
| --- | --- | --- | --- |
| Connectors | `connector` | 🔗 | Connector series (TEXT), Connector gender (SELECT: Male / plug, Female / socket, Hermaphroditic), Positions (NUMBER), Pitch (mm) (NUMBER), Mounting (SELECT: Through-hole, Surface mount, Panel mount, Cable / crimp, Screw terminal, Chassis), Current rating (A) (NUMBER), Keyed / polarised (ON_OFF), Mating half (TEXT), Datasheet (URL, reuses) |
| Sensors & modules | `sensor-module` | 📡 | Measures (SELECT: Temperature, Humidity, Pressure, Light, Motion / PIR, Distance, Gas / air quality, Current, Acceleration, Magnetic field, Sound, Other), Sensor interface (SELECT: I²C, SPI, UART, 1-Wire, Analogue, PWM, Digital), Logic level (SELECT: 3.3 V, 5 V, Both), Measurement range (TEXT), Accuracy (TEXT), Bus address (TEXT), Datasheet (URL, reuses), Library / driver (TEXT) |
| Mobile phone | `mobile-phone` | 📱 | Manufacturer (TEXT, reuses), Model (TEXT, reuses), IMEI (TEXT), Serial number (TEXT, reuses), Capacity (GB) (NUMBER), Operating system (TEXT, reuses), Carrier lock (SELECT: Unlocked, Locked to network, Unknown), Screen size (in) (NUMBER), Battery health (%) (NUMBER), Wiped before disposal (ON_OFF) |
| Audio equipment | `audio-equipment` | 🔊 | Manufacturer (TEXT, reuses), Model (TEXT, reuses), Audio device kind (SELECT: Amplifier, Speaker, Headphones, Microphone, Mixer, Audio interface, Turntable, Receiver, DAC, Other), Connections (TEXT), Power (W) (NUMBER), Impedance (Ω) (NUMBER), Channels (NUMBER), Serial number (TEXT, reuses), Manual (URL, reuses) |

- **Connectors** — *"Plugs, sockets and housings — series, pitch, ways and how they mount."* No
  defaults. It overlaps `Electronic component` only at `Datasheet`: a resistor is identified by value
  and tolerance, a connector by pitch and position count, and neither preset's fields would be filled
  in for the other's parts.
- **Sensors & modules** — *"Breakout boards — what they measure, the bus they speak and the voltage
  they want."* No defaults. `Logic level` is declared with the **same** option list tier 2's
  `Development board` uses, so the shared definition is deliberate and correct rather than a §3
  accident; if tier 2 ships first this preset simply reuses it.
- **Mobile phone** — *"Handsets and tablets — IMEI, storage, carrier lock and whether the data has been
  wiped."* Defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultCondition: 'GOOD'`,
  `defaultWarrantyMonths: 24`. The strongest candidate in the bucket by ownership, and the IMEI is the
  textbook case of a fact everybody needs once and nobody can find. `Wiped before disposal` is the
  field that makes the drawer of old handsets tractable; it is also the only sensitive-looking field
  here, and it deliberately records a *state*, never a credential.
- **Audio equipment** — *"Amplifiers, speakers and interfaces — kind, connections, power and
  impedance."* Defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultWarrantyMonths: 12`.
  `Connections` is TEXT rather than SELECT on purpose: a mixer has six kinds of socket at once, and a
  single-value dropdown would force the user to pick one and lose the rest. It does not duplicate
  `Musical instruments`, which is a collectibles preset about provenance.

**Demoted: `Test equipment`.** The shipped `Tools` preset is described as *"Serialised, loanable
equipment — tracked one-by-one with a calibration record"* and carries Manufacturer, Model number,
Serial number and `Calibration certificate`, with `defaultCondition: 'GOOD'` and the
`OUT_FOR_CALIBRATION` condition already in the enum. That **is** the test-equipment preset; it merely
has a broader name. Bar 5, decisively. If a bench meter needs anything `Tools` lacks it is a
`Calibration due` DATE with a lead — which is a one-field addition to `Tools`, not a new preset, and a
better change than either.

**Demoted: `Bare PCBs`.** Narrower than tier 2's `Development board` and thinner: revision, layer
count, dimensions and finish is four fields, three of which a user would rather keep in the project
than the stores. Bar 1 and bar 2 both marginal. Recorded, not recommended.

### 11.3 `home-garden` — four proposals, three demotions

Tier 1 shipped this section with two presets. These four take it to six, which is where a rail entry
stops looking provisional.

| Preset | id | Glyph | Fields |
| --- | --- | --- | --- |
| Garden chemicals | `garden-chemical` | 🧪 | Garden product type (SELECT: Fertiliser, Weedkiller, Insecticide, Fungicide, Moss killer, Lawn treatment, Soil conditioner, Other), Active ingredient (TEXT, reuses), Application rate (TEXT), Dilution (TEXT, reuses), Treats (TEXT), Harvest interval (days) (NUMBER), Hazard class (TEXT, reuses), Safety data sheet (URL, reuses), Expiry date (DATE, reuses — already lead 30), Opened on (DATE, reuses) |
| Garden machinery | `garden-machinery` | 🚜 | Manufacturer (TEXT, reuses), Model number (TEXT, reuses), Serial number (TEXT, reuses), Machine kind (SELECT: Lawn mower, Strimmer / brushcutter, Hedge trimmer, Chainsaw, Leaf blower, Tiller / rotavator, Pressure washer, Shredder, Other), Power type (SELECT: Petrol, Battery, Mains electric, Manual), Engine displacement (cc) (NUMBER), Fuel mix (TEXT), Running hours (NUMBER), Blade / chain spec (TEXT), Service due (DATE, reuses — already lead 30), Winterised on (DATE) |
| Camping gear | `camping-gear` | ⛺ | Gear kind (SELECT: Tent, Sleeping bag, Sleeping mat, Stove, Cookset, Rucksack, Lantern, Chair / table, Other), Sleeps (NUMBER), Season rating (SELECT: 1 season, 2 season, 3 season, 4 season, Expedition), Comfort rating (°C) (NUMBER), Packed weight (g) (NUMBER), Packed size (TEXT), Waterproof rating (TEXT), Fuel type (SELECT: Gas canister, Liquid fuel, Solid fuel, Wood, None), Last aired (DATE), Complete (ON_OFF, reuses) |
| Fishing tackle | `fishing-tackle` | 🎣 | Tackle kind (SELECT: Rod, Reel, Line, Hook, Lure, Float, Weight / lead, Net, Bait, Other), Water (SELECT: Freshwater, Saltwater, Both), Line class (TEXT), Hook size (TEXT), Rod length (m) (NUMBER), Reel gear ratio (TEXT), Lure weight (g) (NUMBER), Colour (COLOUR, reuses) |

- **Garden chemicals** — *"Feeds, weedkillers and treatments — what they treat, the dilution and how
  long after use a crop is safe."* No defaults, matching its household sibling `Cleaning & household
  chemicals`, which sets none either. The two do not duplicate: the four fields that matter here —
  `Active ingredient`, `Application rate`, `Treats`, `Harvest interval (days)` — have no counterpart on
  a bottle of bleach, and the shared safety fields are shared *definitions*, which is the correct
  outcome rather than an overlap. `Harvest interval (days)` is the one nobody remembers and the one
  that actually matters.
- **Garden machinery** — *"Mowers, trimmers and tillers — engine details, running hours and the service
  that falls due on them."* Defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultCondition: 'GOOD'`,
  `defaultWarrantyMonths: 24`, `defaultMaintenanceBasis: 'USAGE'`,
  `defaultMaintenanceIntervalUsage: 50`. Fifty running hours is the conventional small-engine service
  interval, and this is the second preset in the library (after `Vehicle`) to seed a usage-based
  schedule — the facet §2 says no preset touched before tier 1. A mower is the most-serviced machine a
  household owns after the car, and the one whose service history is least likely to be written down
  anywhere.
- **Camping gear** — *"Tents, bags and stoves — capacity, packed weight, season rating and when it was
  last aired."* Defaults: `hiddenCapabilities: ['perishables', 'batches']`. `Last aired` is the field
  the domain actually asks for: a tent packed damp is ruined by the next season, and nothing in the
  built-in facets records it.
- **Fishing tackle** — *"Rods, reels and terminal tackle — line class, size, water type and colour."*
  Defaults: `hiddenCapabilities: ['maintenance', 'perishables']`. The field set is deliberately
  kind-dependent — `Rod length (m)` is blank on a hook and `Hook size` is blank on a reel — which is
  normally the "Spare parts" smell §8 rejects. It survives because a tackle box is genuinely
  catalogued this way and because `Tackle kind` pins down which subset applies, but it is the weakest
  of the four and is ranked last.

**Section question, settled for now.** `Camping gear` and `Fishing tackle` are outdoor pursuits rather
than gardening, and `home-garden` is a slightly awkward home for both. An `outdoors` section is *not*
recommended yet, for exactly the reason §4 gives against a `health` section: two presets is a thin
rail entry and looks broken. Put them in `home-garden`, and revisit if the outdoor set reaches four —
at which point `Bicycle`, camping, fishing and a sports preset would make a real section together.

**Demoted: `Sports equipment`.** Too broad to carry a field set, which is §8's `Spare parts`
argument verbatim: a tennis racket, a kayak and a set of dumbbells share nothing but a name. The
useful presets hiding inside it are per-sport, and none of them clears bar 1 on its own.

**Demoted: `Beekeeping`.** Bar 1. What a beekeeper records is inspections — brood, stores, temper,
queen seen — which is a recurring log against one hive, not an inventory of items. Gubbins can model
the hardware, but the hardware is not what anybody wants to write down.

**Demoted: `Aquarium`.** Bar 2. The half worth having is a water-change schedule, and that is
`defaultMaintenanceBasis: 'TIME'` on any category the user makes in a minute; the rest splits into
tank hardware (already `Appliance`-shaped) and livestock, which is a different preset again. Not worth
one entry pretending to be both.

### 11.4 `vehicle` — two proposals, one demotion

| Preset | id | Glyph | Fields |
| --- | --- | --- | --- |
| Tyres & wheels | `tyre-wheel` | 🛞 | Tyre size (TEXT), Load index (TEXT), Speed rating (TEXT), Season (SELECT: Summer, Winter, All-season, Off-road, Track), Tread depth (mm) (NUMBER), Date code (week/year) (TEXT), Wheel position (SELECT: Front left, Front right, Rear left, Rear right, Spare, In storage), Rim material (SELECT: Steel, Alloy, Forged alloy), Fits vehicle (TEXT, reuses), Replace by (DATE, `dueLeadDays: 60`) |
| Bicycle | `bicycle` | 🚲 | Make (TEXT, reuses), Model (TEXT, reuses), Frame number (TEXT), Bicycle kind (SELECT: Road, Gravel, Mountain, Hybrid, Touring, Folding, BMX, Electric, Child), Frame size (TEXT), Wheel size (SELECT: 16", 20", 24", 26", 27.5", 29", 650b, 700c), Groupset speeds (NUMBER), Brake type (SELECT: Rim, Disc (mechanical), Disc (hydraulic), Coaster, Drum), Odometer (NUMBER, reuses), Service due (DATE, reuses — already lead 30), Frame registered (ON_OFF) |

- **Tyres & wheels** — *"Tyres on and off the car — size, load and speed rating, age code and tread
  left."* Defaults: `defaultCondition: 'GOOD'`. **The "thin on its own" caveat is settled by widening
  it to wheels and by making the age a deadline.** Renamed from `Tyres`, it carries ten fields, every
  one of which somebody writes on the masking tape stuck to a stored winter set. `Replace by` is the
  one **new** `dueLeadDays` this whole slice introduces: rubber ages out on the date code whether or
  not the tread is legal, and sixty days' notice is enough to buy at a sensible price rather than in a
  hurry.
- **Bicycle** — *"Bikes and what they are built from — frame number, drivetrain, wheel size and the
  service that falls due."* Defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultCondition: 'GOOD'`,
  `defaultMaintenanceBasis: 'USAGE'`, `defaultMaintenanceIntervalUsage: 500`. **The "pick one home"
  caveat is settled in favour of the `vehicle` section, not `home-garden`.** The reasoning: `Vehicle`
  is built around registration, VIN and a roadworthiness test, none of which a bicycle has, so it
  cannot simply be filed under the existing preset — but the *section* is where a user will look, and
  a bike in "Home & garden" is the same poor fit as a lawnmower in "Household". It also brings
  `vehicle` from two presets to four. `Frame number` rather than `VIN` for the same reason
  `Roadworthiness test due` is not `MOT`.

**Demoted: `Fluids & lubricants` — one home, and it is `workshop`.** Tier 2's `Lubricants &
chemicals` (§6) already covers it: oil, grease, penetrating fluid, safety data sheet, hazard class,
opened-on and a shelf-life expiry. Duplicating it in `vehicle` would be the §3 trap in preset form —
two presets, two field sets, one shared dictionary. The recommendation is to keep the single workshop
preset and give it two fields when it ships so the driveway is served as well as the bench:
`Viscosity grade` (TEXT — 10W-40, ISO 68) and `Specification` (TEXT — the approval codes printed on
the bottle). Both are free names.

**One decision for a human: the 🛞 glyph.** `Vehicle part` (shipped, tier 1) holds it, and a tyre is
its more literal owner — but two presets sharing a glyph *inside one section* reads worse than the
cross-section repeats the library already tolerates (🔥, 🎬). The clean fix is to give `Tyres & wheels`
🛞 and move `Vehicle part` to 🔧, which is unused. A glyph is presentation only — the id and name are
the identity and idempotency keys — so changing it on a shipped preset is safe. It is still a change
to something that has shipped, so it should be taken deliberately rather than assumed.

### 11.5 `crafts` — nine proposals

The largest bucket, and the one where §7's bare names most needed narrowing. Two entries changed shape
in the working-up: `Art supplies` became `Drawing & art media` to settle the §6 demotion, and
`Scrapbooking paper` widened into `Craft paper & card`.

| Preset | id | Glyph | Fields |
| --- | --- | --- | --- |
| Drawing & art media | `art-media` | 🖌️ | Art medium (SELECT: Graphite pencil, Coloured pencil, Charcoal, Soft pastel, Oil pastel, Marker, Ink, Watercolour pan, Gouache, Chalk crayon), Grade / hardness (TEXT), Tip / nib (TEXT), Colour (COLOUR, reuses), Colour name (TEXT, reuses), Lightfastness (TEXT), Set size (NUMBER), Brand (TEXT, reuses) |
| Sewing patterns | `sewing-pattern` | ✂️ | Pattern number (TEXT), Garment type (SELECT: Top, Dress, Skirt, Trousers, Jacket / coat, Bag, Toy, Quilt, Accessory, Other), Size range (TEXT), Fabric required (TEXT), Suggested fabrics (TEXT), Pattern difficulty (SELECT: Beginner, Confident beginner, Intermediate, Advanced), Pattern format (SELECT: Paper, PDF download, Traced copy, Magazine insert), Cut out (ON_OFF), Made before (ON_OFF) |
| Beads & findings | `bead-finding` | 📿 | Bead shape (SELECT: Round, Bicone, Seed, Rocaille, Tube, Faceted, Nugget, Chip, Spacer, Charm), Bead material (SELECT: Glass, Crystal, Acrylic, Wood, Metal, Stone, Ceramic, Shell, Resin, Pearl), Bead size (mm) (NUMBER), Hole size (mm) (NUMBER), Finding kind (SELECT: Clasp, Jump ring, Headpin, Earring wire, Crimp, Bail, Chain, Spacer bar, None), Plating (SELECT: Silver-plated, Gold-plated, Rose gold, Gunmetal, Antique brass, Stainless steel, None), Colour (COLOUR, reuses), Strand or packet count (NUMBER) |
| Leather | `leather` | 🧳 | Leather cut (SELECT: Full hide, Side, Shoulder, Bend, Belly, Panel, Offcut), Tannage (SELECT: Vegetable, Chrome, Combination, Brain / oil, Unknown), Grain (SELECT: Full grain, Top grain, Split, Suede, Nubuck, Bonded), Thickness (oz) (NUMBER), Temper (SELECT: Soft, Medium, Firm), Area (sq ft) (NUMBER), Colour (COLOUR, reuses), Animal (TEXT) |
| Pottery clay & glaze | `pottery-clay-glaze` | 🫙 | Pottery product (SELECT: Clay body, Glaze, Underglaze, Slip, Engobe, Stain, Wax resist), Clay body type (SELECT: Earthenware, Stoneware, Porcelain, Raku, Paper clay, Air-dry, Polymer), Firing cone (TEXT), Firing temperature (°C) (NUMBER), Shrinkage (%) (NUMBER), Glaze finish (SELECT: Gloss, Satin, Matte, Crystalline, Crackle, Raw), Food safe (ON_OFF), Batch / lot (TEXT), Colour (COLOUR, reuses) |
| Candle & soap making | `candle-soap` | 🕯️ | Making supply (SELECT: Wax, Wick, Soap base, Lye, Base oil, Fragrance oil, Essential oil, Colourant, Mould, Additive), Wax or base type (SELECT: Soy, Paraffin, Beeswax, Coconut, Rapeseed, Melt-and-pour glycerin, Cold-process, Not applicable), Melt point (°C) (NUMBER), Pour temperature (°C) (NUMBER), Fragrance load (%) (NUMBER), Wick size (TEXT), Batch / lot (TEXT), Skin safe (ON_OFF) |
| Craft vinyl & heat transfer | `craft-vinyl` | 📜 | Vinyl kind (SELECT: Permanent adhesive, Removable adhesive, Heat transfer (HTV), Printable, Glitter, Holographic, Flock, Stencil, Transfer tape), Roll width (mm) (NUMBER), Roll length (m) (NUMBER), Colour (COLOUR, reuses), Vinyl finish (SELECT: Matte, Gloss, Glitter, Metallic, Holographic, Flock), Press temperature (°C) (NUMBER), Press time (s) (NUMBER), Cut settings (TEXT), Peel (SELECT: Warm peel, Cold peel, Not applicable) |
| Craft paper & card | `craft-paper` | 📄 | Paper kind (SELECT: Cardstock, Patterned paper, Vellum, Kraft, Watercolour, Origami, Tissue, Adhesive-backed), Weight (gsm) (NUMBER), Sheet size (TEXT), Colour (COLOUR, reuses), Pattern (TEXT, reuses), Paper finish (SELECT: Smooth, Textured, Linen, Gloss, Matte, Metallic, Glitter), Acid-free (ON_OFF), Sheets (NUMBER) |
| Homebrew ingredients | `homebrew-ingredient` | 🍺 | Ingredient kind (SELECT: Malt / grain, Malt extract, Hops, Yeast, Adjunct, Fining, Acid / salt, Nutrient, Fruit / juice), Hop alpha acid (%) (NUMBER), Malt colour (EBC) (NUMBER), Yeast strain (TEXT), Attenuation (%) (NUMBER), Year (NUMBER, reuses), Best before (DATE, reuses — already lead 60), Opened on (DATE, reuses), Storage requirement (SELECT, reuses — Room temperature, Refrigerated, Away from light) |

Descriptions and defaults:

- **Drawing & art media** — *"Pencils, pastels, inks and markers — medium, grade, tip and
  lightfastness."* No defaults. **This settles §6's demotion of `Art supplies`, by the second of the
  two routes §6 offered: find the fields that distinguish it from `Paint`.** Narrowing the preset to
  *dry and drawing* media does that. `Paint` carries Brand, Colour, Colour name, Type (Acrylic,
  Enamel, Lacquer, Watercolour, Oil, Spray) and Finish; this carries `Art medium`,
  `Grade / hardness` (2B, HB), `Tip / nib`, `Lightfastness` and `Set size` — none of which a pot of
  acrylic has. The remaining overlap is Brand, Colour and Colour name, which are shared *definitions*
  in the dictionary rather than duplicated work, exactly as they are across the eleven presets that
  already share `Colour`. Widening `Paint` instead was considered and rejected: a `Type` list holding
  both "Spray" and "Charcoal" describes nothing.
- **Sewing patterns** — *"Paper and PDF patterns — garment, sizes included, fabric needed and whether
  it has been cut."* Defaults: `hiddenCapabilities: ['maintenance', 'perishables', 'batches']`.
  Complements the shipped `Fabric` without touching it: one is the stash, the other is the plan for
  it. `Cut out` is the field a sewer most needs, because a cut multi-size pattern can no longer be
  made in the other sizes.
- **Beads & findings** — *"Beads, clasps and jewellery findings — shape, size, hole and plating."*
  Defaults: `hiddenCapabilities: ['maintenance', 'perishables']`. `Hole size (mm)` looks trivial and is
  the whole game: it decides whether a bead will take the thread.
- **Leather** — *"Hides and offcuts — tannage, thickness in ounces, temper and area."* Defaults:
  `hiddenCapabilities: ['maintenance', 'perishables']`. Thickness in ounces rather than millimetres
  because that is what leather is sold and recorded in.
- **Pottery clay & glaze** — *"Clay bodies and glazes — firing range, shrinkage, food safety and the
  batch a colour came from."* Defaults: `hiddenCapabilities: ['maintenance']`. `Food safe` and
  `Firing cone` are the two facts a potter checks before using anything; `Batch / lot` is the dye-lot
  problem again — two batches of the same glaze fire differently.
- **Candle & soap making** — *"Wax, bases, wicks and fragrance — melt point, fragrance load and pour
  temperature."* Defaults: `hiddenCapabilities: ['maintenance']`. One preset for two crafts is a
  deliberate call: they share a shelf, a supplier and a field set (a melt point, a pour temperature, a
  fragrance load and a batch), and splitting them would ship two thin entries where one honest one
  will do.
- **Craft vinyl & heat transfer** — *"Cutting vinyl and heat-transfer film — finish, roll size and the
  press settings that work."* Defaults: `hiddenCapabilities: ['maintenance', 'perishables']`.
  `Cut settings`, `Press temperature (°C)`, `Press time (s)` and `Peel` are the four numbers a user
  writes on a sticky note and loses; that is bar 2 satisfied about as plainly as it gets.
- **Craft paper & card** — *"Cardstock, scrapbooking and origami paper — weight, sheet size, finish and
  whether it is acid-free."* Defaults: `hiddenCapabilities: ['maintenance', 'perishables']`. **Widened
  from §7's `Scrapbooking paper`**, which was too narrow to clear bar 1 on its own: the same seven
  fields serve cardmaking, origami and general cardstock, and `Acid-free` — the scrapbooker's whole
  concern — stays in the set.
- **Homebrew ingredients** — *"Malt, hops, yeast and finings — the figures a recipe needs, and a
  best-before that alerts."* Defaults: `hiddenCapabilities: ['maintenance', 'kits']`. Filed in
  `crafts` rather than `household`: `Food` is the pantry, and these are raw materials for a process,
  which is what the rest of `crafts` holds. Note that `Best before` is reused **as tier 1 defined it**,
  at `dueLeadDays: 60` — a shorter lead would be a better fit for hops, but a lead is applied on reuse
  and would silently retune the `Seeds` preset, which is exactly the §3 behaviour to avoid restating.
  `Storage requirement` likewise reuses `Medication`'s definition with the identical option list,
  which happens to describe hops and yeast perfectly.

### 11.6 `collectibles` — two proposals, three demotions

§7's own verdict stands: the section is saturated and this is the lowest-value work in the document.
Three of the five bare names fail bar 5 outright against presets that already ship, so only two are
worked up, and both are ranked at the bottom of §11.9.

| Preset | id | Glyph | Fields |
| --- | --- | --- | --- |
| Vintage tools | `vintage-tool` | 🪛 | Maker (TEXT, reuses), Tool kind (SELECT: Plane, Chisel, Saw, Brace / drill, Hammer, Wrench, Measuring, Level, Axe, Other), Maker's mark (TEXT), Patent / date mark (TEXT), Handle material (SELECT: Beech, Rosewood, Boxwood, Ash, Hickory, Plastic, Metal, Other), Restoration (SELECT: Untouched, Cleaned, Sharpened, Rehandled, Fully restored), Complete (ON_OFF, reuses), Working (ON_OFF, reuses) |
| Vintage advertising & signage | `advertising-sign` | 🪧 | Brand / advertiser (TEXT, reuses), Sign kind (SELECT: Enamel / porcelain sign, Tin sign, Painted wood, Neon, Light-up, Display stand, Tin / container, Card / paper), Sign material (SELECT: Enamel on steel, Tin, Aluminium, Wood, Card, Glass, Plastic), Height (cm) (NUMBER, reuses), Width (cm) (NUMBER, reuses), Sign mounting (SELECT: Wall, Hanging, Free-standing, Flange, Post), Double-sided (ON_OFF), Originality (SELECT, reuses — Original, Reprint, Reproduction), Approx. year (NUMBER, reuses) |

- **Vintage tools** — *"Old hand tools kept for the collection — maker, mark, restoration state and
  whether it still works."* Defaults: `hiddenCapabilities: ['maintenance', 'batches', 'perishables']`,
  the standard collectibles set. It does not duplicate the shipped `Tools`, which is an operational
  preset about serial numbers and calibration certificates; nothing on a Victorian plane has either,
  and `Restoration` — the axis the whole market prices on — has no counterpart there.
- **Vintage advertising & signage** — *"Enamel signs, tins and point-of-sale — advertiser, material,
  mounting and how original it is."* Defaults:
  `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`. `Originality` reuses
  `Vintage movie posters`' definition with the identical option list, which is the same distinction
  (original versus reproduction) applied to the same market.

**Demoted: `Signed books`.** It is `Book` plus `Autographs & signed memorabilia`, both shipped, and
the union of their fields is the field set. Bar 5, with nothing left over.

**Demoted: `Keys & keyrings`.** Bar 5 against `Fridge magnets`, which is Theme / origin, Material and
Design — the same three fields a keyring preset would carry, for the same kind of souvenir.

**Demoted: `Bottle caps & breweriana`.** Bar 1 in a saturated section. `Matchbooks & matchboxes`
already covers the advertiser-on-a-small-object shape (Brand / advertiser, Origin, Type,
Completeness), and what a cap collector adds over it — crown versus twist, cork lining — is two
fields.

### 11.7 Field names: what was avoided, and why

Every avoidance below was **verified by running the check, not by reading**: the proposed set was
indexed against all 308 shipped names and all thirteen tier 2 field sets, and each name in the left
column was queried for its existing type and option-list count. The result for the set as proposed is
**0 type clashes, 0 divergent `SELECT` option lists**.

| Natural name | Why it could not be used | Used instead |
| --- | --- | --- |
| `Type` | SELECT *and* TEXT across 20 presets, 18 distinct option lists | `Fitting kind`, `Tool kind`, `Sign kind`, `Bearing kind`, `Tackle kind`, `Gear kind`, `Machine kind`, `Vinyl kind`, `Paper kind`, `Ingredient kind`, `Finding kind` |
| `Material` | TEXT *and* SELECT across 12 presets, 8 distinct option lists | `Fitting material`, `Seal material`, `Bead material`, `Sign material`, `Rim material`, `Handle material` |
| `Finish` | SELECT with 2 divergent lists already | `Glaze finish`, `Vinyl finish`, `Paper finish`, `Plating` |
| `Diameter (mm)` | SELECT in `3D Filament` (1.75 / 2.85) — a NUMBER here would be **rejected at import** | `Rod diameter (mm)`, `Bore (mm)`, `Outside diameter (mm)` |
| `Fuel` | SELECT in `Vehicle` (Petrol, Diesel, Hybrid…) | `Power type` (garden machinery), `Fuel type` (camping stoves) |
| `Speed` | SELECT in `Vinyl record` (33⅓ / 45 / 78 RPM) | `Speed rating` (tyres), `Groupset speeds` (bicycle) |
| `Weight` | SELECT in `Gold & silver bullion` (1 g, 1 oz…) | `Weight (gsm)`, `Packed weight (g)`, `Lure weight (g)` |
| `Size` | SELECT *and* TEXT | `Size range`, `Bead size (mm)`, `Hole size (mm)`, `Sheet size`, `Frame size`, `Wheel size`, `Screen size (in)`, `Wick size`, `Hook size` |
| `Grade` | TEXT *and* SELECT | `Grade / hardness`, `Precision class` |
| `Shape` | SELECT in `Vintage mirrors` | `Bead shape` |
| `Format` | SELECT with 6 divergent lists | `Pattern format` |
| `Storage` | SELECT in `Food` (Pantry, Fridge, Freezer) | `Storage requirement` (reused from `Medication`, identical list) |
| `Nib size` / `Nib material` | SELECT in `Fountain pens` | `Tip / nib` (TEXT) |
| `Power source` | SELECT in `Smart home device` (Mains, Battery, PoE, USB) | `Power type` |
| `Difficulty` | free in the library, but SELECT in tier 2's `Jigsaw puzzle` | `Pattern difficulty` |
| `Interface` | free today; a name audio, storage and sensors would all want, with three different lists | `Sensor interface` |
| `Mounting` | free, and claimed here by `Connectors` — the signage list would have captured its options | `Sign mounting` (signage keeps the specific name; the electronics preset keeps the general one) |
| `Colour` | COLOUR in eleven presets, and the one name §3 flags as broken by `Magic: The Gathering cards` | reused as-is; **inherits the §9 prerequisite** that already gates `Yarn` and `Embroidery floss` |

Two names are shared **only** between proposals in this slice, deliberately and with one type each:
`Batch / lot` (TEXT — welding, pottery, candle) and `Current rating (A)` (NUMBER — electrical wire,
connectors). Both describe the same quantity in each place, so one definition is the right outcome.

Three more are shared with **tier 2** and must stay in step if both ship: `Logic level` (SELECT —
identical list to `Development board`), `Capacity (GB)` (NUMBER — `Storage media`) and
`Alloy / grade` (TEXT — `Metal stock`). If tier 2 ships first they are reuses; if this slice ships
first they are the definitions tier 2 reuses. Either order works; changing one of them in only one
place does not.

### 11.8 Facets these presets would exercise

- **Usage-based maintenance**, still used by exactly one shipped preset (`Vehicle`): `Garden machinery`
  (50 running hours) and `Bicycle` (500 km) would make it three.
- **`dueLeadDays`**, introduced by tier 1: one genuinely new deadline here, `Replace by` on
  `Tyres & wheels` at 60 days. Every other date either reuses a definition that already carries a lead
  (`Expiry date` 30, `Service due` 30, `Best before` 60) or is a plain fact (`Opened on`,
  `Last aired`, `Winterised on`).
- **`CONSUMABLE_GAUGE`**, still used by **no** preset at all: `Electrical wire` is the natural first
  case and is deliberately left at the default here, because introducing the library's first
  gauge-tracked preset is a decision that deserves its own change rather than a line in a batch of
  twenty-five.
- **A `NUMBER` field's `unit`**, still unused: this slice adds twenty-odd fields with the unit baked
  into the name (`Bore (mm)`, `Power (W)`, `Weight (gsm)`), following the existing spelling for
  consistency. Every one of them is a call site the conversion §2 asks for would have to touch, so the
  conversion gets cheaper the earlier it happens.

### 11.9 A proposed tier 2b — and it is a judgement, not data

**Read this as an argued ordering, not a measurement.** It carries the same limit §10 records for the
tier 1 and tier 2 rankings: Gubbins has no telemetry that would say which presets get imported, none
of these field sets has been reviewed by a practitioner in its domain, and the demand judgements come
from the same general reading of home-inventory checklists and hobby write-ups rather than from a
survey. Somebody revisiting this should redo the reasoning, not inherit the list.

Three criteria, applied in this order:

1. **Does it fix a thin section?** `vehicle` and `home-garden` ship with two presets each and
   `workshop` with four. A section that stays that small keeps looking provisional in the rail.
2. **How many households own the thing at all?** Bar 1, applied honestly rather than to the author's
   own interests.
3. **Does it exercise a facet the library still barely uses?** A preset that seeds a usage-based
   service schedule or a due date teaches the feature as well as filling a gap.

**Promote to tier 2b, in order:**

1. **Garden machinery** (`home-garden`) — thin section, near-universal item, and the second usage-based
   service schedule in the library. Clears all three criteria; nothing else does.
2. **Tyres & wheels** (`vehicle`) — finishes the pair tier 1 started, and carries the one new deadline.
3. **Mobile phone** (`electronics`) — the highest ownership of anything in this slice, and the IMEI is
   the single fact users most often go looking for and cannot find.
4. **Garden chemicals** (`home-garden`) — pairs naturally with the shipped `Seeds` and `Plant`, and
   takes the section to five.
5. **Plumbing fittings** (`workshop`) — the most commonly kept household spare not covered by anything
   in the library, and the field set is unambiguous.
6. **Camping gear** (`home-garden`) — brings the section to six, which is where it stops needing
   defending.
7. **Electrical wire** (`workshop`) — a real gap beside `Cable`, and the preset that later makes the
   `CONSUMABLE_GAUGE` case concrete.
8. **Drawing & art media** (`crafts`) — promoted mainly because it discharges a debt: §6 demoted
   `Art supplies` pending a settlement, and this is the settlement. Shipping it closes the question
   rather than deferring it again.

**Stay unranked** (seventeen): `Bicycle`, `Connectors`, `Sensors & modules`, `Audio equipment`,
`Welding consumables`, `Bearings & seals`, `Fishing tackle`, `Sewing patterns`, `Beads & findings`,
`Leather`, `Pottery clay & glaze`, `Candle & soap making`, `Craft vinyl & heat transfer`,
`Craft paper & card`, `Homebrew ingredients`, `Vintage tools`, `Vintage advertising & signage`.

Two notes on the ordering, because both are contestable:

- **`Bicycle` is arguably a top-five candidate** — more households own a bike than a strimmer — and it
  is held back only because it depends on the 🛞 glyph decision in §11.4 being taken first, and because
  `Tyres & wheels` already lifts `vehicle` off two. Move it up if that decision lands early.
- **The `crafts` block is ranked low as a block, not preset by preset.** Each of the nine is
  defensible, but `crafts` already holds five shipped presets plus two in tier 2, and eight more would
  make it the second-largest section in the picker behind `collectibles` — repeating on a smaller
  scale the imbalance §1 exists to correct. Ship them in ones and twos as the crafts they serve come
  up, not as a batch.

Both **collectibles** entries stay last on principle, per §7's own verdict: forty-seven presets in one
section is already the imbalance this document was written to fix, and adding to it is the least
valuable thing on the list even where the individual preset is sound.

## 12. The two thinnest sections, worked up — `media` and `household`

The two thinnest sections were thin in different ways. **`media`** is disc-shaped, as §1 says: seven
of its eight entries are a disc, a book or a poster, and §6's four additions extend it sideways into
music, games and print without touching the two things a household actually accumulates — paper
(magazines, maps, manuals, photographs) and magnetic tape. Nothing in the section covers a document
that is *read* rather than *collected*. **`household`** was thin because it was never really a
household section: before tier 1 it held food, clothes and a collectible, and tier 1's four entries
are all machines and chemicals. Nothing covers the furniture, the linen cupboard, the bathroom
cabinet, the toy box, the pet, or the drawer the passports live in.

Eighteen presets are proposed below — seven for `media`, eleven for `household` — plus four
candidates examined and dropped, four corrections to §6's media entries, and the two judgement calls
§7 leaves open.

Every field name was checked by running the library, not by eye: all 308 existing names for both
failure modes (a name reused with a different `fieldType`, and a `SELECT` name reused with a
different option list), and the 157 distinct names across these proposals against each other. The
run reports **zero** type clashes and **zero** silent option captures. Where a name is reused, the
type matches; where a `SELECT` name is reused (`Media condition`, `Rolled or folded`,
`Storage requirement`, `Power source`), the option list is declared **byte-identical** to the
library's, which is the only safe way to share a `SELECT` name at all.

### 12.1 `media` — seven presets

#### 12.1.1 `magnetic-tape` — Cassette & tape (`media`, 📼)

The one physical format the section omits entirely, and the one most likely to be sitting in a loft
undigitised. Audio and video tape share a preset deliberately: the fields a person records are the
same (what is on it, what kind of tape it is, has it been transferred yet), and two presets of six
fields each would be worse than one of ten.

- One-liner: *Cassettes, reels and video tape — format, stock, condition and whether it has been transferred.*
- Category defaults: `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`.
- Fields: `Title` (TEXT, reuses), `Artist` (TEXT, reuses), `Label` (TEXT, reuses), `Tape format`
  (SELECT — Compact cassette, Microcassette, 8-track, Reel-to-reel, DAT, VHS, Betamax, Video8 / Hi8,
  MiniDV, Other), `Tape stock` (SELECT — Type I ferric, Type II chrome, Type IV metal, Video tape,
  Not stated), `Runtime (min)` (NUMBER, reuses), `Home recording` (ON_OFF),
  `Digitised` (ON_OFF), `Media file` (FILE, reuses — the transferred copy),
  `Media condition` (SELECT, reuses `Vinyl record`'s list exactly).
- `Format` is the library's worst offender and is avoided (`Tape format`); `Type` likewise
  (`Tape stock`). `Home recording` earns its place because it is the one fact that decides whether a
  tape is replaceable, and no built-in facet holds it.

#### 12.1.2 `periodical` — Magazine & periodical (`media`, 📰)

Magazines, newspapers and zines are proposed as **one** preset rather than three. Separately each is
thin and their field sets are the same five facts; together they are a real category with a kind
`SELECT` that does the discriminating. This is also where the standalone `Zine and self-published
print` candidate lands — as an option value, not a preset.

- One-liner: *Magazines, newspapers and journals — issue, cover date and whether the issue is complete.*
- Category defaults: `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`.
- Fields: `Title` (TEXT, reuses), `Publisher` (TEXT, reuses), `Issue number` (TEXT, reuses from
  `Comic books`), `Volume` (TEXT), `Cover date` (DATE), `Periodical kind` (SELECT — Magazine,
  Newspaper, Academic journal, Trade publication, Newsletter, Zine / small press, Supplement),
  `Cover feature` (TEXT), `Complete issue` (ON_OFF — supplements and pull-outs still present),
  `Language` (TEXT, reuses), `Paper condition` (SELECT — Mint, Near mint, Excellent, Very good,
  Good, Fair, Poor).
- **`Paper condition` is a new shared name, and deliberately so.** `Condition` is already a `SELECT`
  with several divergent option lists (§3), so the five paper presets below would each be gambling
  on import order. One new name, one option list — the seven-value grading vocabulary the library
  uses most often — shared by `Magazine & periodical`, `Photographs & negatives`,
  `Art print & poster`, `Maps & atlases` and `Printed ephemera`. `Volume` is free; `Volume (ml)` is
  a different name and a different type, so there is no clash.

#### 12.1.3 `photographic-print` — Photographs & negatives (`media`, 🎞️)

Family archives and darkroom output are both common, both catalogued by the same handful of facts,
and served by nothing in the library — `Vintage cameras` is the equipment, not the output.

- One-liner: *Prints, negatives and slides — medium, process, subject and whether it has been scanned.*
- Category defaults: `hiddenCapabilities: ['maintenance', 'batches', 'kits']` — `perishables` stays
  visible, because film and colour prints genuinely deteriorate.
- Fields: `Photographer` (TEXT), `Photo medium` (SELECT — Print, Negative, Colour slide, Glass
  plate, Instant print, Contact sheet), `Photo process` (SELECT — Silver gelatin, C-type, Dye
  destruction, Albumen, Tintype, Daguerreotype, Inkjet, Unknown), `Film format` (SELECT — 35 mm,
  120 / medium format, Large format, 110, Instant, Not applicable), `Image size` (TEXT),
  `Date taken` (DATE), `Subject / place` (TEXT, reuses from `Postcards`), `Mounted` (ON_OFF),
  `Digitised` (ON_OFF, shared with `Cassette & tape`), `Paper condition` (SELECT, shared),
  `Photo` (IMAGE, reuses).
- Three `SELECT`s that all sound like "format" are the price of avoiding the name `Format` and of
  keeping medium (what the object is), process (how it was made) and film gauge separate — they are
  three different questions and a collector answers all three. `Size` is taken, hence `Image size`;
  `Dye destruction` rather than the trade name for the same process, per public-repo hygiene.

#### 12.1.4 `art-print` — Art print & poster (`media`, 🖌️)

Distinct from the shipped `Vintage movie posters`, which is a film-memorabilia preset: its fields are
`Originality` and one-sheet sizes. This one is about an edition — the number on the sheet, the
signature, the print method — which that preset has none of.

- One-liner: *Prints and posters — method, edition number, signature and how it is stored.*
- Category defaults: `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`.
- Fields: `Artist` (TEXT, reuses), `Print method` (SELECT — Screen print, Lithograph, Giclée,
  Etching, Woodcut, Linocut, Offset, Digital print), `Edition number` (TEXT — "12/100"),
  `Edition size` (NUMBER), `Signed by` (TEXT, reuses from `Autographs & signed memorabilia`),
  `Sheet size` (TEXT), `Paper stock` (TEXT), `Year` (NUMBER, reuses), `Framed` (ON_OFF),
  `Rolled or folded` (SELECT, reuses `Vintage movie posters`' two-value list exactly),
  `Paper condition` (SELECT, shared).
- `Edition` carries two types in the library already (§3) and is avoided twice over:
  `Edition number` and `Edition size` are the two facts a print actually records, and neither is the
  bare name.

#### 12.1.5 `map-atlas` — Maps & atlases (`media`, 🗺️)

Two audiences in one preset: the walker with a shelf of sheet maps who wants to know which sheets
they own before buying another, and the collector of period cartography. Both record scale, area and
edition; nothing else in the library holds any of them.

- One-liner: *Sheet maps, charts and atlases — scale, area covered and edition.*
- Category defaults: `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`.
- Fields: `Title` (TEXT, reuses), `Map kind` (SELECT — Sheet map, Atlas, Wall map, Nautical chart,
  Aeronautical chart, Town plan, Globe), `Map scale` (TEXT), `Area covered` (TEXT),
  `Sheet number` (TEXT), `Map edition` (TEXT), `Publisher` (TEXT, reuses), `Year` (NUMBER, reuses),
  `Laminated` (ON_OFF), `Paper condition` (SELECT, shared).
- `Scale` is a `SELECT` in the library with model-railway values and `Gauge / scale` is taken, so
  `Map scale` (TEXT — a map scale is a ratio, not an enumerable set). `Edition` avoided as above.

#### 12.1.6 `documentation` — Manuals & documentation (`media`, 📘)

The strongest of the seven, and the one that exercises a facet nothing else uses. `TRACKING_MODES`
names "a reference manual" as the worked example of `UNTRACKED` — presence-only, catalogued and
findable with no quantity to count — and no preset in the library sets that mode. It also pairs with
`Appliance`, which already has a `Manual` (URL) field pointing at the same thing.

- One-liner: *Manuals, schematics and service documentation — what it covers, its revision and where the copy lives.*
- Category defaults: `defaultTrackingMode: 'UNTRACKED'`,
  `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`.
- Fields: `Covers equipment` (TEXT), `Document kind` (SELECT — User manual, Service manual, Parts
  catalogue, Schematic, Datasheet, Installation guide, Warranty document), `Document number` (TEXT),
  `Revision` (TEXT), `Year` (NUMBER, reuses), `Language` (TEXT, reuses), `Page count` (NUMBER),
  `Manual` (URL, reuses — the online copy), `Media file` (FILE, reuses — the scan).
- `Type` avoided (`Document kind`). `Datasheet` is an existing URL field on `Electronic component`
  and is *not* reused here: it appears as an option value, which is a different namespace and cannot
  collide.

#### 12.1.7 `ephemera` — Printed ephemera (`media`, 🎟️)

The weakest of the seven and the one to ship last. Tickets, programmes and menus are a real
collecting area the library only glances at (`Postcards`, `Matchbooks & matchboxes`), and the fields
are genuinely different from both. It could equally sit in `collectibles`; it is filed here because
`collectibles` is saturated and this is printed matter.

- One-liner: *Tickets, programmes and printed odds and ends — occasion, date and condition.*
- Category defaults: `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits']`.
- Fields: `Ephemera kind` (SELECT — Ticket, Programme, Flyer / handbill, Menu, Timetable, Letter,
  Label, Trade card), `Event / occasion` (TEXT), `Date issued` (DATE), `Printer` (TEXT),
  `Subject / place` (TEXT, reuses), `Sheet size` (TEXT, shared with `Art print & poster`),
  `Paper condition` (SELECT, shared).

### 12.2 `media` — four candidates dropped, and one section question

- **Audiobook on physical media.** Fails bar 5. `Book` already offers Audiobook in its `Format`
  list, and a boxed CD audiobook is a `Music CD` with a narrator instead of an artist. There is no
  field set here that those two do not already carry.
- **Newspaper as its own preset.** Fails bar 2 on its own — its fields are the periodical fields
  with a different word for "issue". Folded into `Magazine & periodical` as a `Periodical kind`
  option.
- **Zine and self-published print.** Same verdict, same destination: a `Periodical kind` option
  (`Zine / small press`). A separate preset would repeat title, publisher, issue and condition to add
  print-run and binding, which is not enough to justify picker space.
- **E-reader, and digital media as an item.** Rejected on the same grounds §8 rejects
  cryptocurrency: a licensed download has no location, no condition and no quantity, and `Book`
  (`Format: eBook`) and `Movie` (`Format: Digital` plus `Media file`) already record one as an
  attribute of the title. The *device* is a `Computer` — the one concrete change worth making is to
  add **`E-reader`** to that preset's `Chassis type` options, where Tablet and Mini PC already sit.
- **Is `Comic books` filed correctly under `collectibles`?** Yes — leave it. Its field set is
  `Grade`, `Graded / slabbed` and `Key issue`: three grading facts and nothing a reader would fill
  in, which is a collector's schema, not a media one. A section is only a browse aid, so moving it
  would cost nothing at import — but it would put a slabbing checkbox in front of someone who came
  to the section for a reading list. The alternative, a separate `Graphic novel` media preset, fails
  bar 5 against `Book` (author, publisher, ISBN, genre, rating, read status — all of it already
  there). No change.

### 12.3 Corrections to §6's four media presets

Taken as given, sanity-checked against the collision rule. Three of the four are clean; two field
names in the remaining pair should change before they ship, and one is a duplicate concept rather
than a collision.

| §6 preset | Finding |
| --- | --- |
| Music CD | Clean. `Artist`, `Label`, `Catalogue number`, `Release year`, `Rating` and `Cover art` all reuse existing definitions at the right types; `Album`, `Discs` and `Release edition` are new names, and `Release edition` correctly sidesteps `Edition`. |
| Tabletop RPG book | Clean. `Game system` reuses the `Warhammer` definition (TEXT), `Book kind` and `Ruleset edition` correctly sidestep `Type` and `Edition`. |
| Jigsaw puzzle | Two changes. **`Difficulty` (SELECT) should be `Puzzle difficulty`** — the bare name is free today, but it is exactly the generic `SELECT` name a board-game or video-game preset will want next with a different list, which is the §3 trap in its purest form. And **`Pieces` (NUMBER) duplicates `Piece count` (NUMBER, `LEGO sets`)** — not a collision, since the types agree, but two names for one quantity in one library; reuse `Piece count`. `Pieces missing` stays as it is, and is reused by `Toys` below. |
| Sheet music | Clean. `Score format` and `Musical key` correctly sidestep `Format` and a bare `Key`; `Difficulty grade` sidesteps `Grade` (TEXT) and does not collide with it. |

### 12.4 `household` — eleven presets

Ten come from §7's list; the eleventh (`Home safety equipment`) the list misses, and it is the best
of the set. Field types are the real `FIELD_TYPES` values. Where a shared `DATE` definition already
carries a `dueLeadDays`, these presets declare **the same** value — see the warning at the end of
this section.

#### 12.4.1 `furniture` — Furniture (`household`, 🛋️)

Distinct from `Antique furniture` (`collectibles`, 🪑), whose fields are period, provenance and
restoration. This one is about the piece as an asset: where it goes, whether it fits, and whether the
assembly instructions can be found again.

- Category defaults: `defaultTrackingMode: 'SERIALISED'`, `defaultCondition: 'GOOD'`,
  `hiddenCapabilities: ['perishables', 'batches']`.
- Fields: `Furniture kind` (SELECT — Seating, Table, Bed, Storage / cabinet, Desk, Shelving, Soft
  furnishing, Outdoor), `Room` (TEXT), `Width (cm)` (NUMBER, reuses), `Depth (cm)` (NUMBER),
  `Height (cm)` (NUMBER, reuses), `Frame material` (TEXT, reuses from `Vintage mirrors`),
  `Upholstery` (TEXT), `Flat pack` (ON_OFF), `Manual` (URL, reuses — the assembly instructions),
  `Acquired on` (DATE, reuses).
- `Depth (42mm units)` exists (Gridfinity) but is a different name; `Depth (cm)` is free. `Material`
  carries two types in the library and is avoided — `Frame material` and `Upholstery` are the two
  materials a piece of furniture actually has.

#### 12.4.2 `light-bulb` — Light bulbs (`household`, 💡)

The classic "buy the wrong one twice" item, and one where the fields are the entire value: nobody
remembers whether the hall takes a GU10 or an E14 while standing in a shop.

- Category defaults: `hiddenCapabilities: ['maintenance', 'perishables', 'kits']`.
- Fields: `Lamp cap` (SELECT — E27, E14, B22, B15, GU10, G9, G4, MR16, Linear tube, Other),
  `Lamp technology` (SELECT — LED, Halogen, Incandescent, CFL, Fluorescent tube, Decorative
  filament), `Wattage (W)` (NUMBER), `Brightness (lm)` (NUMBER), `Colour temperature (K)` (NUMBER),
  `Dimmable` (ON_OFF), `Light fitting` (TEXT — which lamp or room it serves).
- Overlaps `Filters & consumables`, which offers `Bulb` as a `Consumable kind`. It still clears bar 5:
  that preset's fields are `Fits appliance` and `Change due`, and none of the six facts above is
  expressible in it.

#### 12.4.3 `toiletries` — Toiletries & cosmetics (`household`, 💄)

The period-after-opening idea §7 flags, made concrete. A cosmetic carries **two** dates and they mean
different things: a printed expiry that applies to the sealed product, and an open-jar symbol giving
a number of months from first use. Gubbins cannot derive the second from the first — nothing adds
months to a date — so the user records the PAO figure as a number *and* the date it lands on, and it
is that date that alerts.

- Category defaults: `hiddenCapabilities: ['maintenance', 'kits']`.
- Fields: `Product kind` (SELECT — Skincare, Haircare, Cosmetics, Fragrance, Oral care, Shaving, Sun
  care, Bath & shower, Other), `Shade / scent` (TEXT), `Volume (ml)` (NUMBER, reuses),
  `Opened on` (DATE, reuses), `Period after opening (months)` (NUMBER),
  `Discard after` (DATE, `dueLeadDays: 14`), `Expiry date` (DATE, reuses, `dueLeadDays: 30`),
  `Allergens` (TEXT, reuses from `Food`).
- `Discard after` is a new name rather than a reuse of `Expiry date` precisely so the two can carry
  different leads: fourteen days' notice on a mascara, thirty on a sealed bottle. `Allergens` reusing
  the `Food` definition is correct — a fragrance allergen list is the same kind of fact.

#### 12.4.4 `bedding-linen` — Bedding & linens (`household`, 🛌)

- Category defaults: `hiddenCapabilities: ['maintenance', 'perishables', 'kits']`.
- Fields: `Linen kind` (SELECT — Duvet, Duvet cover, Sheet, Pillowcase, Blanket, Throw, Towel,
  Tablecloth, Mattress protector), `Bed size` (SELECT — Single, Small double, Double, King, Super
  king, Cot, Not applicable), `Tog rating` (NUMBER), `Thread count` (NUMBER), `Fibre` (TEXT, reuses
  from `Yarn`), `Colour` (COLOUR, reuses), `Care` (TEXT, reuses from `Yarn`), `In rotation` (ON_OFF).
- `Size` is a `SELECT` in `Clothing` with garment sizes, so `Bed size` — this is the same shape of
  problem `Card colour` and `Yarn weight` solved. `Colour` (COLOUR) inherits the §9 prerequisite that
  `Yarn` and `Embroidery floss` already carry: settle the `Colour` conflict first.
- 🛏️ belongs to `Vintage quilts & textiles`; 🛌 is free, and the repetition would not have been
  clearly more literal in either direction.

#### 12.4.5 `pet-supplies` — Pet supplies (`household`, 🐾)

- Category defaults: `hiddenCapabilities: ['maintenance', 'kits']`.
- Fields: `Animal` (SELECT — Dog, Cat, Small mammal, Bird, Fish, Reptile, Other), `Supply kind`
  (SELECT — Food, Treats, Medication, Grooming, Bedding, Toy, Litter, Equipment),
  `Portion guide` (TEXT), `Weight (g)` (NUMBER, reuses), `Opened on` (DATE, reuses),
  `Expiry date` (DATE, reuses, `dueLeadDays: 30`), `Vet-prescribed` (ON_OFF),
  `Reorder link` (URL, reuses from `Filters & consumables`).
- `Species` (TEXT) exists on `Plant` and is deliberately **not** reused: an owner records "cat", not
  a binomial, and reusing the name would put a botanical field on a bag of dry food. `Animal` as a
  `SELECT` is the shape that actually gets filled in.

#### 12.4.6 `baby-child-gear` — Baby & child gear (`household`, 🍼)

Gear with a **safety expiry** is unusual, real, and badly served by anything else: a car seat has a
manufacture date and a use-by, and both matter. The preset is the second-best argument in this
document for `dueLeadDays`.

- Category defaults: `defaultCondition: 'GOOD'`, `hiddenCapabilities: ['maintenance', 'kits']`.
- Fields: `Gear kind` (SELECT — Pushchair, Car seat, Cot / bed, High chair, Carrier, Bath &
  changing, Monitor, Safety gate, Feeding), `Age range` (TEXT), `Weight limit (kg)` (NUMBER),
  `Compliance standard` (TEXT, reuses from `First aid kit`), `Manufactured on` (DATE),
  `Expiry date` (DATE, reuses, `dueLeadDays: 30`), `Recall notice` (URL), `Outgrown` (ON_OFF).
- `Manufactured on` is also proposed by §6's `Safety equipment (PPE)`, at the same type — a shared
  definition, not a collision, and the right outcome. `Standard` alone would be another `Grade`-class
  name; `Compliance standard` already exists at TEXT and fits exactly.

#### 12.4.7 `toys` — Toys (`household`, 🪀)

The household counterpart to `Action figures`, `LEGO sets` and `Board games`, which are all
collector-shaped (rarity, exclusivity, sealed-in-box). A toy box asks three questions instead: what
is it, is it complete, and has it been grown out of.

- Category defaults: `hiddenCapabilities: ['maintenance', 'perishables']`.
- Fields: `Toy kind` (SELECT — Construction, Figure / doll, Vehicle, Puzzle, Game, Ride-on, Soft toy,
  Craft, Electronic), `Recommended age` (TEXT), `Character` (TEXT, reuses from `Action figures`),
  `Batteries required` (TEXT), `Pieces missing` (NUMBER, reuses §6's `Jigsaw puzzle` definition),
  `Boxed` (ON_OFF, reuses), `Instructions` (ON_OFF, reuses from `LEGO sets`),
  `Outgrown` (ON_OFF, shared with `Baby & child gear`).
- 🧸 belongs to `Funko Pop figures`, hence 🪀. This is the household preset closest to an existing
  one; it clears bar 5 on its field set, but it is the first I would cut if the section is judged too
  large.

#### 12.4.8 `documents` — Documents & records (`household`, 🗂️)

See §12.5 for whether this earns its place at all. If it ships, it ships as `UNTRACKED`.

- Category defaults: `defaultTrackingMode: 'UNTRACKED'`,
  `hiddenCapabilities: ['maintenance', 'batches', 'perishables', 'kits', 'variants']`.
- Fields: `Record kind` (SELECT — Passport, Driving licence, Certificate, Insurance policy, Deed /
  title, Contract, Tax record, Medical record, Warranty, Other), `Holder` (TEXT),
  `Issuing body` (TEXT), `Reference number` (TEXT, reuses from `Luxury watches`),
  `Issued on` (DATE), `Expires on` (DATE, `dueLeadDays: 60`), `Original or copy` (SELECT — Original,
  Certified copy, Photocopy, Digital only), `Media file` (FILE, reuses — the scan).
- **`Expires on` is a new name, not a reuse of `Expiry date`, and the reason is a genuine hazard.**
  `dueLeadDays` *is* applied on reuse (§3), so a preset declaring `Expiry date` with a 60-day lead
  would silently re-lead `Food`, `Adhesive`, `Medication` and `Cleaning & household chemicals` from
  30 to 60. A passport wants two months' notice and a yoghurt does not, so the two deadlines need two
  definitions. The same rule governs `Best before` below.

#### 12.4.9 `home-safety` — Home safety equipment (`household`, 🧯)

**Not on §7's list, and the strongest candidate in this section.** Smoke and CO alarms and
extinguishers are near-universal, legally significant in rented property, and the only household
items with a *routine test schedule* — which makes this the preset that uses
`defaultMaintenanceBasis` for exactly what it was built for. `First aid kit` is the nearest existing
preset (`containers`) and shares no fields with it.

- Category defaults: `defaultCondition: 'GOOD'`, `defaultMaintenanceBasis: 'TIME'`,
  `defaultMaintenanceIntervalDays: 30` (the monthly alarm test),
  `hiddenCapabilities: ['batches', 'kits']`.
- Fields: `Safety device kind` (SELECT — Smoke alarm, Heat alarm, Carbon monoxide alarm, Fire
  extinguisher, Fire blanket, Escape ladder, Water leak alarm), `Compliance standard` (TEXT,
  reuses), `Power source` (SELECT, reuses `Smart home device`'s list exactly — Mains, Battery, PoE,
  USB), `Installed on` (DATE, reuses from `Appliance`),
  `Last tested` (DATE), `Service due` (DATE, reuses from `Vehicle`, `dueLeadDays: 30`),
  `Replace by` (DATE, `dueLeadDays: 30`), `Interlinked` (ON_OFF).
- Alarms carry a hard end-of-life date ten years from manufacture, which is `Replace by`;
  extinguishers carry a service interval, which is the reused `Service due`. They are different
  deadlines and both belong.

#### 12.4.10 `coffee-tea` — Coffee & tea (`household`, ☕)

A domain with a well-established vocabulary and nothing in the library that holds any of it. Roast
date in particular is the fact enthusiasts care most about and the one no built-in facet expresses —
purchase date is not roast date.

- Category defaults: `hiddenCapabilities: ['maintenance', 'kits']`.
- Fields: `Beverage kind` (SELECT — Coffee beans, Ground coffee, Coffee pods, Loose leaf tea, Tea
  bags, Matcha, Herbal infusion), `Origin` (TEXT, reuses), `Roast level` (SELECT — Light,
  Medium-light, Medium, Medium-dark, Dark, Not applicable), `Processing method` (SELECT — Washed,
  Natural, Honey, Anaerobic, Not applicable), `Roasted on` (DATE),
  `Best before` (DATE, reuses, `dueLeadDays: 60`), `Opened on` (DATE, reuses),
  `Weight (g)` (NUMBER, reuses), `Tasting notes` (TEXT), `Brew method` (SELECT — Espresso, Filter /
  pour-over, Cafetière, Immersion, Moka pot, Cold brew, Steeped), `Caffeinated` (ON_OFF).
- `Brew method` names techniques, not products, and the one option that would otherwise be a brand
  (a plunger-style immersion brewer) is written as `Immersion`.
- The `Best before` lead of 60 is inherited from `Seeds`, not chosen: declaring anything else would
  retro-change the seed packets. Sixty days' notice on a bag of coffee is generous but harmless; the
  alternative is a `Use by` name of its own, which is not worth a second definition.

#### 12.4.11 `spice` — Spices (`household`, 🧂)

The weakest of the eleven, kept because §7 names it and because the fields are defensible, but the
one to reconsider first. It is `Food` with four extra facts, and the alternative — widening `Food` —
is a real option.

- Category defaults: `hiddenCapabilities: ['maintenance', 'kits']`.
- Fields: `Spice form` (SELECT — Whole, Ground, Flakes, Paste, Blend, Extract), `Origin` (TEXT,
  reuses), `Blend components` (TEXT), `Heat level` (SELECT — None, Mild, Medium, Hot, Very hot),
  `Storage requirement` (SELECT, reuses `Medication`'s list exactly — Room temperature,
  Refrigerated, Away from light), `Container volume` (TEXT, reuses from `Cleaning & household
  chemicals`), `Opened on` (DATE, reuses), `Best before` (DATE, reuses, `dueLeadDays: 60`).
- `Form` is a `SELECT` in two presets with two different lists (§3) and is avoided; `Storage` is a
  `SELECT` on `Food` with Pantry/Fridge/Freezer, so `Storage requirement` — which is the right list
  anyway, since a spice's enemy is light, not warmth.

### 12.5 Judgement call — where does `Documents & records` belong, and does it belong at all?

**The objection is real.** A passport has no condition anyone tracks, no purchase price, no supplier,
no warranty and no quantity. Four of the five built-in facets are meaningless for it, and the fifth —
location — is the only one anyone cares about. On bar 2 as written ("if the item needs nothing beyond
the built-in facets, a preset adds nothing"), a document arguably fails from the opposite direction:
it needs *almost nothing the built-ins offer*, which is a different kind of poor fit.

**It earns its place anyway, and bar 2 is what earns it.** The bar asks whether the preset saves work
beyond the built-in facets, and here it plainly does: the expiry of a passport, a licence, an
insurance policy or a warranty is a deadline the app can raise, and `dueLeadDays` on `Expires on` is
the whole feature. "Where is the birth certificate" plus "what expires in the next two months" is a
genuine, common, badly-served problem, and no other preset in the library answers it. What the
objection actually establishes is not that the preset should be dropped but *how it must be
configured*: `defaultTrackingMode: 'UNTRACKED'` — the mode `TRACKING_MODES` documents as
"presence-only: catalogued, searchable and locatable, but with no quantity to count" — and a wide
`hiddenCapabilities` that takes maintenance, batches, perishables, kits and variants off the screen
before the user ever sees them. Configured that way, none of the meaningless facets is ever shown,
and the objection dissolves into a defaults question.

**Where it belongs:** `household`, for now. It is not a *home* in the way furniture is, and in a
larger taxonomy it would sit with a future `admin` / `records` grouping alongside insurance and
receipts — but that grouping does not exist, has one member, and §4's objection to a three-preset
`health` section applies with more force to a one-preset one. `household` is where a person keeps
their filing cabinet, literally and in the picker.

### 12.6 Judgement call — does `household` now need splitting?

**The arithmetic.** `household` holds seven today (Food, Clothing, Vintage kitchenware, Appliance,
Medication, Filters & consumables, Cleaning & household chemicals). Adding the eleven above takes it
to **eighteen** — larger than every section except `collectibles` (47), more than twice `media` with
its additions, and roughly a quarter of the whole library in one rail entry.

**The case for splitting.** Eighteen is past the point where a section is a *category* and into where
it is a *list*, which is the exact complaint §1 makes about `collectibles`. It is also the least
coherent eighteen in the library: a fire extinguisher, a duvet, a passport, a bag of coffee and a
tumble dryer share nothing except a postcode. §4 already conceded the principle when it pulled
`home-garden` and `vehicle` out rather than let `household` become the catch-all, and it named that
risk explicitly ("putting the garden there too turns it into the catch-all section"). The split it
avoided has simply arrived by a different route.

**The case against.** A split costs two catalog labels in every language, a `SECTION_LABEL_KEY`
entry and a `PRESET_SECTION_IDS` change, and it buys navigability only if the new boundary is one
users predict. Two sections both named after the home are ambiguous in a way `vehicle` and
`home-garden` are not — a person looking for `Light bulbs` does not first decide whether a bulb is
durable — and a wrong guess is worse than a long list, because the picker has search and the rail
shows per-section counts. §7's own note says to check how the picker reads at the new size before
assuming.

**Verdict: split, but not in the same change, and not into `health`.** Ship the eleven into
`household` first and look at the picker at eighteen; if it reads as a list rather than a section —
which I expect — split it on the one line that is both predictable and already drawn by the app's
own facets, **durables versus things that run out**:

| Section | Holds | Count |
| --- | --- | ---: |
| `household` (the home itself) | Appliance, Furniture, Bedding & linens, Clothing, Toys, Baby & child gear, Home safety equipment, Documents & records, Vintage kitchenware | 9 |
| `supplies` — label "Supplies & consumables" | Food, Spices, Coffee & tea, Medication, Toiletries & cosmetics, Cleaning & household chemicals, Filters & consumables, Light bulbs, Pet supplies | 9 |

Nine and nine, both substantial, and the boundary is one the facets already draw: everything on the
right is expiry-and-reorder shaped (`Expiry date`, `Best before`, `Opened on`, `Reorder link`),
everything on the left is warranty-and-maintenance shaped. It is the same distinction the item model
makes between perishables and assets, surfaced in the picker.

**And `health` stays rejected**, on the fuller list as on the old one. The candidates are
`Medication`, `Toiletries & cosmetics` and — at a stretch — `First aid kit` (currently `containers`)
and `Baby & child gear`. Two of those four are poor fits: a moisturiser is not health, and a
pushchair certainly is not. §4's objection was that three presets is a thin rail entry; the fuller
list does not fix that, it just makes the section harder to name. The durables/consumables split
above puts `Medication` and `Toiletries` together anyway, which is most of what a `health` section
would have achieved, without asking a user to decide whether sun cream is medicine.

## 13. The shipped library, audited inward

The library's problems are no longer at its edges. Read inward rather than outward, the 84 shipped
presets show three facets still barely used, a units convention that cannot be converted the way §2
assumed, a `hiddenCapabilities` "pattern" that turns out to be a section boundary wearing a
judgement's clothes, and a handful of field sets that do not clear the bar §2 sets for a new
candidate. Two of the findings are defects rather than preferences: a preset's due-date alerts
currently depend on which *other* presets the user imported, and four presets ship a custom
`Expiry date` field that duplicates the item's own expiry facet without feeding any of the machinery
hanging off it.

Every count below was computed over `CATEGORY_PRESETS` rather than read off the page. The stubbed
copy the scripts import differs from `src/features/inventory/category-presets.ts` only in the two
`@/` import lines, which were replaced with local stubs; the preset data is byte-identical.

### The three unused facets, as they now stand

§2 called all three untouched across the 72 presets of the time. Tier 1 moved two of them and left
the third exactly where it was.

| Facet | Presets setting it | Which |
| --- | ---: | --- |
| `defaultMaintenanceBasis` | 4 of 84 | Appliance, Filters & consumables, Plant (`TIME`); Vehicle (`USAGE`) |
| `defaultMaintenanceIntervalDays` | 3 of 84 | Appliance 365, Filters & consumables 90, Plant 7 |
| `defaultMaintenanceIntervalUsage` | 1 of 84 | Vehicle 10000 |
| A `DATE` field's `dueLeadDays` | 6 field declarations across 4 presets | Medication (`Expiry date` 30), Filters & consumables (`Change due` 14), Seeds (`Best before` 60), Vehicle (`Service due`, `Roadworthiness test due`, `Insurance renewal`, all 30) |
| A `NUMBER` field's `unit` | **0 of 84** | — |

The library declares **541** custom fields under **308** distinct names (438 under 225 names before
tier 1). **21** of those declarations are `DATE`; **15** carry no lead. **60** are `NUMBER`; not one
carries a unit. So `unit` is still a facet the shipped library has never exercised, and the twelve
tier 1 presets did not change that — they moved the maintenance and lead facets only.

**Pre-existing presets with an obvious, correct value and no declaration.** These are judgements
about what the value *should* be; the "missing" part is measured.

| Preset | Facet | Proposed value | Why it is obvious |
| --- | --- | --- | --- |
| `Tools` | maintenance | `TIME` / 365 | It already ships a `Calibration certificate`, and `CONDITIONS` carries `OUT_FOR_CALIBRATION` for exactly this item. A calibrated tool has an interval by definition |
| `Tools` | `dueLeadDays` | a new `Calibration due` (DATE, 30) | The certificate is a link to the last calibration; nothing records when the next one falls |
| `First aid kit` | maintenance | `TIME` / 180 | The preset already carries `Contents last checked` and `Needs restocking` — that is a schedule spelt out as three fields |
| `First aid kit` | `dueLeadDays` | `Earliest expiry` → 30 | The field's entire purpose is a deadline; it is the one pre-existing date most clearly built for the opt-in |
| `Food` | `dueLeadDays` | `Expiry date` → 30 | See below — it is already getting one, but only by accident |
| `Adhesive` | `dueLeadDays` | `Expiry date` → 30 | Same |
| `Seeds` | `dueLeadDays` | `Sow until` → 14 | A sowing window closes; `Sow from` correctly stays an ordinary date. Tier 1's own preset, and the weakest of these — call it a preference |

Left deliberately alone: the 20 collectibles presets that hide `maintenance` cannot carry a schedule,
and the dates that are records rather than deadlines (`Installed on`, `Last changed`, `Fitted on`,
`Acquired on`, `Last repotted`, `Contents last checked`, `Date signed`, `Opened on`) are right to
have no lead.

**A defect falls out of this.** `dueLeadDays` lives on the shared definition and is applied on reuse
but never cleared. `Expiry date` is declared by four presets — `Food`, `Adhesive`, `Medication` and
`Cleaning & household chemicals` — and exactly one of them (`Medication`) declares the lead. So
whether a user's food expiry alerts at all depends on whether they imported Medication, and on
nothing else; import Food alone and the definition is created with a null lead that nothing will ever
set. The comment on the Medication field describes this as intended, and the *outcome* is intended —
but the mechanism is import-order dependence, not a property of the Food preset. **Fix: declare
`dueLeadDays: 30` on all four.** It is idempotent with the reuse rule and makes each preset's
behaviour independent of the others.

### Units in names, and why the conversion is not the one §2 imagined

**34** of the 60 `NUMBER` declarations carry a bracketed unit in the name, under **27** distinct
names. The remaining 26 are genuinely unitless (`Year`, `Piece count`, `Ports`, `Odometer`,
`Minifigures`, `People covered`, …), with the arguable exception of `Odometer` and
`Fitted at odometer`, whose unit a `Vehicle` category cannot know.

§2 proposes "converting the library to `unit`". Run against the real names, a blanket conversion
does not survive contact:

- **Five bare names would merge definitions that measure different things.** `Capacity` would be
  claimed by both `Capacity (mAh)` (Battery) and `Capacity (L)` (Storage tote); `Width` by
  `Width (42mm units)`, `Width (cm)` and `Width (mm)`; `Height` by two; `Length` by three; `Weight`
  by `Weight (g)` and `Weight (ct)`. Because `unit` follows the same set-but-never-clear reuse rule
  as `dueLeadDays`, the *first* import would fix the unit and every later one would silently read in
  it — a millilitre tote, a gram-denominated gemstone. That is strictly worse than the bracket.
- **One would become a hard type conflict.** `Gold & silver bullion` already declares `Weight` as a
  `SELECT`. A de-bracketed `Weight` `NUMBER` collides with it on type, so the two presets become
  mutually exclusive and the second import throws part-way — the loud half of the §3 defect,
  newly created.
- **Six would newly collide with a built-in item attribute** — `Width`, `Depth`, `Height` (from the
  Gridfinity and centimetre names) and `Weight` (from `Weight (ct)`). `builtInFieldNameClash` strips
  a trailing parenthetical from the built-in's own label before comparing, so `Width (cm)` is clear
  today and a bare `Width` would not be. This only warns, it does not block — but the warning exists
  because the duplicate is confusing, and seeding it from a preset is the case the user cannot avoid.
- **One is load-bearing elsewhere.** `Runtime (min)` is the `wikidata-film` provider's
  `defaultTarget`, and a unit test pins the provider's targets to the Movie preset's field names.
  Renaming it breaks the zero-configuration lookup binding unless both move together.
- **Two are the app's own labels for built-in columns.** `Weight (g)` and `Width (mm)` appear
  verbatim in `src/features/search/fields.ts`, `catalog-import.ts`, `text-import.ts` and
  `docs/wiki/Units-of-Measure.md`. The preset field of that name is a *different* thing from the
  built-in column of that name (see below), so those references do not pin the preset — but any
  change here has to be checked against them rather than assumed independent.

**13 of the 27 convert cleanly**, in the sense that the bare name is unused in the library, is not a
built-in attribute, is not a lookup target, and no second bracketed name strips to it. Every unit is
inside `FIELD_UNIT_MAX_LENGTH` (16).

| Current name | Bare name | `unit` |
| --- | --- | --- |
| `Voltage (V)` | Voltage | `V` |
| `Spool weight (g)` | Spool weight | `g` |
| `Print temperature (°C)` | Print temperature | `°C` |
| `Bed temperature (°C)` | Bed temperature | `°C` |
| `Volume (ml)` | Volume | `ml` |
| `Cure time (min)` | Cure time | `min` |
| `Play time (min)` | Play time | `min` |
| `ABV (%)` | ABV | `%` |
| `Thickness (mm)` | Thickness | `mm` |
| `Germination rate (%)` | Germination rate | `%` |
| `Memory (GB)` | Memory | `GB` |
| `Length per ball (m)` | Length per ball | `m` |
| `Ball weight (g)` | Ball weight | `g` |

**Recommendation.** Do not convert the library. Convert the 13 above, leave the other 14 spelt as
they are, and record in the file's header comment *why* the bracket survives on the rest — otherwise
the next author reads a half-converted library as an unfinished job and finishes it into the merge
above. The payoff for the 13 is real rather than cosmetic: `CustomFieldsEditor` labels the input
through `inventory.fields.unit.withName`, and `custom-fields.ts` renders the value as `5 V`, so the
unit shows in both places without the name having to carry it. The cost is one rename each on any
existing user's category, which is the same cost the §3 fix already carries; do the two together if
they land in the same release.

Two adjacent findings worth folding into the same change:

- **`Gold & silver bullion`'s `Weight` is a `SELECT` of measurements** (`1 g`, `5 g`, `1 oz`, `1 kg`,
  `Other`). A quantity of metal is the one thing a bullion owner wants to total, range-filter and
  convert, and a dropdown of strings can do none of it. It should be a `NUMBER` — `Bullion weight`,
  unit `g` — which also retires one of the two names that block the `Weight` conversion above.
- **`3D Filament`'s `Diameter (mm)` is the library's only all-numeric `SELECT`** (`1.75`, `2.85`).
  Here the dropdown is defensible — filament comes in two diameters and typing one is an error
  waiting to happen — but it should be said out loud in a comment, because it reads as the same
  mistake as the bullion one.

### Field sets that do not clear bar 2 or bar 3

Selected, not exhaustive. The library's median field count is 6; the range runs from 4 (`Tools`,
`Clothing`, `Adhesive`, `Fridge magnets`, `Shot glasses`, `Snow globes`) to 16 (`Movie`).

| Preset | Fields | What is wrong | Proposed correction |
| --- | ---: | --- | --- |
| `Clothing` | 4 | Fails bar 3 hardest of any preset. `Size` is a fixed `XS`–`XXL` dropdown, which fits t-shirts and nothing else — no shoe size, no waist/inside leg, no numeric dress size — and the set misses what a wardrobe is actually catalogued by: what the garment *is*, and when it is worn | `Garment type` (SELECT), `Size label` (TEXT — free text covers every sizing scale), `Colour` (COLOUR), `Material` (TEXT), `Brand` (TEXT), `Season` (SELECT), `Care` (TEXT) |
| `Tools` | 4 | The library's flagship preset, and it records a calibration *certificate* with no calibration *date* and no schedule — the one preset where the maintenance facet is unarguable | Add `Calibration due` (DATE, `dueLeadDays: 30`), `defaultMaintenanceBasis: 'TIME'`, `defaultMaintenanceIntervalDays: 365` |
| `Food` | 5 | `Expiry date` duplicates the built-in expiry facet (see below), and `Opened` is an `ON_OFF` — a boolean cannot answer "how long has this been open?", which is the only reason a pantry records it | Drop the custom `Expiry date`; `Opened` → `Opened on` (DATE, a definition tier 1 already created) |
| `Adhesive` | 4 | Same two faults, and worse: shelf life *after opening* is the whole point for a cyanoacrylate or a two-part epoxy | Same: rely on the built-in expiry, `Opened` → `Opened on` (DATE) |
| `Everyday Carry (EDC) gear` | 5 | Bar 2. `Type`, `Brand`, `Model`, `Material` are a plain category with a dropdown, and `Everyday carry` (ON_OFF) on a category called Everyday Carry is a field that is true by construction. Three of its five names are among the library's most overloaded | Either drop `Everyday carry` and add something that earns its place (`Pocket` / `Weight`), or retire the preset |
| `Shot glasses` / `Fridge magnets` | 4 each | Bar 2. `Theme / origin` plus `Material` plus `Condition` is what a plain category with a photo already gives. They are not wrong, they are just not worth a preset slot | Leave as they are, but treat them as the floor: a new candidate at this level should be refused |
| `Smart home device` | 8 | Tier 1, and inconsistent with the two siblings it shipped beside: `Computer` and `Network equipment` both set `defaultTrackingMode: 'SERIALISED'` and both carry `MAC address`; this one records equally per-unit facts (`Firmware version`, `Paired to hub`) and does neither | Add `defaultTrackingMode: 'SERIALISED'` and `MAC address` (reuses the existing definition) |
| `Perfume & fragrance bottles` | 6 | Declares a field literally named `Name`, which is the item's own built-in attribute. An item shows "Name" twice, in two places, holding two values | Rename to `Fragrance name` |

`Movie`'s 16 fields are the outlier in the other direction, and are **not** a finding: it is the one
preset with a lookup provider, which fills nine of them with no configuration, and the one with a
`fieldTabLabel` to hold them. Recorded so a later reader does not mistake it for bloat.

### `hiddenCapabilities`: the pattern is a section boundary

Current figures: **31** of 84 presets set it. **27** start from `['maintenance', 'batches',
'perishables']`, of which **13** add `'kits'`. Those two numbers match §2 exactly — but the split
underneath them does not mean what §2 says it means.

| Group | Count | `+kits` |
| --- | ---: | ---: |
| `collectibles` in the base pattern | 20 | 6 |
| `media` in the base pattern | 7 | **7** |
| Everything else setting it | 4 | 1 |

Every one of the seven `media` presets sets the identical four-id list. Not one collectible has to.
So "13 of 27 add `kits`" is really "all 7 media presets, plus 6 collectibles" — and those six
(`Coin`, `Banknote`, `Comic books`, `Matchbooks & matchboxes`, `Postcards`, `Stamps`) are simply the
flat-paper ones. There is no property that makes a stamp less of a kit than a trading card, a snow
globe or an enamel pin; the 14 without `'kits'` are indistinguishable from the 6 with it. **The
pattern is right and the exception is noise:** every preset in the base group should carry all four,
and the two presets where `kits` is genuinely meaningful (`LEGO sets`, `Model kit`) correctly set
nothing at all.

The larger break is the other way round. `hiddenCapabilities` is set on **20 of 47** collectibles and
**7 of 7** media, and on **4 of the remaining 30** presets — Food, Medication, Seeds, Plant. So:

- **27 collectibles set nothing**, including ten that are `SERIALISED`: `Antique furniture`,
  `Fountain pens`, `Gold & silver bullion`, `Handbags`, `Luxury watches`,
  `Mechanical wrist watches`, `Musical instruments`, `Retro arcade & pinball machines`,
  `Typewriters`, `Vintage cameras`. A serialised, individually-collected object is the exact case the
  base pattern was written for. Only `Autographs & signed memorabilia` is both serialised and
  hidden. **This is inconsistency, not judgement** — the file's own comments give the same reason
  ("nothing to service, nothing to expire, no lots") above presets that set it and omit it above
  presets that do not.
- **Nothing outside `collectibles`, `media`, `household` and `home-garden` sets it at all.**
  `batches` and `perishables` are as meaningless for `Computer`, `Network equipment`, `Vehicle`,
  `Tools` and `Gridfinity bin` as they are for a coin. Tier 1 shipped five presets into `electronics`
  and `vehicle` and set `hiddenCapabilities` on none of them.

The four non-collectible uses are each individually right, and are the best evidence that the facet
is a judgement rather than a formula: `Food` hides only `maintenance` because a pantry genuinely does
batch and perish; `Seeds` hides `maintenance` and `kits` and keeps both the others for the same
reason; `Plant` hides `batches` and `kits` but must keep `maintenance`, because its watering
*is* the schedule; `Medication` adds `variants`, the only preset in the library to hide it. §2 calls
`Food` "the odd one out" — measured against the rest of the library it is the only one that looks
like it was decided rather than copied.

### `defaultTrackingMode`, `defaultCondition`, `defaultWarrantyMonths`

| Facet | Presets | Which |
| --- | ---: | --- |
| `defaultTrackingMode` | 17 of 84, all `SERIALISED` | Tools, Movie, Appliance, Vehicle, Computer, Network equipment, and 11 collectibles |
| `defaultCondition` | 2 of 84 | Tools (`GOOD`), Appliance (`GOOD`) |
| `defaultWarrantyMonths` | 3 of 84 | Tools 12, Appliance 24, Computer 12 |

**`defaultTrackingMode`.** The 17 are individually defensible; the omissions are less so.
`Smart home device` is the clearest (see above). `Vehicle part` is deliberately not serialised and
should stay that way — spares are stock. Beyond that the gaps are preferences rather than defects:
`Retro gaming consoles & cartridges` mixes consoles with cartridges, and `Board games`, `LEGO sets`
and `Model trains` are all arguable either way. One measured oddity worth a comment rather than a
change: `Movie` is `SERIALISED` while `Blu-rays`, `DVDs` and `Video games (physical)` — the same kind
of object — are not.

**`defaultCondition`.** Two presets is not an oversight. `CONDITIONS` is
`MINT | GOOD | NEEDS_REPAIR | OUT_FOR_CALIBRATION`, an *operational* state for equipment, not a
grading scale; seeding `GOOD` on a collectible would assert something the collector has not said. The
facet is correctly sparse, and the pressure the library actually shows is the opposite one — 32
presets ship their own `Condition` `SELECT` because the built-in enum cannot express a grade. Only
`Musical instruments` looks like a genuine miss, and it is marginal.

**`defaultWarrantyMonths`.** Three presets, and the gaps are obvious. `Network equipment` and
`Smart home device` are consumer electronics that ship with a warranty exactly as `Computer` does;
`Vehicle` has one too. None sets it. A judgement, but a cheap and consistent one: 12 months on all
three, or a stated reason for treating them differently from `Computer`.

### Field names that duplicate a built-in item attribute

This is a *different* axis from the field-versus-field collisions in #715, and it is not covered
there: these are collisions between a preset's field name and an attribute every item already has.
`builtInFieldNameClash` exists precisely to warn a user away from them — but a preset import never
goes through the naming UI, so a preset is the one path that seeds the collision silently.

**54 of 84 presets** declare at least one such field; **81** declarations across **10** names.

| Field name | Built-in it duplicates | Presets |
| --- | --- | ---: |
| `Condition` | `Condition` | 32 |
| `Manufacturer` | `Manufacturer` | 15 |
| `Model` | `Model` | 13 |
| `Serial number` | `Serial number` | 10 |
| `Expiry date` | `Expiry date` | 4 |
| `Weight (g)` | `Weight (g)` | 3 |
| `Weight` | `Weight (g)` | 1 |
| `Name` | `Name` | 1 |
| `Width (mm)` | `Width (mm)` | 1 |
| `Notes` | `Notes` | 1 |

Most of these are defensible and should stay. `Manufacturer`, `Model` and `Serial number` are
deliberately shared definitions and the item's built-ins for the same concepts are optional columns
many users never fill; `builtInFieldNameClash`'s own docstring makes exactly that argument, and the
decision recorded there is "warn, don't reserve". `Condition` is unavoidable while the built-in enum
is operational rather than a grading scale.

Two are not defensible:

- **`Name` on `Perfume & fragrance bottles`.** Every item has a name; this one asks for a second.
  Plain defect, one-word fix (`Fragrance name`).
- **`Expiry date` on `Food`, `Adhesive`, `Medication` and `Cleaning & household chemicals`.** The
  item already carries an expiry date, and it is not decorative: it drives the perishables
  capability, the alert lane (`alerts.ts`), the "Soon to Expire" widget and its
  `EXPIRY_SOON_WINDOW_DAYS`, the `expiry:` search field, the inventory filter bar's "expiring" chip
  and the `Expiry date` column of the catalogue importer. The custom field of the same name drives
  *none* of them — it goes down the separate `field-due` lane instead. So a `Food` item shows two
  "Expiry date" inputs; the one the preset put there is the one the reports ignore. `Food` compounds
  it by hiding only `maintenance`, which leaves the built-in perishables section visible right
  beside its duplicate. **This is a defect, and the most consequential thing in this audit.**

`Weight (g)` and `Width (mm)` sit in between: they are duplicates, but of columns the presets'
domains genuinely mean differently (a gemstone's carat weight is not the item's shipping weight), and
they are already entangled in the `unit` question above. Fold them into whichever change settles that.

### What warrants its own issue

| Finding | Verdict | Issue? |
| --- | --- | --- |
| Custom `Expiry date` duplicating the built-in expiry facet in four presets | Defect. Two inputs, one of them inert as far as every expiry report is concerned | **Yes.** Its own issue — the fix has to decide, per preset, between dropping the field and keeping it, and that decision is bigger than a preset edit |
| `dueLeadDays` on the shared `Expiry date` declared by only one of its four presets | Defect. A preset's alerting depends on which other presets were imported, and in what order | Fold into the above — same four presets, same file |
| `Name` on `Perfume & fragrance bottles` | Defect, trivially | No. Fold into any preset change |
| Ten serialised collectibles omitting the base `hiddenCapabilities` pattern | Inconsistency, not a defect — nothing breaks, the user just sees sections that will always be empty | No. A single tidy-up change across the file |
| Six of twenty base-pattern collectibles adding `'kits'` and fourteen not | Inconsistency. The distinction does not correspond to anything | Same change as above |
| `unit` still unused; 13 names convert cleanly and 14 do not | Enhancement | **Yes**, scoped to the 13 — and the issue should say plainly that the other 14 are deliberate, or the next author will finish the job into a silent unit merge |
| `Gold & silver bullion`'s `Weight` as a `SELECT` of measurements | Defect in modelling — the one number a bullion owner wants to total cannot be totalled | Fold into the `unit` issue; it also unblocks one of the 14 |
| `Clothing`'s `XS`–`XXL` size dropdown | Fails bar 3 | No. A preset-content change |
| `Tools` with a calibration certificate, no calibration date and no schedule | Gap, in the library's flagship preset | No, but do it — and note the test pins `Tools`' exact field array, so it moves with the change |
| Preset field names duplicating built-in item attributes generally | Mostly deliberate; two cases are not | Fold the two into #715's remit if that issue is widened from field-versus-field to field-versus-built-in; otherwise leave the other eight alone |

## 14. The demand evidence, cited

This section replaces the uncited demand ranking §10 disclaims. It is an evidence base, not a
survey: it establishes what published checklists, participation studies and comparable tools
actually say, so the ordering in §5–§7 can be checked against something rather than trusted. It
settles the *household* half of the ranking reasonably well, the *hobby* half poorly, and nothing at
all about Gubbins' own users, who remain unobserved.

All sources were accessed on **2026-08-29**. Every figure is labelled **participation** (how many
people or households do a thing), **market** (money or units), or **judgement** (an inference, with
the inference stated). Where a domain has no credible source, that is recorded as a finding rather
than filled in.

### 14.1 What this evidence base can and cannot bear

Three bodies of evidence were gathered, and they are not equally strong.

- **Home-inventory and insurance checklists** are the strongest. Eighteen were read; the itemised
  fillable-form ones enumerate several hundred named items between them. They are direct evidence of
  what a household is *told* to record.
- **Participation and market figures** are the weakest, and unevenly so. Some domains have a
  government survey behind them, some a trade-association press release from 2006, and some nothing
  at all.
- **Comparable tools** turned out to be more useful as a negative result than a positive one, with
  one exception noted in §14.4 that is the only user-authored demand signal in the whole section.

Three limits apply throughout. First, the checklists are written for an insurance claim, which is a
different purpose from a home inventory — they over-weight replacement value and under-weight
anything cheap that is merely annoying to lose track of. A checklist's silence is therefore weak
evidence of low demand and strong evidence only that *insurers* do not care. Second, the checklist
corpus is Anglo-American (US state insurance departments, US insurers, UK insurers, the ABI), so its
vocabulary is not jurisdiction-neutral. Third, the insurer lists and the app taxonomies answer
different questions: insurers optimise for walking the house without missing a room, which is why
State Farm's set puts "Attic" beside "Jewelry Furs" without embarrassment, whereas an inventory app
optimises for retrieving one item later. They are a good completeness check on the library's item
types and a poor model for its structure.

### 14.2 What home-inventory and insurance checklists actually name

Eighteen sources were read: six US state insurance departments or regulators, six named insurers,
two UK insurers or comparison services, the ABI, the NAIC, the Insurance Information Institute and
FEMA. Full citations are in §14.9.

**The most useful structural finding is that prose guidance is nearly worthless as evidence and
printed forms are not.** The NAIC, Illinois, South Dakota and California pages enumerate no item
categories at all — they say "room by room" and stop. All the real vocabulary lives in the fillable
forms: Missouri's 24-page checklist, North Carolina's inventory chart and Mercury's eight-page form
carry roughly 250, 200 and 150 pre-printed line items respectively, and State Farm publishes 36
separate room-and-category inventory aids.

| Domain (as a §5–§7 candidate) | Named by | Tier in this document |
| --- | ---: | --- |
| Furniture | all 18 | 3 |
| Clothing | all 18 | shipped |
| Jewellery | 11 of 18, usually flagged for a rider or sub-limit; State Farm gives it its own aid (`Jewelry Furs`) | **absent from the document entirely** |
| Appliances | 13 of 18 | 1 (shipped) |
| Computers and electronics | 18 of 18 | 1 (shipped) |
| Tools and workshop | 9 of 18; State Farm has a `Tools` aid | shipped |
| Books, CDs, records, DVDs, video games | 7 of 18, usually itemised separately; State Farm has a `Books` aid | shipped / 2 (`Music CD`) |
| Sports and exercise equipment | 9 of 18; North Carolina devotes a section to it, State Farm has both `Sporting Good Equipment` and `Home Gym` | 3 |
| Garden and lawn machinery | 7 of 18 (mowers, trimmers, hoses, snow blowers) | 3 |
| Bicycles | 6 of 18, several as a separately specified item | 3 |
| Musical instruments | 4 of 18; State Farm has a `Musical Instruments Equip` aid | shipped, but only as a *collectible* |
| Collectibles (coins, stamps, art, antiques) | 9 of 18, almost always as an undifferentiated lump | shipped (47 presets) |
| Camera equipment | 2 of 18, but State Farm gives it a dedicated aid | **absent** (`Vintage cameras` covers only the collectible) |
| Firearms | 4 of 18 plus FEMA; State Farm has a `Firearms Ammunition` aid | 8 (rejected) |
| Pet supplies | 2 of 18 (Missouri; State Farm's `Pet Care Items`) | 3 |
| Toiletries and cosmetics | 3 of 18 | 3 |
| Cleaning supplies | 2 of 18, as value, never as hazard | 1 (shipped) |
| Craft, sewing and hobby *supplies* | 4 of 18, always as an undifferentiated lump — no source names a specific material | 1–2 (`Yarn`, `Embroidery floss`) |
| Medications | **2 of 18** (Missouri, North Carolina); State Farm's `Medical Equip Health` is adjacent but is equipment | 1 (shipped) |
| Smart home devices | **2 of 18 — but both print it as a row in *every room*** | 1 (shipped) |
| Living plants | **1 of 18** (Missouri's "Planters, plants") | 1 (shipped) |
| Vehicles | **0 of 18, and explicitly excluded.** North Carolina: include everything "except vehicles, animals and items that are insured under other policies". Boats, trailers and bicycles are in; cars are not | 1 (shipped) |
| Network equipment | **0 of 18** | 1 (shipped) |
| Filters, consumables and spare parts | **0 of 18** | 1 (shipped) |
| Seeds | **0 of 18** | 1 (shipped) |

Field-level the checklists are near-unanimous: **serial number** (9 ask for it by name), **model or
brand**, **purchase date**, **purchase price**, **photographs** (all 18), **receipts** (7).
**Warranty is the outlier — only two ask for it**, which is worth noting given that
`defaultWarrantyMonths` is a facet §5 leans on for `Appliance` and `Computer`.

### 14.3 Participation and market figures, by domain

| Domain | Figure | Type | Source (full citation in §14.9) |
| --- | --- | --- | --- |
| Home gardening (US) | Participation fell from 84.1% to 79.2% of US households in 2025 — **~4.5m households left gardening**. Read as directional: the percentage's base is not defined on the free page, and the two figures are not arithmetically reconcilable without the household count, which is inside the paid report | participation | Garden Research / National Gardening Association, *National Gardening Survey*, 2026 edition |
| Gardening (UK) | 77% of British adults have access to a private garden (~44m); 58% of those grow plants, trees or flowers; **31% of British adults grow their own herbs, fruit or vegetables** | participation | Horticultural Trades Association, *Garden Industry Statistics* (figures attributed "HTA, 2025") |
| Garden access (GB) | 12% of GB households — one in eight — have no access to a private or shared garden; 21% in London | participation (access, not activity) | Office for National Statistics, May 2020 |
| Garden market (US) | $79.0bn total US lawn and garden spend in 2025, +13.5%; $740 per participating household | market | Garden Research, as above |
| Garden market (UK) | ~£9bn retail garden products, 2025 | market | Horticultural Trades Association, as above |
| Pet ownership (UK) | 62% of UK households own at least one pet; 36.5m pets. Kantar online survey, 8,951 respondents, Jan 2026, ±1% at 95% | participation | UK Pet Food, *UK Pet Population* |
| Car access (UK) | 78% of households had access to at least one car in 2024; 22% none | participation | DfT, *National Travel Survey 2024* |
| Cycle access (England) | 75% of those aged 5–10 and 64% of 11–16 own or have access to a pedal cycle; 25% of those 60+ | participation | DfT, *Walking and cycling statistics, England 2023* |
| Sport and activity (England) | 64.6% of adults (30.9m) met the CMO 150-minute guideline, Nov 2024–Nov 2025 | participation | Sport England, *Active Lives Adult Survey* |
| Musical instruments (US) | 52% of US households have at least one person aged 5+ who currently plays an instrument | participation, **but 2006 fieldwork**, and no repeat was found | NAMM / The Gallup Organization |
| Craft generally (US) | 64% of households said someone had taken part in a creative activity in the past 12 months, up from 56% in 2010; sample c. 10,000 | participation, **but 2016 fieldwork**, and AFCI no longer exists under that name | Association For Creative Industries, *Creative Products Size of the Industry Study* |
| Craft generally (UK) | 73% of UK adults bought craft in 2019 | **purchasing, not making** — do not read as participation | Crafts Council, *Market for Craft*, 2020 |
| Knitting and crochet | "More than 50 million people of all ages know how to knit, crochet and craft with yarn" | participation, but **unusably weak**: no fieldwork date, sample or methodology, and "know how to" is not "do" | Craft Yarn Council |
| Vinyl | $1.04bn US revenue from **46.8m units** in 2025, a 19th consecutive year of growth | market and units | RIAA, *2025 Year-End Music Industry Revenue Report* (16 Mar 2026); see the hedge in §14.9 on the unit split |
| CDs | **29.5m units** in the US in 2025, roughly a third of vinyl's revenue | market and units | as above |
| Trading cards | Toys was the fastest-growing of all industries Circana tracks in early 2025, driven by Pokémon and sports cards; collectibles +33%. **19% of US adults bought Pokémon cards for themselves in the past six months**, only about a quarter of whom play the game | the 19% is participation (Circana March Omnibus Survey); the rest is market | Circana, *Toy Industry US Sales Grow in Early 2025* |
| Tabletop RPGs | "More than 50 million fans" of *Dungeons & Dragons* | **neither participation nor market** — a publisher's promotional figure with no stated basis; an upper bound of unknown tightness | Hasbro press release, 2024 |
| Tabletop miniatures | Revenue £617.5m FY2024-25, 570 stores | market only; **no participation figure exists** | Games Workshop, *Annual Report 2024-25* |
| Home car maintenance | DIY is "roughly 19–20% of all automotive parts sales" in the US | **market share of parts sales, not participation** — it says nothing about how many motorists service their own car | Auto Care Association, *Auto Care Factbook* and its commentary |
| Smart home (UK) | Ofcom's annual Technology Tracker (2025 fieldwork Jan–Apr 2025) is the right instrument | — | **No figure is quoted.** The core data tables are a PDF too large to retrieve, and every readily available percentage traced back to a marketing blog blending Ofcom with YouGov. Recorded as an open gap, not a number |

**Domains with no credible primary figure at all:**

- **Consumer 3D printing.** Every household-penetration figure found traces to a vendor, a brokerage
  estimate or a content blog. No trade association or statistical agency appears to measure it. This
  does not affect `3D Filament`, which already ships, but it means the tier 2
  `Resin & casting supplies` candidate has no participation evidence behind it.
- **Scale model making and miniatures.** Games Workshop's revenue is the only hard number, and it is
  one company's turnover, not a hobby's headcount.
- **Model railways, and hobby manufacturing generally.**
- **Tabletop RPG *players*.** The publisher's "50 million fans" is the only figure in circulation.
- **Homelab and self-hosting.** No survey of any kind was found. `Computer` and `Network equipment`
  rest entirely on §5's argument about the bridge's audience, which is a judgement.
- **Sheet music, jigsaw puzzles, embroidery floss, resin casting, metal stock, PPE.** No
  domain-level figure of any kind. These tier 2 placements are unevidenced by this strand.

### 14.4 What comparable tools ship

Sixteen products were checked against their own documentation, seeders or schema rather than review
sites: ten self-hosted or open-source, six consumer or insurer-published. The headline result is
negative and worth stating plainly.

> **Almost no comparable tool ships a home-inventory category taxonomy.** Homebox ships two entity
> types (Item, Location) and zero templates. InvenTree ships no categories in the product — the 28 in
> circulation are a separate, destructive demo dataset. Part-DB requires the user to build the
> category tree and ships literal `Node 1.1.1` placeholders. Koillection ships a palette of 17 field
> types and no collection templates. Grocy's product groups and Snipe-IT's 15 categories are demo
> seeds behind an optional command that overwrites the database. Sortly and Nest Egg ship no category
> list at all.

Two ship something real. **Shelf.nu** seeds seven generic buckets on every new workspace — Office
Equipment, Cables, Machinery, Inventory, **Furniture**, Supplies, Other. **Binary Formations** ships
unnamed default categories in Home Inventory, and its sibling Under My Roof ships six named field
layouts: **Art, Automobiles, Books, CDs/Records, Computer Software, DVD/Blu-ray Discs**. Binary
Formations is also the only precedent for the library's central architectural idea — a category owns
a field layout, so category *is* item template. Homebox's entity-type-to-template link is the only
self-hosted equivalent, and it ships nothing in it.

So the tools evidence cannot rank demand, and the preset library has no real comparator for its
premise. It is useful for four other things.

**One tool is a genuine demand signal, and it is the only one in this section for the hobby half.**
Memento Database publishes a community template catalogue with per-category counts: Business 541,
Health 157, **Home and Hobbies 132**, Research 113, Finance 49, Education 47, Cooking and Food 40,
Media and Entertainment 37, Sports 22, Travel 11. These are templates people wrote for themselves
and published, which is closer to revealed demand than anything else here. Named examples include
"Yarn Stash", "Fabric Stash", "Seed Bead Inventory", "Seeds & Plant Gardening Tracker", "Houseplant
Inventory", "Medication Tracker with Refill Management", "Adhesives", "The Battery Maintenance
Protocol", vehicle maintenance logs with brake-thickness tracking, "US Coin Collection Inventory",
"Philatelic Stamp Collection Database", "Watch Collection Inventory", "The Forensic Vinyl Collection
Master", and wine inventories with drinking windows. **Treat this as weak evidence**: the authors
are self-selected, no download or usage counts are published, and a catalogue entry proves one
person wanted it, not that many did. It is nonetheless the only source in this entire section that
speaks to `Yarn`, `Seeds`, `Plant` and `Medication` at all, and it speaks in their favour.

**The recurring per-item service interval is unoccupied ground.** Of sixteen tools, exactly two ship
one: Grocy (chore `period_type` / `period_days`, including an *Adaptive* mode learned from past
execution, plus battery `charge_interval_days`) and Tracktor (vehicle servicing). Binary Formations
has a real repeating schedule but binds it to the *property* — "clean the gutters", not "this
filter". Everyone else offers a one-shot date visibly straining against the use case: Homebox's
`scheduled_date`, whose own docs concede "limited support for complex scheduling of maintenance
events"; Snipe-IT's `next_audit_date`; Shelf.nu's single-`DateTime` `AssetReminder`, documented *for*
"maintenance tasks, inspections" with no repeat option; Sortly's date field plus an alert. This is
independent support for §2's observation that `defaultMaintenanceBasis` and
`defaultMaintenanceIntervalDays` are the most valuable unused facets in the library.

**A type-level default expiry is the pattern `Medication` and `Filters & consumables` want.**
InvenTree carries a part-level "default expiry in days" that auto-computes each stock item's date,
plus a stale-days warning threshold; Grocy carries per-product default best-before days, and
separate best-before-after-opening and after-freezing values. Both are more expressive than
`dueLeadDays` alone.

**Shipped vocabularies beat free text.** SpoolmanDB ships 33 named filament materials with densities
and temperatures — the strongest external argument for the library's `SELECT` option lists, and by
the same token a reason §3's silent option-capture defect matters more than it looks.

**What the tools cover that the library does not.** Furniture (Shelf.nu seeds it; InvenTree's demo
seeds `Furniture, Tables, Chairs`). IT beyond one `Computer` type — Snipe-IT separates `Displays`,
`Tablets`, `Mobile Phones`, `Keyboards`, `HDD/SSD`, `RAM` and software licences with seat counts and
expiry. Printer consumables with reorder thresholds, which are min-stock-shaped rather than
service-interval-shaped. Electronic components at real granularity, plus Part-DB's footprint and
manufacturing-lifecycle status as first-class fields. Vehicle depth — Tracktor's odometer, fuel logs,
service history and compliance certificates with renewal reminders. And from the insurer-published
taxonomies, an axis the library has no answer for at all: jewellery and furs, camera equipment, fine
china and silverware, home gym equipment, holiday decorations, pet care items, medical equipment, and
currency and personal documents.

One negative worth recording: **Encircle ended support for its free Home Inventory product on
17 December 2025** and is now a restoration-contractor claims tool. It is out of scope as a
comparable rather than a competitor.

### 14.5 What the evidence contradicts

Five contradictions, in descending order of how much they should change the document.

**1. `Jewellery` is the most-named domain absent from the entire document.** Eleven of eighteen
checklists name it — Triple-I, ABI, AXA, State Farm, Nationwide, Progressive, Mercury, Missouri,
North Carolina, MoneySuperMarket, Allstate — repeatedly singling it out as needing a rider or a
separate sum insured, and State Farm publishes a dedicated `Jewelry Furs` inventory aid. FEMA's
valuables guidance names it too. The library has `Luxury watches`, `Handbags` and
`Gold & silver bullion`, all filed as collectibles, and nothing for the ring in the drawer. The
document neither proposes it in any tier nor rejects it in §8. **This is an omission rather than a
mis-ranking**, and it is the clearest single action arising from this evidence base.

**2. Four §7 candidates are better evidenced than most of §6.** Garden machinery, sports equipment,
bicycles and furniture are named by six to eighteen checklists apiece, and furniture is additionally
seeded by two of the tools. Sheet music, jigsaw puzzles, resin casting, metal stock and PPE — all
tier 2 — have between zero and one source each. Sheet music is the partial exception: North
Carolina's chart lists it, and NAMM/Gallup's 52% is real if elderly. The ranking as it stands places
several near-unevidenced candidates above several well-evidenced ones.

**3. `Vehicle`'s stated justification does not survive contact with the sources — though its
placement does.** §5.1 appeals to "the consumer home-inventory and insurance checklists consulted",
and those checklists **exclude vehicles by design**: North Carolina says so in as many words, because
a car is insured under a different policy. Home-inventory *apps* take the opposite view — Under My
Roof ships an `Automobiles` layout, Tracktor is vehicle-only, and Memento's catalogue is full of
vehicle maintenance logs. `Vehicle` is therefore well supported, but by app precedent and by
ownership data (78% of UK households have car access), not by the checklists the document cites.
The conclusion stands; the argument for it needs replacing.

**4. `Filters & consumables`, `Network equipment` and `Cleaning & household chemicals` have no
external demand evidence of any kind.** No checklist names any of the three; no tool ships a type for
any of them; no participation figure exists. §5.5's premise — "the thing a household runs out of and
only discovers when it needs one" — is not something any source says. All three are defensible on
§2's *other* bar: they exercise `dueLeadDays` and the maintenance facets, and §14.4 shows the
recurring interval is a genuine gap in every comparable tool. That is a real argument, and it is an
argument from the product's shape rather than from demand. The document should make it in those
terms instead of implying a checklist backed it.

**5. `Medication`, `Yarn`, `Seeds` and `Plant` are thinly evidenced by the checklists and better
evidenced by one tool.** Medication appears on two of eighteen checklists, living plants on one,
seeds and yarn on none. Memento's community catalogue carries hand-written templates for all four
("Medication Tracker with Refill Management", "Yarn Stash", "Seeds & Plant Gardening Tracker",
"Houseplant Inventory"), and the gardening participation figures (55% of US households, 36% of UK
adults growing food) support the two garden presets independently. This is the clearest case in the
section where the *insurance* strand and the *user-authored* strand disagree, and the disagreement is
informative: insurers do not care about a £3 seed packet, and the person who wants an inventory does.

Three confirmations, worth recording as such rather than as corrections:

- **`Appliance` and `Computer` are the best-evidenced presets in the library.** Appliances are named
  by thirteen of eighteen sources and electronics by all eighteen, generally with serial and model
  number — exactly the field set §5.1 and §5.7 propose.
- **`Smart home device` is better evidenced than its two-of-eighteen count suggests.** Both sources
  that name it print it as a line in *every room* rather than once, which is a stronger signal than a
  single mention, and it is the only domain where the recently revised checklists differ from the
  older ones in a consistent direction.
- **§8's premise about firearms is factually correct and now citable.** They are named by North
  Carolina, Missouri and Progressive, given a dedicated `Firearms Ammunition` aid by State Farm, and
  named in FEMA's valuables guidance. The rejection rests on other grounds and is unaffected.

### 14.6 Revised ranking

Tier 1 has shipped and is not revisited except where the evidence changes the reason for it. The
revisions are to what comes next.

**Add, as candidates the document does not currently hold:**

| Candidate | Where | Moved by |
| --- | --- | --- |
| `Jewellery` (`household`) | **ship next, ahead of tier 2** | Eleven of eighteen checklists, most flagging it for separate cover; a dedicated State Farm inventory aid; FEMA's valuables guidance. No other unshipped candidate is named by more sources |
| `Camera equipment` (`electronics`) | tier 2 | State Farm publishes a dedicated `Camera Equipment` aid and Missouri itemises cameras. The library's `Vintage cameras` covers the collectible only, and the fields differ (lens mount, body serial, shutter count against era and format) |

**Promote from §7 to §6:**

| Candidate | Moved by |
| --- | --- |
| Garden machinery (`home-garden`) | Texas DOI ("lawn equipment"), Mercury, AXA, North Carolina, Missouri, Progressive, Triple-I — seven sources. Also the clearest remaining use for `defaultMaintenanceBasis: 'USAGE'` after `Vehicle` |
| Sports equipment (`home-garden`) | North Carolina devotes a section to it and State Farm publishes two aids (`Sporting Good Equipment`, `Home Gym`); nine sources in total. Sport England's 64.6% is supporting, not decisive — activity is not equipment ownership |
| Bicycle & parts (`home-garden`) | ABI and AXA both name bikes as a separately specified item; six sources. DfT's cycle-access figures are age-skewed and support ownership being common in households with children rather than generally |
| Furniture (`household`) | Named by all eighteen, and the most granular part of every itemised form; seeded by Shelf.nu and by InvenTree's demo. The counter-argument is §2's bar 2 — furniture may need nothing beyond the built-in facets — and that should be tested before it ships, not assumed |
| Pet supplies (`household`) | UK Pet Food: 62% of UK households, on an 8,951-respondent Kantar survey; Missouri names it and State Farm publishes a `Pet Care Items` aid |
| Toiletries & cosmetics (`household`) | Missouri, North Carolina and MoneySuperMarket name it; Memento's catalogue carries makeup inventories with expiry dates. Period-after-opening exercises `dueLeadDays`, as §7 already notes |

**Demote from §6 to §7:**

| Candidate | Moved by |
| --- | --- |
| Resin & casting supplies | No participation figure exists for consumer 3D printing or resin casting, no checklist names either, and no tool ships a type for them. The least-evidenced entry in tier 2 |
| Jigsaw puzzle | No source of any kind. Mercury and AXA name "toys" and "games" generically, which is not evidence about jigsaws |
| Metal stock, Safety equipment (PPE) | No domain-level source. Both remain defensible on field-set grounds — PPE in particular exercises three date fields — but nothing here supports them on demand |

**Unchanged, and now with a citation behind them:**

- `Music CD` stays in tier 2 and is its best-evidenced member: seven checklists itemise CDs and
  records separately from other media, and the RIAA reports 29.5m US CD units in 2025.
- `Sheet music` stays, on North Carolina's chart plus NAMM/Gallup's 52% of households — weak, dated
  evidence, but more than most of the tier has.
- `Tabletop RPG book` stays. Circana's trading-card data and Hasbro's fan figure both point at a
  large audience; neither is a clean participation measure, so it should not move up.
- §7's judgement that `collectibles` is saturated and adding to it is the lowest-value work in the
  document is **not** contradicted. Circana shows the category growing strongly, but the library
  already holds 47 collectibles presets including trading cards in three flavours, and every
  collectible domain Memento's catalogue names — coins, stamps, watches, vinyl, wine — is already
  covered. Growth in a domain the library already serves is not an argument for serving it again.

### 14.7 Confidence, by tier

**Tier 1 — mixed, and lower than the document implies.** Four of the twelve are strongly evidenced:
`Appliance`, `Computer`, `Vehicle` (on ownership data and app precedent, not on checklists) and
`Seeds` / `Plant` (on gardening participation, not on checklists). `Smart home device` is moderately
evidenced. `Medication` and `Yarn` rest on two checklists and one and zero respectively, plus
Memento's user-authored templates — thin, but not nothing. **`Filters & consumables`,
`Network equipment` and `Cleaning & household chemicals` have no external demand evidence at all**;
they are argued from the product's unused facets, which §14.4 shows is a stronger argument than it
first appears, but is not the argument the document currently makes. `Vehicle part` inherits
`Vehicle`'s case and is not separately evidenced; the Auto Care Association's 19–20% is a share of
parts *sales* and says nothing about how many people fit their own.

**Tier 2 — largely a judgement call, and the evidence does not distinguish its members from tier 3.**
`Music CD` is well evidenced and `Sheet music` weakly so. The remaining eleven rest on the author's
reading of what each domain records, which §2's bar 3 makes a reasonable basis for the *field sets*
but not for the *ordering*. The promotions in §14.6 are not a claim that the promoted candidates are
certainly more wanted; they are a claim that the evidence for them is better, and that a tier
boundary should not sit where the evidence is weakest on the high side.

**Tier 3 — explicitly unranked, and the evidence confirms that was right.** It contains both the
best-evidenced unshipped candidates (furniture, garden machinery, sports equipment, bicycles) and
several with no evidence whatever (beekeeping, aquarium, scrapbooking paper). It is a list of two
different things and would read better split.

**Blunt summary.** The household half of the ranking is now defensible, with the corrections that
jewellery is missing entirely and that four §7 candidates outrank most of §6. The hobby and craft
half is not: outside vinyl, CDs and trading cards, the domains those presets serve are not measured
by anyone whose figures can be cited, and the best available signal is a self-selected community
template catalogue. Where §10 said the ranking should be redone rather than inherited, this section
redoes the part that can be, and reports that the rest cannot be done from public sources at all.

### 14.8 What still cannot be known

**No source in this section says anything about Gubbins' own users.** The app has no telemetry, so
there is no record of which presets are imported, which are imported and then deleted, which
categories users build by hand instead, or which picker searches return nothing. Every statement
above is about households, hobbyists, or other people's software, used as a proxy for a population it
does not describe. A UK contents-insurance form is not a Gubbins user, and neither is a US gardening
household or a Memento template author.

Three things would settle it, in ascending order of cost and descending order of how soon they could
happen:

1. **Ask.** A short, public, opt-in question on the issue tracker or in the wiki — which presets did
   you import, which did you want and not find — would produce a self-selected, non-representative
   answer that is nonetheless real data about *this* project's users, which nothing here is.
2. **Surface the empty search.** Recording locally, and showing the user, the picker searches that
   return no result would name the gaps with none of the privacy cost of usage telemetry, because the
   data need never leave the device.
3. **Opt-in, aggregate, off-by-default import counts.** The only thing that would actually rank the
   library — and the one that has to be weighed against the project's position on telemetry, which
   this document is not the place to settle.

Until one of those exists the ranking is an argued judgement informed by the sources below. That is a
better thing than an argued judgement informed by nothing, and it is still not a result.

### 14.9 Citations

All accessed 2026-08-29.

**Home-inventory and insurance checklists**

| Publisher | Title | URL | Date |
| --- | --- | --- | --- |
| Insurance Information Institute | Brochure: Home Inventory | https://www.iii.org/article/brochure-home-inventory | undated; PDF references 2009/2011 |
| Insurance Information Institute | How to create a home inventory | https://www.iii.org/article/how-to-create-a-home-inventory | © 2026 |
| Missouri Department of Commerce & Insurance | Home Inventory Checklist (24pp PDF) | https://dci.mo.gov/media/141 | 2019 |
| North Carolina Department of Insurance | Homeowners Inventory Chart | https://www.ncdoi.gov/documents/consumer/publications/home-inventory-calculator/open | undated |
| Texas Department of Insurance | A home inventory: Why you need it and how to do it | https://www.tdi.texas.gov/tips/home-inventory.html | updated 18 Aug 2023 |
| California Department of Insurance | Home Inventory Guide | https://www.insurance.ca.gov/01-consumers/105-type/95-guides/03-res/home-inv.cfm | undated |
| Illinois Department of Insurance | Home Inventory | https://idoi.illinois.gov/consumers/consumerinsurance/homeownerrenter/home-inventory.html | undated |
| South Dakota Division of Insurance | Division of Insurance Home Inventory | https://dlr.sd.gov/insurance/general_guidance/home_inventory.aspx | © 2016 |
| Oklahoma Insurance Department | Home Inventory Checklist | https://www.oid.ok.gov/consumers/get-ready/home-inventory-checklist/ | undated |
| National Association of Insurance Commissioners | Home Inventory | https://content.naic.org/consumer/home-inventory | undated; its checklist PDF now 404s |
| FEMA / Ready.gov | Safeguard Critical Documents and Valuables | https://www.ready.gov/sites/default/files/2020-03/fema_safeguard-critical-documents-and-valuables.pdf | 2020 |
| State Farm | Personal Property Inventory Tools (36 room-and-category aids) | https://www.statefarm.com/claims/home-and-property/homeowner-forms | undated |
| State Farm | How to create a home inventory | https://www.statefarm.com/simple-insights/residence/home-inventory-how-to-create-one | 28 Jan 2025 |
| Mercury Insurance | Home Inventory Checklist (8pp PDF) | https://www.mercuryinsurance.com/assets/pdf/Home-Inventory-Checklist.pdf | © 2020, modified 2023 |
| Allstate | How to create a home inventory for insurance claims | https://www.allstate.com/resources/home-insurance/home-inventory | undated |
| Nationwide | How to create a home inventory list | https://www.nationwide.com/lc/resources/home/articles/home-inventory-checklist | undated |
| Progressive | What to Include in a Home Inventory Checklist | https://www.progressive.com/answers/how-to-create-a-home-inventory/ | updated 27 Jun 2024 |
| Association of British Insurers | Home insurance / Valuing your home's contents | https://www.abi.org.uk/products-and-issues/choosing-the-right-insurance/home-insurance/ | © 2026 |
| AXA UK | Calculate the value of your contents for home insurance | https://www.axa.co.uk/home-insurance/tips-and-guides/contents-insurance-calculator/ | 5 Dec 2025 |
| MoneySuperMarket | Contents Insurance Calculator | https://www.moneysupermarket.com/home-insurance/contents-calculator/ | published 28 Jun 2022, updated 6 Mar 2026 |

**Participation and market**

| Publisher | Title | URL | Date |
| --- | --- | --- | --- |
| Garden Research (National Gardening Association) | National Gardening Survey, 2026 edition | https://gardenresearch.com/view/national-gardening-survey-2026-edition/ | 2026 |
| Horticultural Trades Association | Garden Industry Statistics | https://hta.org.uk/news-events-current-issues/industry-data/garden-industry-statistics | page undated; figures attributed "HTA, 2025" |
| Office for National Statistics | One in eight British households has no garden | https://www.ons.gov.uk/economy/environmentalaccounts/articles/oneineightbritishhouseholdshasnogarden/2020-05-14 | 14 May 2020 |
| UK Pet Food | UK Pet Population | https://www.ukpetfood.org/industry-hub/data-statistics-/uk-pet-population-.html | Kantar survey, 8,951 respondents, Jan 2026 |
| Department for Transport | National Travel Survey 2024: household car availability and trends in car trips | https://www.gov.uk/government/statistics/national-travel-survey-2024/nts-2024-household-car-availability-and-trends-in-car-trips | 2024 data |
| Department for Transport | Walking and cycling statistics, England: introduction and main findings | https://www.gov.uk/government/statistics/walking-and-cycling-statistics-england-2023/walking-and-cycling-statistics-england-introduction-and-main-findings-national-travel-survey | 2023 data |
| Sport England | Active Lives Adult Survey, November 2024–25 | https://www.sportengland.org/research-and-data/data/active-lives/active-lives-data-tables | published Apr 2026 |
| NAMM / The Gallup Organization | Gallup Organization Reveals Findings of "American Attitudes Toward Making Music" Survey | https://www.namm.org/news/press-releases/gallup-organization-reveals-findings-american-attitudes-toward-making-music | 2003/2006 fieldwork |
| Association For Creative Industries | Association For Creative Industries Reveals Size of the U.S. Creative Products Opportunity Is $43 Billion | https://www.prweb.com/releases/2017/02/prweb14027504.htm | Feb 2017, 2016 fieldwork |
| Crafts Council | Market for Craft | https://www.craftscouncil.org.uk/insight-and-advocacy/research-library | 2020, 2019 data |
| Craft Yarn Council | Knitting & Crocheting Are Hot! | https://www.craftyarncouncil.com/know.html | undated — no fieldwork date, sample or methodology stated |
| RIAA | 2025 Year-End Music Industry Revenue Report (landing page and the year-end PDF, read directly for the per-format unit split) | https://www.riaa.com/reports/2025-year-end-music-industry-revenue-report-riaa/ · https://www.riaa.com/wp-content/uploads/2026/03/RIAA-Year-End-Revenue-2025.pdf | 16 Mar 2026 |
| Circana | Toy Industry US Sales Grow in Early 2025 | https://www.circana.com/post/toy-industry-us-sales-grow-in-early-2025 | 3 Jun 2025 |
| Hasbro | Dungeons & Dragons Celebrates 50th Anniversary in 2024 with More than 50 Million Fans | https://investor.hasbro.com/news-releases/news-release-details/dungeons-dragons-celebrates-50th-anniversary-2024-more-50 | 2024 |
| Games Workshop Group PLC | Annual Report 2024-25 | https://investor.games-workshop.com/news-posts/annualreport2025 | FY ending 1 Jun 2025 |
| Auto Care Association | Auto Care Factbook; Cost Savings Drives DIY Behavior while Expertise and Experience Influence DIFM | https://www.autocare.org/data-and-information/market-research/Auto-Care-Factbook · https://www.autocare.org/detail-pages/blog/market-insights-with-mike/2024/03/08/cost-savings-drives-diy-behavior-while-expertise-and-experience-influence-difm | 8 Mar 2024 |
| Ofcom | Technology Tracker 2025 — Core Data Tables | https://www.ofcom.org.uk/siteassets/resources/documents/research-and-data/data/statistics/2025/2025-technology-tracker/2025-technology-tracker---core-data-tables.pdf | fieldwork Jan–Apr 2025 |

**Comparable tools — self-hosted and open source**

| Project | Page | URL | Version / date |
| --- | --- | --- | --- |
| Homebox (sysadminsmedia) | Entity Types, user guide | https://github.com/sysadminsmedia/homebox/blob/main/docs/src/content/docs/en/user-guide/entity-types.mdx | v0.26.2, 14 Jun 2026 |
| Homebox (sysadminsmedia) | `entity_template.go` schema | https://github.com/sysadminsmedia/homebox/blob/main/backend/internal/data/ent/schema/entity_template.go | as above |
| Grocy | Grocy — ERP beyond your fridge | https://grocy.info/ | v4.7.0, 28 Aug 2026 |
| Grocy | `services/DemoDataGeneratorService.php` | https://github.com/grocy/grocy/blob/master/services/DemoDataGeneratorService.php | as above |
| Grocy | Chores tutorial (period types) | https://github.com/grocy/grocy-docs/blob/master/tutorials/chores.md | as above |
| Snipe-IT | Seeding the Database | https://snipe-it.readme.io/docs/seeding-the-database | updated 17 Apr 2026 |
| Snipe-IT | Custom Fields | https://snipe-it.readme.io/docs/custom-fields | updated 14 Apr 2026 |
| Snipe-IT | `database/factories/CategoryFactory.php` | https://github.com/snipe/snipe-it/blob/master/database/factories/CategoryFactory.php | `master`, 29 Aug 2026 |
| Shelf.nu | `default-categories.ts` | https://github.com/Shelf-nu/shelf.nu/blob/main/apps/webapp/app/modules/category/default-categories.ts | `main`, 29 Aug 2026 |
| Shelf.nu | Knowledge base: Asset Reminders | https://www.shelf.nu/knowledge-base/asset-reminders | undated |
| InvenTree | InvenTree Demo | https://docs.inventree.org/en/latest/demo/ | docs footer 13 Aug 2026 |
| InvenTree | Stock Expiry | https://docs.inventree.org/en/stable/stock/expiry/ | as above |
| InvenTree | `inventree_data.json`, demo dataset | https://github.com/inventree/demo-dataset/blob/main/inventree_data.json | exported 14 Jul 2026, `source_version` 1.5.0 dev |
| Part-DB | Getting started with Part-DB | https://docs.part-db.de/usage/getting_started.html | undated |
| Part-DB | Concepts | https://docs.part-db.de/concepts.html | undated |
| Koillection | `src/Enum/DatumTypeEnum.php` | https://github.com/benjaminjonard/koillection/blob/1.8/src/Enum/DatumTypeEnum.php | 1.8, 25 Aug 2026 |
| Spoolman / SpoolmanDB | `materials.json` | https://github.com/Donkie/SpoolmanDB/blob/main/materials.json | Spoolman v0.26.1, 7 Aug 2026 |
| Tracktor | README and feature toggles | https://github.com/javedh-dev/tracktor | active development; self-declared not production-stable |

**Comparable tools — consumer and commercial**

| Publisher | Page | URL | Version / date |
| --- | --- | --- | --- |
| Binary Formations | Home Inventory User's Guide | https://binaryformations.com/homeinventory/HomeInventoryUserGuide.pdf | v3.8.1, © 2009–2015 |
| Binary Formations | Under My Roof FAQ (six named preset layouts) | https://binaryformations.com/support/under-my-roof-faq/ | undated |
| LuckyDroid | Memento Database — Template Showcase | https://mementodatabase.com/templates.html | undated |
| LuckyDroid | Memento community templates — Home and Hobbies | https://mementodatabase.com/posts/categories/home-and-hobbies/index.html | undated |
| Sortly | Custom Fields; Folders | https://www.sortly.com/features/custom-fields/ · https://www.sortly.com/features/folders/ | undated |
| Nest Egg Labs | Nest Egg — Inventory (App Store listing) | https://apps.apple.com/us/app/nest-egg-inventory/id431188993 | v4.2.41 |
| Encircle | Exporting Home Inventory data | https://help.encircleapp.com/hc/en-us/articles/38313668823181-How-to-Export-Your-Encircle-Home-Inventory-Data | free Home Inventory product discontinued 17 Dec 2025 |

**Hedges on the citations above.** Five are weaker than a table row makes them look, and are flagged
rather than dropped.

- The RIAA's landing page gives the $11.5bn total but not the per-format unit split. The 46.8m vinyl
  and 29.5m CD figures **were** confirmed against the RIAA's own year-end PDF
  (https://www.riaa.com/wp-content/uploads/2026/03/RIAA-Year-End-Revenue-2025.pdf, "United States
  Wholesale Dollar Value" table). Two cautions on using them: RIAA reports on a **wholesale** basis
  from 2025, so older RIAA retail-value figures are not comparable; and RIAA's 46.8m is *shipments*
  while Luminate's separately-published 47.9m is *retail point-of-sale*. Both are "2025 US vinyl
  units" and they measure different things.
- The Craft Yarn Council's "50 million" carries no methodology and must not be quoted as a survey
  result.
- The AFCI and NAMM/Gallup figures are from 2016 and 2006 respectively, and no more recent
  equivalent was found for either.
- The Ofcom Technology Tracker is named as the correct instrument, but no figure was extracted from
  it because the data tables exceed what could be retrieved. Nothing in §14.3 depends on it.
- Memento's community catalogue publishes category counts but no per-template download or usage
  figures, so it establishes that someone wanted a template, not how many did.
