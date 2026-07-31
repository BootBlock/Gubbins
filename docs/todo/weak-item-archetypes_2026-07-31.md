# What Gubbins is weakest at tracking — archetype audit (2026-07-31)

> **Status:** 🟢 ACTIVE — research complete. `W1a` (custom-field due dates) and `W1b`/`W1c` (a
> number's unit and range) have shipped; `W1d`, the deferred `W1e`, and `W2`–`W10` remain open.

Answers issue [#621](https://github.com/BootBlock/Gubbins/issues/621): *which items, or types of
item, is Gubbins weakest at tracking or managing?*

**How this differs from the earlier audit.** [`feature-gap-audit_2026-07-09`](done/feature-gap-audit_2026-07-09.md)
asked *"what do comparable tools have that we don't?"* and closed every item it found. This one asks
a different question — *"what kind of thing fits our model badly?"* — and reaches a different answer,
because Gubbins' remaining weaknesses are **not missing features**. They are consequences of six
structural choices in the data model, each of which is individually reasonable and collectively
decides what can be tracked at all.

Method: five parallel reads of the schema, the repositories and the feature seams — the item/field
model, time and lifecycle, value and procurement, non-physical things, and measurement/telemetry.
Every absence below was verified by search before being asserted; file references are to the state
of `main` at `1464aabb`.

---

## 1. The finding in one paragraph

Gubbins models **a physical object you own outright, in one place, that you either count or weigh.**
Everything it is weak at is a thing that violates one of those five assumptions — an object with no
body, one you don't own, one that is many things at once, one measured along more than one axis, or
one whose important facts are *dates and readings* rather than *a count*. The category-preset
library disguises this: 72 presets make the app look domain-broad, but what a preset can add is
**flat scalar fields and a few create-time defaults** — and no field it adds can raise an alert,
move a valuation or trigger anything. So a preset *describes* an archetype without ever making the
app **behave** differently for it.

## 2. The six structural causes

Everything in §3 traces to one or more of these. They are the real subject of this audit.

**C1 — A custom field is scalar, untyped beyond format, and never actionable.**
`item_field_values` carries `UNIQUE (item_id, def_id)`
([v1-initial.ts:685](../../src/db/migrations/v1-initial.ts#L685)) — exactly one value per definition
per item, with no ordinal. So **no repeating or table-valued field** exists: a set of readings, a
list of prior owners, a per-position measurement, a lineage. `field_defs`
([:598-606](../../src/db/migrations/v1-initial.ts#L598-L606)) is `name, field_type, options,
description` — **no unit, no min/max, no precision, no pattern**. `FIELD_TYPES` is a closed list of
11 ([constants.ts:305-317](../../src/db/repositories/constants.ts#L305-L317)) with no multi-select,
no money, no reference-to-another-row, and no masked/secret type.

Most consequentially, custom fields are **readable but never actionable**. They are read in plenty of
places — the item form, item cards, search (including typed `>`/`<` comparisons), export, clone, and
the bridge REST/Home Assistant surface, which exposes `fieldValues` as a documented `$select`-able
payload ([item-view.ts:109-111](../../bridge/src/api/item-view.ts#L109-L111)). But **no alert, agenda,
report, valuation or webhook filter touches `item_field_values`** — verified by a whole-repo sweep. So
a user-defined `DATE` raises nothing and a user-defined `Grade` changes no value. The 37 presets that
define their own *Condition* or *Grade* field are, for valuation purposes, decorative.

**C2 — The capability axis is subtractive only, and categories are flat.**
A category grants a fair amount: custom fields, a default tracking mode, condition and warranty
term, and a maintenance schedule actually applied on create. What it can never grant is a
**capability** — it may *hide* one but "must never re-enable what the device has switched off"
([category-capabilities.ts:11-12](../../src/features/inventory/category-capabilities.ts#L11-L12)).
And there is no `parent_id` on a category, so there is no ancestor resolution
([custom-fields.ts:234-238](../../src/features/inventory/custom-fields.ts#L234-L238)) — a "Power
tool" cannot inherit "Tool", which is why *Manufacturer*, *Brand* and *Condition* are restated across
dozens of presets. The single NFT preset models a non-physical thing by adding seven inert fields and
switching three physical capabilities off; that is the whole vocabulary available to an archetype.

The [category-lookups plan](category-lookups_2026-07-31.md) reaches the same diagnosis from the
opposite end — it opens by noting that a category is "just a collection of custom fields, with
nowhere for behaviour to live." That plan gives a category a way to *fill* its fields; this audit is
about giving them a way to *do* something once filled. They are complementary halves of C1/C2.

**C3 — Four tracking modes, all of which assume a body.**
`DISCRETE | SERIALISED | CONSUMABLE_GAUGE | UNTRACKED`
([constants.ts:70](../../src/db/repositories/constants.ts#L70)) — count it, serialise it, weigh it,
or don't count it. `quantity` is an `INTEGER`, so fractional stock is impossible outside a gauge; a
gauge is five scalars on the item row, and is excluded from stock transfer, batch operations, cycle
counting, booking and sale. (It is *not* excluded from valuation — it is valued, always at zero,
which is §5.1.) There is no fifth mode for a thing without a body, and conversion between modes is
refused except `DISCRETE ↔ UNTRACKED`
([constants.ts:87](../../src/db/repositories/constants.ts#L87)).

**C4 — Containment is a table boundary.**
Stock sits at `item_stock (item_id, location_id)` and `stock_batches`; each row points at an item
*and* a place, but the **place column always FKs to `locations`, never to an item**
([v1-initial.ts:1110-1111](../../src/db/migrations/v1-initial.ts#L1110-L1111)). **An item can
therefore never be inside another item.** `items.parent_id` is variants; `kit_components` is a bill
of materials whose assembly consumes its members (reversibly — `DISASSEMBLED` returns them). The
preset library ships four container archetypes — Tool bag, Storage tote, Gridfinity bin, First aid
kit — as *categories of item*, and three of the four fall back to a `Contents` `LONG_TEXT` field of
prose. (Open issue [#617](https://github.com/BootBlock/Gubbins/issues/617) meets the same table
boundary from the other side, though it asks the opposite question — researched separately in
[non-items on a Location](location-non-items_2026-07-31.md), which finds that the boundary is not
what constrains it.)

**C5 — Ownership is unmodelled; custody is one-directional.**
A scan of all 55 tables finds no `owner`, tenure or share column — the only user references are
`api_tokens.user_id` and `item_history.actor_user_id` ("who performed the action"). The only
possession concept is `checkouts`, strictly outbound with a one-hot borrower — contact XOR project
XOR location ([v1-initial.ts:998-1001](../../src/db/migrations/v1-initial.ts#L998-L1001)). Every
**item** row is implicitly "mine, owned outright"; `acquired_at`, `purchase_price` and
`depreciation_months` reinforce it.

**C6 — Per-unit identity is create-time only.**
`serial_number`, `acquired_at`, `warranty_expires_at`, `purchase_price` and `condition` are single
columns on the item row, so 12 identical widgets share one of each. `stock_batches` splits a
quantity into lots, and a lot carries a batch number, lot number and expiry — but no serial, cost or
condition. The only per-unit model is `SERIALISED`, which explodes into N rows, and
`DISCRETE → SERIALISED` is refused as "a lossy row-split… create-time only — make a new item instead"
([constants.ts:82-85](../../src/db/repositories/constants.ts#L82-L85)).

Even `SERIALISED` is thinner than it looks: `createSerialised` resolves the input **once** and varies
only the `serial_no` ordinal across the N inserts
([core.ts:308-316](../../src/db/repositories/item/core.ts#L308-L316)), so creating three units with a
maker's serial writes the *same* `serial_number` to all three. Genuinely distinct per-unit identity
means N separate creates — which makes the schema comment's "each with its own serial number"
optimistic.

## 3. The archetypes, ranked

Ranked by *(how badly it fits) × (how plausibly a Gubbins user owns it)*.

### 3.1 Dimensional and cut stock — **weakest overall**
Timber, sheet goods, wire and cable on a reel, tube, fabric off a bolt, filament, trim, leather.

The `wood-stock` preset offers Thickness / Width / Length as `NUMBER` fields
([category-presets.ts:1818-1828](../../src/features/inventory/category-presets.ts#L1818-L1828)) —
inert per C1. `items.width/height/depth` exist but are documented as a *bounding box of the
article*, one set per item, never per placement or per piece. **No remnant or offcut concept exists
in the schema or the repositories** (the words appear only in wiki prose), and a gauge's only operations
are a signed delta, a weigh-in and a reconfigure — no split that yields a tracked remainder. So
cutting a 2400 mm board into 600 mm + an 1800 mm offcut is unrepresentable; you must hand-create a
second item with no link to the first. Compounding it: no pack/case size exists anywhere
(`pack_qty` is on the *supplier part*, not the item), so "12 boxes = 144 units" is inexpressible,
and `unit_of_measure` is unvalidated free text with no conversion — `consumptionRate` sums grams,
millilitres and screws into one scalar
([ReportRepository.ts:869-878](../../src/db/repositories/ReportRepository.ts#L869-L878)).

Why it ranks first: this is the *core maker/workshop audience*. Two whole preset sections — workshop
and crafts, eight presets between them — are stock that behaves this way.

### 3.2 Documents and paperwork
Manuals, certificates, receipts, warranties as paper, deeds, passports, plans, scanned records.

**Gubbins cannot store a file.** `item_attachments.kind` is `URL | LOCAL_POINTER`
([constants.ts:326](../../src/db/repositories/constants.ts#L326)) — a link or a path string, never
bytes; a `LOCAL_POINTER` degrades to an "Unlinked Local File" placeholder on every other device. The
attachment UI has **no file input at all** — you type a URL or a path. The `FILE` field type likewise
stores an unverifiable string. Every `<input type="file">` in the repo accepts either `image/*`, a
text format the importer parses and discards, or a whole-database backup; none stores bytes against
an item. The only per-item binaries are images (a thumbnail BLOB plus an OPFS full-res, and a
≤512 KiB `IMAGE` field). The UI copy is honest about it — "*Link* reference documents" — but it
means the archetype "a thing whose entire value is the document" has no home.

### 3.3 Entitlements and non-physical holdings
Software licences and keys, subscriptions, domains, memberships, accounts, gift cards, vouchers,
tickets, insurance policies, digital media libraries.

Nothing here exists, and three separate walls stand in the way. There is **no masked field type** —
`FIELD_TYPES` has no secret member, so a licence key goes in a plain `TEXT` field and syncs, backs up
and CSV-exports in the clear, which matters because the wiki states plainly that Gubbins "does not
encrypt your data". Note the precedent, though: the Sync screen already renders the bridge access
token through a masked `Input` hinted "Treated as a secret — stored only on this device"
([SyncScreen.tsx:722-729](../../src/features/sync/SyncScreen.tsx#L722-L729)), so masking is a
*missing field type*, not a missing capability. There is **no renewal concept** — the four alert
lanes are a closed union (`low-stock, expiry, maintenance-due, warranty-due`) and, per C1, a custom
`DATE` field fires nothing, so a subscription renewal cannot be surfaced even if recorded. And there
is **no redeemable balance**: `CONSUMABLE_GAUGE` is nominally a weighing model — `tare_weight` is
"the weight of the empty container" — though `tare_weight >= 0` and the field hint says "Use `0` if
not weighing", so `{unit: '£', capacity: 50, tare: 0}` is legal today. The real obstacle is not the
constraint but that nothing values or reports it: a gauge contributes £0 to every valuation (§5.1).

Warranty deserves a specific note: it is **a date, not an entitlement** — one `TEXT` column on
`items` plus a derived status. No provider, policy number, coverage, transferability or claim record.

### 3.4 Living things — *the issue's own first example*
Plants, propagated cuttings, cultures and ferments, livestock, pets.

No preset exists for any of them. Against the proposed spec specifically:
- **`lineage_grex` / recursive parentage** — partly reachable. `items.parent_id` is a real
  arbitrarily-deep tree with cycle rejection, and `item_relations` is directed
  (`from_item_id`/`to_item_id`) over a closed five-kind vocabulary
  ([item-relations.ts:34-40](../../src/features/inventory/item-relations.ts#L34-L40)). What neither
  carries is *lineage* — a generation, a split date, a "descended from" that survives the parent
  being consumed. And critically `createVariant` **copies nothing from the parent**
  ([variants.ts:37-45](../../src/db/repositories/item/variants.ts#L37-L45)) — a parent's fields, MPN
  or dimensions are not inherited, defaulted or resolved through the chain. Cloning records no link
  at all: `planItemClone` copies ~17 fields but nothing says where the copy came from.
- **`generation_code`, `feed_ratio`** — expressible as inert custom fields (C1).
- **`substrate_decay_date` → flag status + add to shopping list** — not possible, but the reason is
  narrower than "no rule engine". Gubbins has a genuinely capable **query** layer: the search AST
  filters on `expiry` and `warranty` date columns and on custom fields by name with
  `=`/`>`/`<` ([parseASTtoSQL.ts:154-156](../../src/db/search/parseASTtoSQL.ts#L154-L156),
  `translateCustomField` at `:510`), with AND/OR/negation and grouping, and those queries can be
  **saved and named**. What is missing is that **no condition surface can trigger an action.** A
  saved search is something you look at; the webhook filter tree fires only on a change event, never
  on a date arriving; and no alert lane is user-definable. So the condition is expressible and the
  consequence is not.
- **`bloom_telemetry` (a history array)** — impossible by C1; `UNIQUE (item_id, def_id)` permits one
  value per field, and every repeating structure in the schema is a hard-coded child table.
- **Recalculate intervals from ambient temperature / photoperiod** — no environmental input exists
  anywhere in the data model, and a maintenance schedule is an integer day count or a bare usage
  counter, with no recurrence grammar (no RRULE, no "first Monday", no seasonality).

### 3.5 Things you don't own
Borrowed-in tools, rented and leased equipment, communal or club property, items held on consignment.

Per C5, `lease`, `rental`, `consignment`, `co-own`, `tenure` and `custody` return literally zero hits;
`borrow` is everywhere but always outbound. A drill lent *to* you and a drill you own are
indistinguishable rows, and there is no "return by" for the former. Note the asymmetry: the outbound
loan system is genuinely first-class — due dates, a real `renew()` with its own `LOAN_RENEWED` ledger
event, overdue tracking, contacts, conversion from a booking — and there is **no inbound counterpart
at all**.

This is the one archetype where **the documentation already promises what the schema cannot do**: the
wiki and the README both describe contacts as "the people you lend to **and borrow from**"
([Contacts.md:4](../wiki/Contacts.md), [Glossary.md:23](../wiki/Glossary.md)), and the loans page
itself says only "the people you lend to" — so the docs contradict each other as well as the code.
That makes `W5` a correction, not just an addition.

### 3.6 Instrumented and calibrated assets — *the issue's second example*
Test equipment, calibrated tools, watches, instruments — anything whose record is *readings over
time*.

This is the closest to already working, and worth stating precisely. `test_records`
([v1-initial.ts:1776-1788](../../src/db/migrations/v1-initial.ts#L1776-L1788)) gives a serialised
item an append-only log of `kind, name, result, reading, unit, performed_at`. So the watch spec's
`positional_variance` **is** recordable — six rows named "Dial up", "Crown down" and so on, each
with a `s/d` reading. What is missing is everything that makes it a measurement *system*:
- The test is **not an entity** — `name` and `unit` are free text per row, so "Insulation
  resistance" and "insulation res." are unrelated and nothing can enumerate "items due for test X".
- **No limits, so no computed verdict** — `result` is typed by hand; there is no tolerance,
  nominal, or as-found/as-left pair. `'LIMIT'` is a free-text opinion.
- **One scalar per row, with no grouping** — a regulation session across six positions is six
  unrelated rows with no session identity, so it cannot be charted or compared run-to-run.
- **Nothing forward-looking** — no `due_at`, no interval, no certificate number, no reference
  standard. `condition = 'OUT_FOR_CALIBRATION'` is a state with no dates attached, and a calibration
  interval can only be faked as a maintenance schedule that is disconnected from the `CALIBRATION`
  record proving it was done.

### 3.7 Containers that are also assets
A flight case, a toolbox, a tote, a van, a Pelican case, a drawer unit you bought.

Per C4 this is a straight table conflict: as an `item` it can have a price, warranty, condition and
loan history but hold nothing; as a `location` it can hold things but has no cost, condition,
warranty, checkout or maintenance. The schema names the tension itself — finalising an assembly makes
you *choose* between `CONTAINER` (a new Location, parts moved into it and preserved),
`SINGULAR_OBJECT` (a new Item, parts consumed) and `PERMANENT_CONSUMPTION`. You may have the place or
the thing, never both.

### 3.8 Perishables beyond a single date
Opened food, reagents, adhesives and resins with a working life, curing and ageing stock, medication.

Three specific holes, and they share a shape: **the state is a flag where it needed to be a date.**
There is **no "opened on" date** — `food-pantry` and `adhesive` offer an `Opened` `ON_OFF` toggle, so
shelf-life-after-opening cannot be derived. The same pattern recurs as `Sealed` on wine-and-spirits
and `Seasoned` on wood stock, and `adhesive`'s `Cure time (min)` is a duration with no start, so
there is **no curing or ageing window** (no "ready at" or "not before" on any table).

And most sharply: **batch expiry never alerts.** `stock_batches.expiry_date` drives FEFO consumption
correctly, but every attention feed reads `items.expiry_date` only — the predicate is a bare
`expiry_date IS NOT NULL AND expiry_date <= ?` against `items`
([attention-sql.ts:93-95](../../src/db/repositories/item/attention-sql.ts#L93-L95)), and the
stock-recompute triggers propagate quantity only, so nothing lifts a lot's date to the item.
`idx_stock_batches_expiry` is an index no predicate ever uses. See §5.

### 3.9 Vehicles and metered assets
Cars, vans, mowers, generators, compressors, 3D printers, anything serviced on hours or distance.

No vehicle preset, and `MAINTENANCE_BASES` is `TIME | USAGE` — there is no distance basis. A `USAGE`
schedule accepts only a **positive delta** into `usage_since_service`, so an odometer or hour meter
can be *logged* (as an inert `test_records` reading, per §3.6) but nothing differences it into a
schedule, enforces monotonicity, or corrects it downward. The one automated accrual is
`accrue_checkout_hours`, which measures **wall-clock hours a loan was open**, not hours actually run
— and only for loans *begun* after the last service, so a loan straddling a service contributes
zero. On cost: `maintenance_schedules` has no cost column and `project_expenses` has no `item_id`, so
no spend can attach to an asset and total cost of ownership is uncomputable. Parts *can* be linked to
an asset (`SPARE_FOR` / `ACCESSORY_FOR`, `kit_components`), but those links carry no draw and no
cost, so no consumption event is ever attributed to the machine that consumed it.

### 3.10 Bookable spaces and shared resources
Rooms, benches, machine time, a shared workshop slot.

`asset_bookings.item_id` is the only booking target — **a location cannot be booked** — and
`isBookableTrackingMode` refuses a gauge and any DISCRETE item with quantity ≠ 1, so "reserve 3 of
10 chairs" is impossible. A bookable room must be faked as an item, which then acquires a quantity
and a stock ledger it does not want. Bookings also have no recurrence.

### Also weak, lower priority
**Variant matrices** — a tree, not a matrix. A 5-size × 4-colour shirt is 20 hand-made rows; nothing
knows that Size and Colour are the *axes*, and nothing stops two children sharing a pair. (Each row
does carry a per-row SKU — `items.mpn`, surfaced as "MPN / SKU" and exported as `sku` — so the gap is
the matrix, not the identifier.)

**Sets vs members** — a set and its members cannot both be on hand. Assembling as a
`SINGULAR_OBJECT` consumes the pieces; assembling as a `CONTAINER` preserves them but yields a
*place*, not a boxed set you can value, lend or sell as one thing.

**Appreciating collectibles** — the preset library's largest group at 47 of 72 (54 with media). Here
`revaluations` works well, but condition and grade never touch value, and **`SERIALISED` items cannot
be sold or written off at all** ([item/stock.ts:433](../../src/db/repositories/item/stock.ts#L433)),
so the class most likely to be high-value has no disposal-for-value path. The valuation trend also
draws a flat line for a collection that doubled — though that one is a **settled deliberate
decision** (issue #399: the trend answers "how the value you hold today has moved", and the caption
says so), so it belongs here as context, not as a gap.

## 4. Candidate work items

Ranked by *(breadth of archetypes unlocked) ÷ (cost)*. Deliberately weighted toward fixing a **cause**
rather than adding a domain's fields, because the preset library already proves that adding fields
does not make the app track anything better. `W1a`–`W1c` have shipped; everything else is open.

- **`W1` — Make custom fields live.** The single highest-leverage change in the list: give
  `field_defs` a unit, a min/max, and a "surface this" flag, and teach the alert/agenda feeds to
  read `item_field_values` for `DATE` fields. Unlocks renewals, subscriptions, licences, inspection
  dates, substrate-decay dates and curing windows **at once**, and turns the existing 72 presets
  from decoration into behaviour. Addresses C1. Note the split: the "surface this" half is adjacent
  to issue [#619](https://github.com/BootBlock/Gubbins/issues/619) (which is purely presentational),
  but the load-bearing half — feeds reading `DATE` fields — is untouched by it.
  - **`W1a` — DATE fields as due dates. ✅ Shipped** (see [§4.1](#41-w1a--the-due-date-opt-in-shipped)).
  - **`W1b` — a per-definition unit** on `field_defs`, so a `NUMBER` field carries one.
    ✅ **Shipped** (see [§4.2](#42-w1bw1c--a-numbers-unit-and-range-shipped)).
  - **`W1c` — min/max on a `NUMBER` definition**, validated at the point of save through the
    existing `validateFieldValue` seam. ✅ **Shipped** with `W1b` — same surface, one migration
    (see [§4.2](#42-w1bw1c--a-numbers-unit-and-range-shipped)). **Precision was considered and
    deliberately deferred** as `W1e`; §4.2 records why.
  - **`W1e` — decimal precision on a `NUMBER` definition.** Open, split out of `W1c`. Not a third
    bound of the same kind: min/max are pure *constraints*, while precision is half constraint
    ("at most 2 decimal places") and half *display format* ("show `5.5` as `5.50`"). See §4.2.
  - **`W1d` — the "surface this" prominence flag.** Open, and deliberately last. #619 has since
    shipped, so its adjacency is now concrete: a *category* chooses where its whole field set sits
    (`categories.field_prominence`). That is **not** `W1d`, which is per **definition** and would
    let one field outrank its siblings — but it is the surface `W1d` would hang beside, so design
    the two together rather than ahead of each other.
- **`W2` — A repeating (table-valued) field.** Removes the `UNIQUE (item_id, def_id)` ceiling for
  opted-in definitions. Unlocks telemetry logs, per-position measurements, prior owners, lineage
  notes — every archetype whose data is a *series*. Addresses C1. Larger and schema-visible; do
  after `W1`. **Scope it over two subjects:** `location_field_values` carries the identical
  `UNIQUE (location_id, def_id)` ceiling, and now that
  [`N1`/`N2`](location-non-items_2026-07-31.md#11-what-building-n1n2-proved-wrong-2026-07-31) have
  shipped it is the only limit left on what a location's notes can *hold* — so a location-only
  `location_notes` table was rejected in favour of this. (A location's *other* gaps — export, a
  date that raises something, an activity record — are `N4`/`N5`/`N7` there, and are not this.)
  One change over both, the same way `N5` folds into `W1`.
- **`W3` — An item can be a container.** Let a location be backed by an item (or an item declare
  itself a place). Unlocks §3.7 outright and improves §3.1 and kits. Addresses C4. Adjacent to
  [#617](https://github.com/BootBlock/Gubbins/issues/617) — same table boundary, opposite direction
  (that asks for non-items *on* a location; this asks for an item that *is* one), so neither implies
  the other. Structurally the largest item here. See
  [non-items on a Location](location-non-items_2026-07-31.md), whose `N5` is `W1` with a location as
  the subject, and whose `N3` defers to `W2` rather than duplicating it.
- **`W4` — Dimensional stock and remnants.** A length/area tracking mode, or a gauge that splits
  into a tracked remainder. Unlocks §3.1. Consider `pack_qty` on the item at the same time.
- **`W5` — Ownership and tenure.** An `owned | borrowed | rented | leased | shared` field plus an
  inbound "borrowed from / return by" counterpart to `checkouts`. Unlocks §3.5 cheaply — this is
  the best value-per-effort item after `W1`. Addresses C5.
- **`W6` — File attachments held in the app.** Store bytes in OPFS beside the full-res images, with
  the same storage-tier policy. Unlocks §3.2. Note the deliberate constraint it must respect: sync
  and backup must stay honest about what travels.
- **`W7` — Test definitions with limits.** Promote a test to an entity with a unit, nominal and
  tolerance, a due interval, and a session grouping; compute the verdict. Unlocks §3.6 and makes the
  existing `test_records` chartable.
- **`W8` — Meter readings that drive a schedule.** An absolute reading can already be *logged* in
  `test_records`; what is missing is differencing it into `usage_since_service`, enforcing
  monotonicity, and making it available off serialised items. Pairs naturally with `W7`. Unlocks
  §3.9 and makes usage-based servicing real.
- **`W9` — Batch-level dates and attributes.** Give `stock_batches` a cost, a received date and a
  supplier, and — separately and more urgently — make batch expiry alert (§5). Unlocks §3.8 and
  lot-level costing.
- **`W10` — A masked field type.** Smaller than it looks — the Sync screen already masks the bridge
  token, so this is a `FIELD_TYPES` member plus that existing input, not new machinery. Only worth
  doing **with** an honest statement of what it does and does not protect, since nothing in the
  database is encrypted. Partially unlocks §3.3; see the non-goal below before starting.

### 4.1 `W1a` — the due-date opt-in (shipped)

The load-bearing half of `W1`: a custom `DATE` field can opt in as a **due date**, and the alert
centre and the Upcoming agenda both read it. A user-defined "Renewal date" now behaves like a
built-in expiry instead of sitting inert, which is the specific charge C1 laid.

**The design fork, and how it was settled.** Not every `DATE` is a deadline — *Date acquired* is
not — so the opt-in had to sit somewhere, and there were two live questions.

*Where it lives: on `field_defs`, not `category_fields`.* The dictionary already splits these
cleanly — `field_defs` holds what a field **means** (name, type, options, note), `category_fields`
holds a category's **policy** about it (required, default, position). "Is this date a deadline, and
how much notice" is meaning: a field named *Renewal date* is a deadline wherever it is used. Two
consequences settle it beyond taste:

- `item_field_values` and the `item_field_effective_values` view key on `def_id`, never on a
  category's *use* of a definition. A def-scoped flag therefore makes the feed a plain join, while
  a category-scoped one needs item → category → `category_fields` and silently misses any value
  inherited from a location, or left behind when an item changed category.
- The dictionary already forces one *type* per name and refuses to retype a shared definition,
  precisely so a field cannot mean two things at once. Letting deadline-ness fork per category
  would reintroduce that: the same field alerting on some items and not others, with nothing on
  screen to explain why.

The cost is accepted and real: ticking the box on a shared field changes behaviour for every
category using it. That is the same bargain a rename already makes, and the field editor states it.

*Its shape: one nullable `due_lead_days INTEGER`, not a boolean plus a shared preference.* `NULL`
means "an ordinary date"; any value means "a deadline, with this many calendar days' notice". Two
reasons:

- **Per-definition, not shared.** Deadlines are not alike — a subscription renewal wants a
  fortnight, a calibration certificate a quarter, a "return by" a day or two. One shared window
  would make the feature miss most of the archetypes `W1` exists to unlock (§3.3, §3.6, §3.8).
- **One column, not two.** A boolean *plus* a nullable lead time can disagree — "opted in, no
  notice" — and that state has no meaning. The stored value *is* the opt-in, so the UI presents a
  tick (seeding a default) plus a number, and there is no third state to reconcile.

Bounded `0`–`365` by a table CHECK alongside `field_type = 'DATE'`, with the write seam clearing
the value when a field is retyped away from `DATE` so the user meets a clean outcome rather than a
constraint failure. `0` is meaningful: "tell me on the day".

**What shipped alongside.** The decision logic is a dependency-free seam
(`features/lifecycle/field-due.ts`, injected clock) whose day-grained comparisons agree with the
SQL window that narrows the read; new lanes in both `AlertKind` and `AgendaKind` with completeness
guards added over `REMINDER_KINDS` and `AGENDA_KINDS` (both were arrays a new lane could silently
fall out of); gating on the `custom-fields` capability; and both feeds read **every** page and
report it when they cannot, rather than showing one page as the whole set.

**Deliberately not in scope, and where each belongs:**

- **The bridge's iCal feed** (`CALENDAR_SOURCE_TYPES`) is its own four-source union, independent of
  `AgendaKind`. Adding a fifth source is a coherent follow-up, but it is a *bridge* surface with its
  own OpenAPI and README drift guards; do it with `W1b`–`W1d` or as its own change.
- **Exposing the opt-in over the bridge** — both the item-field vocabulary
  (`ITEM_FIELD_VALUE_KEYS`) and the category-field projection (`CategoryFieldDto` /
  `toCategoryField`) still describe the pre-W1a shape, so a bridge or Home Assistant consumer
  reading a category's fields cannot tell that one of them is now a deadline. Its own change,
  gated by the OpenAPI and field-vocabulary drift tests.
- **The other six agenda lanes still read one page and present it as the whole set** (an
  `AGENDA_FETCH_LIMIT` of 500 that `MAX_PAGE_SIZE` silently clamps to 100, with `hasMore` never
  read). That predates this work and is filed as
  [#607](https://github.com/BootBlock/Gubbins/issues/607); the due-date lanes do not repeat it, but
  fixing the other six is that issue's job, not this one's.

**One defect met while building this, already filed.** `buildWarrantyEvents` and
`buildExpiryEvents` feed a day-grained **midnight-UTC** value straight into `bucketForDueAt` and
the locale date formatter, both of which work in **local** terms. West of UTC that reads a day
early: a warranty expiring "20 July" buckets as *Overdue* and renders as the 19th all through the
20th (issue #323 in the agenda, where issue #319 fixed the same thing for expiry status). That is
[#495](https://github.com/BootBlock/Gubbins/issues/495), which names the warranty, expiry and
booking lanes. The due-date lane re-anchors with `utcDayToLocalDay` and so is correct — so #495's
fix should adopt the same call rather than invent a second answer, and the lane's test shows the
shape a guard for it needs (an off-midnight fixture, since `utcDayToLocalDay` is the identity in
UTC and CI runs there).

### 4.2 `W1b`/`W1c` — a number's unit and range (shipped)

A custom `NUMBER` field can carry a **unit** (`mm`, `V`, `kg`) shown beside its value, and an
accepted **range** enforced when the value is saved. Both are optional, both are per definition,
and a field with neither behaves exactly as before.

**Where they live: `field_defs`, the same answer `W1a` reached, and stated rather than inherited.**
A unit and a range are part of what a field *means*, not a category's policy about it: "Voltage" is
measured in volts wherever it is used, and a torque that must fall between 8 and 12 is out of range
wherever it is entered. The same two storage facts settle it beyond taste:

- `item_field_values` and the effective-value view key on `def_id`, never on a category's *use* of a
  definition, so a def-scoped unit reaches every value — including one an item
  **inherited from a location**, which a category-scoped one would render bare.
- The dictionary already refuses to let one name carry two *types*, precisely so a field cannot mean
  two things at once. Letting the unit fork per category would reintroduce exactly that: the same
  number reading as millimetres on one item and inches on another, with nothing on screen to say why.

The cost is the same accepted one — editing a shared definition changes it everywhere — and the
field editor's hint says so.

**Their shape: three independently nullable columns, no boolean gate.** `unit TEXT`,
`min_value REAL`, `max_value REAL`; `NULL` means "not set" in each case, and that *is* the opt-in.
`W1a`'s "one column, not two" rule was really *never store a flag that can disagree with the value
it gates* — a boolean plus a lead time can say "opted in, no notice", which has no meaning. Three
nullable columns carry no such pair.

**What a half-set range means — legitimate, not half-finished.** This is where min/max genuinely
differs from `due_lead_days`, and it had to be decided rather than assumed. A one-sided range is a
constraint users actually want: "never negative" on a depth, "at most 100" on a percentage. So the
two bounds are independent, `NULL` on either means *unbounded on that side*, and neither implies the
other.

**What an inverted pair means — nothing, so it is refused.** `min > max` admits no value at all:
every entry would fail, and a field that cannot be filled in is broken rather than strict. A table
CHECK forbids it, with the write seam refusing it first in the app's voice so the user meets a
readable message instead of a raw constraint failure. Because either end can be edited alone, the
ordering rule is judged on the pair the row will actually *hold* — not on the input — so a one-sided
edit (or a reuse) cannot slip past it. `min = max` is allowed: it means "exactly this".

**Precision: considered, and deferred as `W1e`.** It is not a third bound of the same kind. Min/max
are pure constraints — they live wholly in `validateFieldValue` and change nothing about how a
stored value is displayed. Precision is half constraint and half display format, and the display
half opens a question this change should not answer: a `NUMBER` is stored canonically via `String(n)`
and rendered as that raw string, with no locale awareness at all, while the app has a whole
`useFormatters`/`Money` seam for numbers that *are* locale-formatted. Shipping the constraint half
alone would read as broken — someone who sets 2 dp and still sees `5.5` will call it a bug — and
shipping the display half means deciding whether a custom number joins the locale-formatted world.
The strongest single argument for picking it up is the `precision = 0` case, "whole numbers only",
which a range cannot express and which several archetypes want.

**Where the unit appears, and where it does not.** Beside the *value* on the read-only surfaces
(card, dense row, table cell) — `5 V` — and appended to the *label* in the editors — *Voltage (V)*.
The split is deliberate: an editor's box holds the number alone, so the unit belongs with the label
naming it, where it also correctly joins the control's accessible name; a card has no
label-and-control pair, so the unit has to travel with the value. The table keeps the bare field name
in its header for the same reason — the cell carries the unit, so a table agrees with the cards
rather than needing a second rule.

**The range is enforced in the pure seam, and only there.** A `NUMBER` *value* box is a Foundry
`Input type="number"`, which delegates to the micro-calculator `NumberInput` — a `type="text"` field,
because it must hold `/` and `*`. `min`/`max` on it would be inert attributes that are not even valid
for a text input, so passing them would look like enforcement while doing nothing. `validateFieldValue`
is the real gate; it already runs on every render of the item editor, so an out-of-range value shows
its reason as the user types and blocks the save, and it covers a **location's** value on the same
path (a location feeds every item inheriting it, so it must not be the one place a range is
side-stepped).

**One thing the tests caught that types could not.** The range boxes in the *definition* editor are
text inputs with `inputMode="decimal"`, not `type="number"`. A native number input reports `''` for
anything it cannot parse — including a lone `-` part-way through typing a negative bound — and `''`
is exactly the string that means "cleared" here, so the box would silently drop a stored bound the
moment someone retyped one. Keeping the raw text is what lets a blank ("unbounded") be told apart
from a mid-edit ("leave it alone"). This is the mirror of `W1a`'s blank-is-not-zero rule, reached
from the opposite direction: there, blank had to *revert*, because the field was already opted in and
every number was a legal setting.

**Deliberately not in scope:**

- **The preset library still encodes units in field *names*** (`Voltage (V)`, `Capacity (mAh)` in
  `category-presets.ts`) — the clearest demonstration of why `W1b` exists. Moving them onto the new
  setting means renaming the definitions, and a name *is* the dictionary key, so it would fork
  existing definitions rather than update them. Its own change, with a migration story.
- **Bridge exposure.** `ITEM_FIELD_VALUE_KEYS` and `CategoryFieldDto`/`toCategoryField` still
  describe the pre-`W1a` shape, so a consumer cannot see a unit, a range or the due-date opt-in.
  Still one change, now covering three attributes, gated by the OpenAPI and field-vocabulary drift
  tests.

## 5. Defects found while surveying

These are not archetype gaps — they are existing behaviour that looks wrong, found incidentally.
**All six are now filed as [#683](https://github.com/BootBlock/Gubbins/issues/683)–[#688](https://github.com/BootBlock/Gubbins/issues/688)**;
each issue carries the full evidence, so treat those as the live record and this section as the
summary of how they were found. Three of the six are documentation drift, where the wiki promises
behaviour that does not exist.

1. **Every `CONSUMABLE_GAUGE` item is valued at zero** ([#683](https://github.com/BootBlock/Gubbins/issues/683)). Valuation is `MAX(i.quantity, 0) ×
   unit_value` ([ReportRepository.ts:404-413](../../src/db/repositories/ReportRepository.ts#L404-L413)),
   and a gauge's `quantity` is pinned at 0 by design, while `valuableItemFilter` does **not** exclude
   gauges. `current_net_value` appears in no valuation SQL. So a full argon cylinder contributes £0
   to inventory valuation *and* to the printed insurance schedule
   ([insurance-schedule.ts:200](../../src/features/reports/insurance-schedule.ts#L200)) — and because
   `unpriced` counts `unit_value > 0`, a priced gauge is not even flagged as unpriced. A user hands an
   insurer a document that silently omits every consumable. The same `quantity`-of-zero fact also
   drops gauges out of dead-stock reporting and stock aging, whose reads end `AND i.quantity > 0`
   ([ReportRepository.ts:1063](../../src/db/repositories/ReportRepository.ts#L1063), `:1318`).

   Two things make this a clear defect rather than a modelling choice. The **card layer already
   knows the product is meaningless and refuses to print it** — "a gauge tracks a measure (not
   units), so for either the product is meaningless (it would read £0.00) — show em-dash"
   ([card-fields.ts:290-294](../../src/features/inventory/card-fields.ts#L290-L294)) — so the app
   applies that rule on cards and nowhere else. And the create form tells the user the opposite,
   offering Unit cost on every tracking mode with the help text that it "drives inventory
   valuation". Contrast the foreign-currency case, which is handled honestly: excluded stock is
   counted and surfaced by a notice rather than silently dropped.
2. **Batch expiry never raises an alert** ([#684](https://github.com/BootBlock/Gubbins/issues/684)) — §3.8 above. The stock-recompute triggers propagate
   quantity only, so nothing lifts a lot's expiry to the item. **The wiki asserts the opposite**
   under a section headed "Batches and expiry alerts": "Batch expiry dates feed the expiry tracking
   and the Alerts / Upcoming feeds, so a batch approaching its date surfaces before it lapses"
   ([Batches-and-Lots.md](../wiki/Batches-and-Lots.md)) — a second, user-facing defect alongside the
   behavioural one.
3. **Consumption rate sums incommensurable units** ([#685](https://github.com/BootBlock/Gubbins/issues/685)) into one `totalConsumed` scalar — grams,
   millilitres and screws added together
   ([ReportRepository.ts:869-879](../../src/db/repositories/ReportRepository.ts#L869-L879)). There
   is no `GROUP BY` and no join to `items`, so the mixed figure is the *entire* report: it is
   rendered on the Reports screen as both a daily rate and a total, and exported to CSV, with no
   unit and no qualifier.
4. **Clearing an item's activity log can report it as dead stock the next day** ([#686](https://github.com/BootBlock/Gubbins/issues/686)). Dead-stock idle
   days derive from `MAX(item_history.created_at)` over rows carrying a delta
   ([ReportRepository.ts:1059-1061](../../src/db/repositories/ReportRepository.ts#L1059-L1061)),
   falling back to `items.created_at` when there is none
   ([reports.ts:353](../../src/features/reports/reports.ts#L353)). `clearHistory` removes every
   movement row and leaves a `HISTORY_CLEARED` marker whose deltas are both `NULL`
   ([item/history.ts:90-91](../../src/db/repositories/item/history.ts#L90-L91)), so it does not
   satisfy that predicate — a just-moved item falls back to its creation date and is judged stale.
   Note the direction: this is a false *positive*, the safe way round. Bulk `pruneHistoryBefore`
   deletes an older prefix (`created_at < cutoff`) and so cannot lower the `MAX` at all.
5. **A sale's COGS can leak a foreign currency** ([#687](https://github.com/BootBlock/Gubbins/issues/687)). The preferred-supplier subquery in
   `resolveOutboundDraw` ([item/stock.ts:422-423](../../src/db/repositories/item/stock.ts#L422-L423))
   has no `inBaseCurrencySql` guard, unlike every valuation read — so a ¥ supplier price can be
   booked verbatim as base-currency cost.
6. **Straight-line depreciation is orphaned, and the documentation says otherwise** ([#688](https://github.com/BootBlock/Gubbins/issues/688)). `currentValue()`
   ([asset-lifecycle.ts:120](../../src/features/inventory/asset-lifecycle.ts#L120)) has one
   production call site — the Asset editor. No report, export, card, bridge or schedule reads it:
   valuation resolves `unitCost` then the preferred supplier cost and nothing else
   ([reports.ts:46-52](../../src/features/reports/reports.ts#L46-L52)). But the wiki states
   "This underpins the valuation reports and the insurance schedule"
   ([Warranty-and-Depreciation.md:24-27](../wiki/Warranty-and-Depreciation.md)), and the item editor
   and the published bridge schema say the same. An item priced only by purchase price plus a
   depreciation term is therefore scheduled at **0** while the docs promise a depreciated figure.
   Under the mandatory wiki rule that drift is a defect in its own right, whichever way it is
   resolved. (The wiki's "down to a salvage floor" is also wrong — the floor is literal zero.)

## 6. Deliberate non-goals

Carried forward from the [previous audit](done/feature-gap-audit_2026-07-09.md) and extended by what
this one found. Recorded so they are not re-proposed.

- **Live market price feeds** for appreciating assets — needs a keyed cloud API and continuous
  network access. Manual revaluation stays the aligned subset.
- **Cloud AI recognition / valuation / categorisation** — violates local-first and secret-free.
- **Encrypted-at-rest secret storage.** A masked field (`W10`) hides a value on screen; it does not
  protect it, because the database is unencrypted and syncs and exports in the clear. Shipping a
  field *called* secret without saying so plainly would be worse than not shipping one.
- **Full accounting** — tax classes, capital-gains basis, landed-cost apportionment, invoices,
  payment terms. Gubbins values inventory; it is not a ledger.
- **Multi-currency conversion.** The refusal to convert without exchange rates is a deliberate,
  well-documented design (a wrong number in an insurance document is worse than an omission), not a
  gap. Per-item currency would be a smaller, honest subset if ever wanted.
- **People, skills and tasks as first-class entities.** Contacts are an address book by design.
