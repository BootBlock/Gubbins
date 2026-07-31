# What Gubbins is weakest at tracking — archetype audit (2026-07-31)

> **Status:** 🟢 ACTIVE — research complete; the ranked candidates `W1`–`W10` are an open backlog,
> none started.

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
library disguises this: 72 presets make the app look domain-broad, but a preset can only ever add
**flat, inert scalar fields**, so it describes an archetype without ever making the app *behave*
differently for it.

## 2. The six structural causes

Everything in §3 traces to one or more of these. They are the real subject of this audit.

**C1 — A custom field is scalar, untyped beyond format, and inert.**
`item_field_values` carries `UNIQUE (item_id, def_id)`
([v1-initial.ts:685](../../src/db/migrations/v1-initial.ts#L685)) — exactly one value per definition
per item, with no ordinal. So **no repeating or table-valued field** exists: a set of readings, a
list of prior owners, a per-position measurement, a lineage. `field_defs`
([:598-606](../../src/db/migrations/v1-initial.ts#L598-L606)) is `name, field_type, options,
description` — **no unit, no min/max, no precision, no pattern**. `FIELD_TYPES` is a closed list of
11 ([constants.ts:305-317](../../src/db/repositories/constants.ts#L305-L317)) with no multi-select,
no money, no reference-to-another-row, and no masked/secret type.

Most consequentially, **nothing in the app reads a custom field except the item form, search and
export.** No alert, agenda, report, valuation or webhook filter touches `item_field_values` — so a
user-defined `DATE` raises nothing and a user-defined `Grade` changes no value. The 20-odd presets
that define their own *Condition* or *Grade* field are decorative.

**C2 — Categories are subtractive only, and flat.**
A category may *hide* capabilities but "must never re-enable what the device has switched off"
([category-capabilities.ts:12-14](../../src/features/inventory/category-capabilities.ts#L12-L14)),
and there is no `parent_id` on a category, so there is no ancestor resolution
([custom-fields.ts:234-238](../../src/features/inventory/custom-fields.ts#L234-L238)). A category
can therefore never *grant* an archetype anything — only take machinery away. The single NFT preset
models a non-physical thing entirely by switching physical capabilities off.

**C3 — Four tracking modes, all of which assume a body.**
`DISCRETE | SERIALISED | CONSUMABLE_GAUGE | UNTRACKED`
([constants.ts:70](../../src/db/repositories/constants.ts#L70)) — count it, serialise it, weigh it,
or don't count it. `quantity` is an `INTEGER`, so fractional stock is impossible outside a gauge; a
gauge is exactly four scalars on the item row and cannot be per-location, per-batch, cycle-counted,
booked, sold, or valued. There is no fifth mode for a thing without a body, and conversion between
modes is refused except `DISCRETE ↔ UNTRACKED`
([constants.ts:87](../../src/db/repositories/constants.ts#L87)).

**C4 — Containment is a table boundary.**
Stock sits at `item_stock (item_id, location_id)`; both it and `stock_batches` FK to `locations`,
never to `items`. **An item can never be inside another item.** `items.parent_id` is variants;
`kit_components` is a bill of materials that *consumes* its members on assembly. The preset library
ships four container archetypes — Tool bag, Storage tote, Gridfinity bin, First aid kit — as
*items*, so each one's contents is a `LONG_TEXT` field of prose. (Open issue
[#617](https://github.com/BootBlock/Gubbins/issues/617) is the same wall from the other side.)

**C5 — Ownership is unmodelled; custody is one-directional.**
There is no `owner`, no tenure, no share. The only possession concept is `checkouts`, which is
strictly outbound with an XOR borrower
([v1-initial.ts:999](../../src/db/migrations/v1-initial.ts#L999)). Every row in the database is
implicitly "mine, owned outright".

**C6 — Per-unit identity is create-time only.**
`serial_number`, `acquired_at`, `warranty_expires_at`, `purchase_price` and `condition` are single
columns on the item row, so 12 identical widgets share one of each. `stock_batches` splits a
quantity into lots but a lot has no serial, cost or condition. The only per-unit model is
`SERIALISED`, which explodes into N rows, and `DISCRETE → SERIALISED` is refused as "a lossy
row-split… create-time only — make a new item instead"
([constants.ts:82-85](../../src/db/repositories/constants.ts#L82-L85)).

## 3. The archetypes, ranked

Ranked by *(how badly it fits) × (how plausibly a Gubbins user owns it)*.

### 3.1 Dimensional and cut stock — **weakest overall**
Timber, sheet goods, wire and cable on a reel, tube, fabric off a bolt, filament, trim, leather.

The `wood-stock` preset offers Thickness / Width / Length as `NUMBER` fields
([category-presets.ts:1818-1828](../../src/features/inventory/category-presets.ts#L1818-L1828)) —
inert per C1. `items.width/height/depth` exist but are documented as a *bounding box of the
article*, one set per item, never per placement or per piece. There is **no remnant or offcut
concept anywhere** (zero hits for `remnant`, `offcut`, `cut list`), and a gauge's only operations
are a signed delta, a weigh-in and a reconfigure — no split that yields a tracked remainder. So
cutting a 2400 mm board into 600 mm + an 1800 mm offcut is unrepresentable; you must hand-create a
second item with no link to the first. Compounding it: no pack/case size exists anywhere
(`pack_qty` is on the *supplier part*, not the item), so "12 boxes = 144 units" is inexpressible,
and `unit_of_measure` is unvalidated free text with no conversion — `consumptionRate` sums grams,
millilitres and screws into one scalar
([ReportRepository.ts:869-878](../../src/db/repositories/ReportRepository.ts#L869-L878)).

Why it ranks first: this is the *core maker/workshop audience*, and four of the shipped preset
sections (workshop, crafts) are full of stock that behaves this way.

### 3.2 Documents and paperwork
Manuals, certificates, receipts, warranties as paper, deeds, passports, plans, scanned records.

**Gubbins cannot store a file.** `item_attachments.kind` is `URL | LOCAL_POINTER`
([constants.ts:326](../../src/db/repositories/constants.ts#L326)) — a link or a path string, never
bytes; a `LOCAL_POINTER` degrades to an "Unlinked Local File" placeholder on every other device. The
attachment UI has no file input at all, only two text boxes. The `FILE` field type stores an
unverifiable string. The only binary the app stores is images (a ≤150px thumbnail BLOB plus an OPFS
full-res, and a ≤512 KiB `IMAGE` field). The UI copy is honest about it — "*Link* reference
documents" — but it means the archetype "a thing whose entire value is the document" has no home.

### 3.3 Entitlements and non-physical holdings
Software licences and keys, subscriptions, domains, memberships, accounts, gift cards, vouchers,
tickets, insurance policies, digital media libraries.

Nothing here exists, and three separate walls stand in the way. There is **no masked or encrypted
field type** — `type="password"` appears only in the app's own auth chrome, and the wiki states
plainly that Gubbins "does not encrypt your data", so a licence key typed into a `TEXT` field syncs,
backs up and CSV-exports in the clear. There is **no renewal concept** — the four alert lanes are a
closed union (`low-stock, expiry, maintenance-due, warranty-due`) and, per C1, a custom `DATE` field
fires nothing, so a subscription renewal cannot be surfaced even if recorded. And there is **no
redeemable balance** — `CONSUMABLE_GAUGE` is structurally a *weighing* model that CHECK-requires a
`tare_weight` described as "the weight of the empty container", so a £50 gift card cannot be modelled
as a gauge without lying to the schema.

Warranty deserves a specific note: it is **a date, not an entitlement** — one `TEXT` column plus a
derived status. No provider, policy number, coverage, transferability or claim record.

### 3.4 Living things — *the issue's own first example*
Plants, propagated cuttings, cultures and ferments, livestock, pets.

No preset exists for any of them. Against the proposed spec specifically:
- **`lineage_grex` / recursive parentage** — partly reachable. `items.parent_id` is a real
  arbitrarily-deep tree with cycle rejection, and `item_relations` takes free-text kinds. But
  neither carries *directed lineage semantics*, and critically `createVariant` **copies nothing
  from the parent** ([variants.ts:37-45](../../src/db/repositories/item/variants.ts#L37-L45)) — a
  parent's fields, MPN or dimensions are not inherited, defaulted or resolved through the chain. And
  cloning creates no link at all: `planItemClone` is a one-time snapshot that records nothing about
  where it came from.
- **`generation_code`, `feed_ratio`** — expressible as inert custom fields (C1).
- **`substrate_decay_date` → flag status + add to shopping list** — not possible. A custom `DATE`
  triggers nothing, and there is no rule engine: the only user-definable condition anywhere is the
  webhook filter tree, whose sole comparison leaf is `quantity`
  ([filter.ts:40](../../src/features/webhooks/filter.ts#L40)) — no date leaf, no custom-field leaf.
- **`bloom_telemetry` (a history array)** — impossible by C1; `UNIQUE (item_id, def_id)` permits one
  value per field, and every repeating structure in the schema is a hard-coded child table.
- **Recalculate intervals from ambient temperature / photoperiod** — no environmental input exists
  anywhere in the data model, and a maintenance schedule is an integer day count or a bare usage
  counter, with no recurrence grammar (no RRULE, no "first Monday", no seasonality).

### 3.5 Things you don't own
Borrowed-in tools, rented and leased equipment, communal or club property, items held on consignment.

Per C5, zero hits for borrowed-in, lease, rental or co-ownership. A drill lent *to* you and a drill
you own are indistinguishable rows, and there is no "return by" for the former. Note the asymmetry:
the app has a rich outbound loan system — due dates, renewals, overdue tracking, contacts,
conversions from bookings — and no inbound counterpart at all.

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
warranty, checkout or maintenance. The schema names the tension itself — an assembly's outcome is a
*choice* between `CONTAINER` (becomes a Location) and `SINGULAR_OBJECT` (becomes an Item).

### 3.8 Perishables beyond a single date
Opened food, reagents, adhesives and resins with a working life, curing and ageing stock, medication.

Three specific holes. There is **no "opened on" date** — the `food-pantry` and `adhesive` presets
offer an `Opened` **boolean**, so shelf-life-after-opening cannot be derived. There is **no
curing/ageing window** (no "ready at" or "not before" on any table). And most sharply: **batch expiry
never alerts.** `stock_batches.expiry_date` drives FEFO consumption correctly, but every attention
feed reads `items.expiry_date` only
([attention-sql.ts:88-94](../../src/db/repositories/item/attention-sql.ts#L88-L94)) — so a lot
expiring next week is invisible to the alert centre, the agenda, the dashboard and every report —
the predicate is a bare `expiry_date IS NOT NULL AND expiry_date <= ?` against `items`
([attention-sql.ts:93-95](../../src/db/repositories/item/attention-sql.ts#L93-L95)). See §5.

### 3.9 Vehicles and metered assets
Cars, vans, mowers, generators, compressors, 3D printers, anything serviced on hours or distance.

No vehicle preset. A `USAGE` maintenance schedule exists but takes only a **delta** into
`usage_since_service` — there is no way to enter an absolute meter *reading*, so an odometer or hour
meter cannot be recorded, only differenced by hand. The single automated meter in the app is
`accrue_checkout_hours`, which measures **wall-clock hours a loan was open**, not hours actually
run. No fuel, consumables-per-asset link, or running-cost roll-up exists — `maintenance_schedules`
has no cost column, so total cost of ownership is uncomputable.

### 3.10 Bookable spaces and shared resources
Rooms, benches, machine time, a shared workshop slot.

`asset_bookings.item_id` is the only booking target — **a location cannot be booked** — and
`isBookableTrackingMode` refuses a gauge and any DISCRETE item with quantity ≠ 1, so "reserve 3 of
10 chairs" is impossible. A bookable room must be faked as an item, which then acquires a quantity
and a stock ledger it does not want. Bookings also have no recurrence.

### Also weak, lower priority
**Variant matrices** (a tree, not a matrix — a 5-size × 4-colour shirt is 20 hand-made rows with
nothing knowing the axes, and no SKU column exists). **Sets vs members** (assembling a boxed chess
set destroys the pieces as inventory). **Appreciating collectibles** — the preset library's largest
group at 50 of 72 — where `revaluations` works but condition/grade never touches value, the
valuation trend draws a flat line for a collection that doubled (a `REVALUED` entry deliberately
carries no `net_value_delta`, and the trend filters on `quantity_delta`), and **`SERIALISED` items
cannot be sold at all** ([item/stock.ts:433](../../src/db/repositories/item/stock.ts#L433)), so the
class most likely to be high-value has no disposal-for-value path.

## 4. Candidate work items

Ranked by *(breadth of archetypes unlocked) ÷ (cost)*. Deliberately weighted toward fixing a **cause**
rather than adding a domain's fields, because the preset library already proves that adding fields
does not make the app track anything better. None started.

- **`W1` — Make custom fields live.** The single highest-leverage change in the list: give
  `field_defs` a unit, a min/max, and a "surface this" flag, and teach the alert/agenda feeds to
  read `item_field_values` for `DATE` fields. Unlocks renewals, subscriptions, licences, inspection
  dates, substrate-decay dates and curing windows **at once**, and turns the existing 72 presets
  from decoration into behaviour. Addresses C1; overlaps issue
  [#619](https://github.com/BootBlock/Gubbins/issues/619).
- **`W2` — A repeating (table-valued) field.** Removes the `UNIQUE (item_id, def_id)` ceiling for
  opted-in definitions. Unlocks telemetry logs, per-position measurements, prior owners, lineage
  notes — every archetype whose data is a *series*. Addresses C1. Larger and schema-visible; do
  after `W1`.
- **`W3` — An item can be a container.** Let a location be backed by an item (or an item declare
  itself a place). Unlocks §3.7 outright and improves §3.1 and kits. Addresses C4; overlaps
  [#617](https://github.com/BootBlock/Gubbins/issues/617). Structurally the largest item here.
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
- **`W8` — Meter readings.** Accept an absolute monotonic reading (odometer, hour meter, cycles)
  and difference it internally. Unlocks §3.9 and makes usage-based servicing real.
- **`W9` — Batch-level dates and attributes.** Give `stock_batches` a cost, a received date and a
  supplier, and — separately and more urgently — make batch expiry alert (§5). Unlocks §3.8 and
  lot-level costing.
- **`W10` — A secret/masked field type.** Only worth doing **with** an honest statement of what it
  does and does not protect, since nothing in the database is encrypted. Partially unlocks §3.3;
  see the non-goal below before starting.

## 5. Defects found while surveying

These are not archetype gaps — they are existing behaviour that looks wrong, found incidentally.
Recorded here so they are not lost; each wants its own issue.

1. **Every `CONSUMABLE_GAUGE` item is valued at zero.** Valuation is `MAX(i.quantity, 0) ×
   unit_value` ([ReportRepository.ts:404-413](../../src/db/repositories/ReportRepository.ts#L404-L413)),
   and a gauge's `quantity` is pinned at 0 by design, while `valuableItemFilter` does **not** exclude
   gauges. `current_net_value` appears in no valuation SQL. So a full argon cylinder contributes £0
   to inventory valuation *and* to the printed insurance schedule
   ([insurance-schedule.ts:200](../../src/features/reports/insurance-schedule.ts#L200)) — and because
   `unpriced` counts `unit_value > 0`, a priced gauge is not even flagged as unpriced. A user hands an
   insurer a document that silently omits every consumable. The same `quantity`-of-zero fact also
   drops gauges out of dead-stock reporting, whose read ends `AND i.quantity > 0`
   ([ReportRepository.ts:1063](../../src/db/repositories/ReportRepository.ts#L1063)).
2. **Batch expiry never raises an alert** — §3.8 above.
3. **Consumption rate sums incommensurable units** into one `totalConsumed` scalar — grams,
   millilitres and screws added together
   ([ReportRepository.ts:869-879](../../src/db/repositories/ReportRepository.ts#L869-L879)).
4. **History pruning resets an item's apparent idle age.** Dead-stock idle days derive from
   `MAX(item_history.created_at)`
   ([ReportRepository.ts:1059-1061](../../src/db/repositories/ReportRepository.ts#L1059-L1061)), so
   the app's own storage-triage housekeeping makes stale stock look freshly moved.
5. **A sale's COGS can leak a foreign currency.** The preferred-supplier subquery in
   `resolveOutboundDraw` ([item/stock.ts:422-423](../../src/db/repositories/item/stock.ts#L422-L423))
   has no `inBaseCurrencySql` guard, unlike every valuation read — so a ¥ supplier price can be
   booked verbatim as base-currency cost.
6. **Straight-line depreciation is orphaned.** It is computed and rendered in one editor, and feeds
   no report and not the insurance schedule (which passes `depreciationMonths: null` deliberately).
   Either it should inform something, or it should say that it doesn't.

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
