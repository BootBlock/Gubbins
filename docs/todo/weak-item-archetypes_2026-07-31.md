# What Gubbins is weakest at tracking — archetype audit (2026-07-31)

> **Status:** 🟢 ACTIVE — research complete. `W1a` (custom-field due dates), `W1b`/`W1c` (a
> number's unit and range), `W1d` (the key-field rank), `W1e` (a number's decimal places),
> `W1f` (an actionable `URL`/`FILE` value) and `W1g` (a `FILE` value's origin device) have
> shipped, completing `W1`; `W2`–`W10` remain open.

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
and `unit_of_measure` is unvalidated free text with no conversion — which is why `consumptionRate`
used to sum grams, millilitres and screws into one scalar. That report now groups by unit and never
adds two of them together ([#685](https://github.com/BootBlock/Gubbins/issues/685), fixed), but the
absence of a conversion layer underneath it is unchanged.

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

And most sharply: **batch expiry never alerts.** ✅ **Fixed** — the shared predicate now judges an
item on its *effective* expiry, the earlier of its own `expiry_date` and the soonest date across the
lots still holding stock, so the alert centre, the Upcoming agenda, the "Soon to Expire" widget, the
status filter and the bridge's status counts all see a lot's date. The purchase-order receive dialog
gained the expiry field it was missing, so a dated lot can arrive that way too. As found:
`stock_batches.expiry_date` drove FEFO consumption correctly, but every attention feed read
`items.expiry_date` only — the predicate was a bare `expiry_date IS NOT NULL AND expiry_date <= ?`
against `items`, and the stock-recompute triggers propagate quantity only, so nothing lifted a lot's
date to the item. `idx_stock_batches_expiry` was an index no predicate ever used. See §5.

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
does not make the app track anything better. `W1a`–`W1g` have shipped, completing `W1`; `W2`–`W10`
are open.

- **`W1` — Make custom fields live.** The single highest-leverage change in the list: give
  `field_defs` a unit, a min/max, and a "surface this" flag, and teach the alert/agenda feeds to
  read `item_field_values` for `DATE` fields. Unlocks renewals, subscriptions, licences, inspection
  dates, substrate-decay dates and curing windows **at once**, and turns the existing 72 presets
  from decoration into behaviour. Addresses C1. Note the split: the "surface this" half is adjacent
  to issue [#619](https://github.com/BootBlock/Gubbins/issues/619) (which is purely presentational),
  but the load-bearing half — feeds reading `DATE` fields — is untouched by it. ✅ **All seven
  sub-items have now shipped**, so `W1` is complete.
  - **`W1a` — DATE fields as due dates. ✅ Shipped** (see [§4.1](#41-w1a--the-due-date-opt-in-shipped)).
  - **`W1b` — a per-definition unit** on `field_defs`, so a `NUMBER` field carries one.
    ✅ **Shipped** (see [§4.2](#42-w1bw1c--a-numbers-unit-and-range-shipped)).
  - **`W1c` — min/max on a `NUMBER` definition**, validated at the point of save through the
    existing `validateFieldValue` seam. ✅ **Shipped** with `W1b` — same surface, one migration
    (see [§4.2](#42-w1bw1c--a-numbers-unit-and-range-shipped)). **Precision was considered and
    deliberately deferred** as `W1e`; §4.2 records why.
  - **`W1e` — decimal precision on a `NUMBER` definition.** ✅ **Shipped**, split out of `W1c`
    (see [§4.5](#45-w1e--a-numbers-decimal-places-shipped)). Not a third bound of the same kind:
    min/max are pure *constraints*, while precision is half constraint ("at most 2 decimal
    places") and half *display format* ("show `5.5` as `5.50`"). **Both halves shipped** — §4.2's
    argument that the constraint half alone would read as broken was accepted rather than
    deferred again — and §4.5 records the design fork the display half forced (whether a custom
    number joins the locale-formatted `useFormatters`/`Money` world) and why it was answered *no*.
  - **`W1d` — the "surface this" prominence flag.** ✅ **Shipped** as the **key-field** rank
    (see [§4.3](#43-w1d--the-key-field-rank-shipped)). Designed against #619 rather than beside it:
    that setting is per *category* and chooses **which tab** the whole field set sits in, while this
    one is per *definition* and chooses **which member leads** the set. §4.3 records why they cannot
    fight, and why an ordering rank belongs on `field_defs` even though ordering is otherwise
    category policy.
  - **`W1f` — a `URL`/`FILE` value that can be acted on.** ✅ **Shipped** — part **(i)** below,
    the link arm, over both subjects at once; part **(ii)**, the origin attribution, was scoped
    and split out as `W1g` (see [§4.4](#44-w1f--an-actionable-urlfile-value-shipped) for the
    reasoning and for what building it proved wrong about the description that follows). Split
    out of the `N4`
    reassessment (§11.7 of [non-items on a Location](location-non-items_2026-07-31.md)), which
    refused a `location_attachments` table partly *because* this is the cheaper fix and covers both
    subjects at once. `C1`'s "readable but never actionable" in its smallest form: `CardFieldValue`
    has no link arm — `text`, `measure`, `money`, `condition`, `tags`, `image`, `empty` — and
    `customFieldValue` falls both a `URL` and a `FILE` value through to `{ kind: 'text' }`
    ([card-fields.ts:352-371](../../src/features/inventory/card-fields.ts#L352-L371)), so each
    renders as unclickable text on the item card and on the location detail panel alike, and on no
    surface as a link. Two parts, one change over both subjects: **(i)** a `link` arm on
    `CardFieldValue` plus its renderer case in `ItemCardFields`, and **(ii)** the origin attribution
    a `FILE` value lacks — `item_attachments` stamps `origin_device_id`
    ([AttachmentRepository.ts:49-56](../../src/db/repositories/AttachmentRepository.ts#L49-L56)) and
    degrades another device's pointer to an "Unlinked Local File" placeholder offering Re-link or
    Use URL ([AttachmentManager.tsx:186-232](../../src/features/inventory/components/AttachmentManager.tsx#L186-L232)),
    resolved by the pure
    [attachment-link.ts:41-52](../../src/features/inventory/attachment-link.ts#L41-L52) seam,
    whereas a synced `FILE` value shows a foreign path as a dead string with no explanation. Note
    **(i)** is
    not purely presentational for a `FILE`: a `file://`, UNC or bare-path string is not safe to hand
    to an `<a href>`, so the arm must decide what is openable — the same judgement
    `resolveAttachmentLink` already encodes, so reuse that seam rather than restating it.
    (§4.4 point 2 records why that last instruction turned out not to be followable.)
  - **`W1g` — a `FILE` value's origin device.** ✅ **Shipped** (see
    [§4.6](#46-w1g--a-file-values-origin-device-shipped) for the two questions it had to settle
    first, and for what building it proved wrong about the description that follows). Split out
    of `W1f`'s part **(ii)** for
    the reasons in [§4.4](#44-w1f--an-actionable-urlfile-value-shipped). Neither
    `item_field_values` nor `location_field_values` carries an `origin_device_id`, so a `FILE`
    value synced from another device is shown honestly as *a path* (`W1f`) but not
    *specifically* — nothing says it came from elsewhere, and nothing offers the **Re-link** /
    **Use URL** flow `item_attachments` has had since v18
    ([AttachmentManager.tsx:186-232](../../src/features/inventory/components/AttachmentManager.tsx#L186-L232)).
    Materially larger than `W1f` and a different kind of task: a column on **two synced tables**
    — migration folded into the v1 baseline plus a snapshot regen, the effective-value view, the
    LWW merge and restore paths, the row-shape guards, and the bridge's `ITEM_FIELD_VALUE_KEYS`
    vocabulary — plus a re-homing *editing* flow, which the read-only card/row/table/panel
    surfaces have nowhere to put. Scope it before starting on two questions §4.4 could not
    settle from the read side: whether an origin is stamped on **every** field value or only a
    `FILE` one, and where the re-link flow lives given that these surfaces do not edit.
    It was taken before `W2` for the reason recorded when it was split: it shares `W2`'s
    two-subject shape and the same two tables, so doing it first keeps `W2`'s migration from
    having to carry it. That held — the column landed on both tables in one baseline edit, and
    `W2` now inherits it.
- **`W2` — A repeating (table-valued) field.** Removes the `UNIQUE (item_id, def_id)` ceiling for
  opted-in definitions. Unlocks telemetry logs, per-position measurements, prior owners, lineage
  notes — every archetype whose data is a *series*. Addresses C1. Larger and schema-visible; do
  after `W1`. **Scope it over two subjects:** `location_field_values` carries the identical
  `UNIQUE (location_id, def_id)` ceiling, and now that
  [`N1`/`N2`](location-non-items_2026-07-31.md#11-what-building-n1n2n6n7-proved-wrong-2026-07-31)
  have shipped it is the only limit left on what a location's notes can *hold* — so a location-only
  `location_notes` table was rejected in favour of this (`N3`), and so was a location-only
  attachments table (`N4`, §11.7 there): "several of them, ordered and labelled" is this item, on
  whichever subject asks for it. (A location's remaining gap — a date that raises something — is
  `N5` there, and folds into `W1`; its export and activity record are built.) One change over both.
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
  and backup must stay honest about what travels. This is the *embedding* half of open issue
  [#466](https://github.com/BootBlock/Gubbins/issues/466) ("Interactive Document & Manual Attachment
  Hub"); the other half it asks for is a **category** dimension on `item_attachments` (Manuals,
  Warranties, Receipts, Schematics), which is a column rather than bytes and could land first.
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

### 4.3 `W1d` — the key-field rank (shipped)

A custom-field definition can be marked a **key field**, which lifts it to the **front** of every
field set it appears in: an item's custom fields, a location's values, and the category's own field
list. Optional, applies to any field type, and a definition with it unset behaves exactly as before.

**How it composes with #619, stated rather than discovered later.** The two settings are the
question this task existed to answer, because a second knob that silently fights the first would
have been worse than no knob at all. They do not fight, because they answer different questions and
neither can do the other's job:

| | subject | question | reach |
| --- | --- | --- | --- |
| `categories.field_prominence` (#619) | a **category** | *where does the whole set sit?* | the item dialog's tab rail |
| `field_defs.prominence` (`W1d`) | a **definition** | *which member leads the set?* | every surface that renders a field set |

Three consequences fall out, and all three are enforced rather than merely intended:

- **`W1d` never moves a tab, and #619 never reorders within the set.** Each is the only answer to
  its own question. #619 says so itself — "this only moves them" — and the rank is applied by the
  *read* that produces the set, long before a tab exists to put it in.
- **A key field therefore leads identically in all three of #619's modes.** Inside a category that
  broke its fields out into their own tab, the key field leads *that tab*; inside a default
  category it leads the section in Classification. The mode chooses the room, the rank chooses the
  seat, and neither answer changes the other.
- **The one place they meet needs no rule of its own.** When the custom-fields section is hidden —
  the device's module is off, or the category hides it and the item holds nothing — no fields are
  rendered at all, so there is nothing to lead. `W1d` inherits #619's "never outrank a hiding
  decision" invariant for free instead of restating it, and can never resurrect a hidden field.

**Where it lives: `field_defs`, and this time the counter-argument was genuinely strong.** Unlike
`W1a` and `W1b`/`W1c`, "how prominent is this field" *looks* like category policy, and there is a
column to prove it: `category_fields.position` already exists, beside `is_required` and
`default_value`, and it is an ordering. Three things settle it against that reading rather than by
precedent:

1. **`position` cannot reach half the surfaces a rank must reach.** A **location's** field values
   have no `category_fields` row at all — `listLocationFieldValues` can only order by name — and a
   location feeds every item that inherits from it. An item's *effective* field set likewise carries
   values inherited from a location or left behind by a change of category, and those key on
   `def_id`. This is the same storage fact that decided `W1a` and `W1b`/`W1c`, but it bites harder
   here: for a location it is not "the category-scoped answer misses a case", it is "there is no
   category-scoped answer at all".
2. **The two say different things, so neither replaces the other.** `position` is an *arrangement* —
   where this category chose to put its fields in its own list. The rank is a claim about the field:
   a *Serial number* matters more than a *Notes* wherever either appears. The rank therefore sorts
   *ahead* of `position` rather than replacing it, and `position` still orders within each rank.
   (Worth noting how little is actually being conceded: `position` has **no reorder UI** today — the
   add-field form never sends one, so every hand-added field is `position = 0` and the effective
   order collapses to alphabetical. Only the preset library assigns real positions.)
3. **The dictionary exists so a definition means one thing everywhere.** One name carries one type,
   enforced, precisely so a field cannot mean two things at once. Letting importance fork per
   category would reintroduce that — *Voltage* leading on Batteries and trailing on Chargers, with
   nothing on screen to explain the difference.

The cost is the same accepted one: marking a shared definition reorders it in every category using
it, exactly as a rename, a retype, a unit or a range already does. The editor's hint says so.

**Its shape: one nullable `TEXT` column — and, unlike all three predecessors, no CHECK.** This is
the part that had to be decided rather than inherited. `W1a` used one nullable column because a
boolean plus a lead time can disagree; `W1b`/`W1c` used three independently nullable columns for the
same underlying reason. `W1d` is one column too — a rank has nothing for a separate flag to gate —
but it parts company on the constraint:

- `due_lead_days`, `min_value` and `max_value` are **behavioural**. One gates an alert, the others
  refuse a save. A value they cannot honour must be refused at the storage boundary, so each carries
  a table CHECK.
- A rank is **presentational**. The worst an unrecognised value can do is fail to change a sort
  order. So the correct failure mode is the opposite one: keep whatever a peer on a newer version
  wrote, and narrow it at the render boundary. A CHECK would instead fail that peer's *entire sync
  apply* over a display preference — which is exactly the reasoning `categories.field_prominence`
  already carries. `W1d` adopts it because it is the same **kind** of setting, not because it
  happens to sit next door.

There is also **no `field_type` term**, the one place `W1d` diverges from all three predecessors: a
unit means nothing on a `DATE` and a notice period nothing on a `NUMBER`, but *any* type can be the
field that matters most. So nothing is cleared on a retype — and a test asserts that a retype which
strips the unit leaves the rank alone.

**Where the ranking is applied: in the read, not in each renderer.** The `ORDER BY` of the three
reads that produce a *rendered field set* — `listFields`, `resolveItemFields`,
`listLocationFieldValues` — gains a leading `CASE WHEN fd.prominence = 'key'` term, so the item
editor, the category manager, the CSV export's column order, the bridge's `fieldValues` array and
the lookup panel's bindings all inherit one canonical order and cannot drift apart. The pure
`field-def-prominence.ts` seam owns the vocabulary (the SQL interpolates its `KEY_FIELD_PROMINENCE`
token, so the two cannot disagree about which string means "leads") and mirrors the ordering as a
**stable partition** — not as a second live ordering path (no render surface re-sorts) but as an
independently-written counterpart that keeps `fieldsForCategory`'s documented contract honest, and
that a repository test compares against a real read so the two cannot quietly disagree. Note what this made unnecessary: **no render surface changed at all.**

`listAllFields` is the deliberate exception. It is a *catalog grouped by category*, not a rendered
set — the card-field picker labels its rows "name · category" on the strength of that grouping — so
hoisting key definitions to the front would break the grouping in order to reorder a list the user
orders by hand anyway.

**Deliberately not in scope, and why each is a rejection rather than an omission:**

- **The item card, dense row and table were left alone.** They looked like the obvious home for a
  "surface this" flag, and they are not: which fields appear there is *already* an explicit
  per-device user preference with its own picker and its own ordering (backlog `E1`'s `cardFields`).
  Seeding that preference's default from a definition would make the flag's effect depend on
  whether the user had ever opened the picker — visible on one device, inert on another, with
  nothing on screen to explain which. That is precisely the "second knob silently fighting the
  first" this task set out to avoid, only against `E1` instead of #619.
- **No badge marking a key field on an item.** The ordering is the whole effect, and #619 set the
  precedent: it moves a tab and marks nothing. A badge on every key field on every item would be
  noise in exchange for restating what the order already says. The setting explains itself where it
  is set, in the category manager.
- **No symmetric "sink this to the bottom" mode.** A different request from the one `W1d` answers.
  The vocabulary is stored as text precisely so adding one later costs no column change, and the
  render boundary already reads an unknown mode as ordinary.
- **The preset library marks nothing.** Several presets ship a dozen fields and would benefit, but
  seeding ranks would reorder existing users' fields on adoption. Its own change — and it pairs
  naturally with the preset unit-renaming work `W1b` deferred.
- **Bridge exposure.** `ITEM_FIELD_VALUE_KEYS` and `CategoryFieldDto`/`toCategoryField` still
  describe the pre-`W1a` shape, so a consumer cannot see a rank, a unit, a range or the due-date
  opt-in. Still one change, now covering **four** attributes, gated by the OpenAPI and
  field-vocabulary drift tests. (The bridge does already inherit the new *order* of `fieldValues`,
  since it reads through `resolveItemFields`.)

### 4.4 `W1f` — an actionable `URL`/`FILE` value (shipped)

A `URL` custom-field value, and a `FILE` one that holds a web address, now render as a **link that
opens in a new tab** — on the item card, the dense row, the table cell and the location detail
panel alike. A `FILE` value that holds a path instead is marked as the **file pointer** it is
rather than sitting as anonymous text. One arm pair in the shared `customFieldValue` seam reached
all four surfaces and both subjects; **no render surface but `FieldValue` changed**, which is the
claim §11.7 made when it refused `location_attachments`, now demonstrated rather than asserted.

**Scope: part (i) shipped, part (ii) split out as `W1g`, and the split is not a deferral of the
same charge.** §11.7's case against a `FILE` value was that a synced path *"is shown as a dead
string with no explanation"*. Part (i) removes the *"with no explanation"* half outright and
without any schema change — the value carries a file icon, an assistive-technology label naming it
as a path, and a wiki section saying what a path can and cannot do. What is genuinely left is the
*specific* half — **this** path came from **another** device, and here is how to re-home it — and
that is a different size and shape of task: a column on two synced tables (with the migration,
snapshot, merge and bridge-vocabulary work that implies) plus a re-linking *editing* flow that the
read-only surfaces this change touched have nowhere to put. Splitting it is the same call `N4`
got, made for the same reason: the cheap fix and the structural one were bundled by the research,
and only one of them is a display decision.

**What building it proved wrong about the description above.**

1. **It is not "one union arm plus one `switch` case" — a `FILE` value is not one thing.** Both
   §11.7 and the `W1f` entry wrote the fix as a single `link` arm. But `FILE` is defined as *"a
   local path, a UNC share, or a `file://` / `http(s)` URI"*
   ([constants.ts:318-321](../../src/db/repositories/constants.ts#L318-L321)) — so a `FILE`
   holding a web address is exactly as openable as a `URL` field, and one holding a share is not
   openable at all. The **type cannot decide**; only the value can. So the arms follow the
   *values*: `link` (an address) and `pointer` (a path). A single arm carrying a nullable href
   would have let a renderer silently forget the un-openable case, which is the failure mode the
   discriminated union exists to prevent.
2. **`resolveAttachmentLink` could not be reused at all — and the reason is precisely `W1g`.**
   The `W1f` entry above says to reuse that seam rather than restate its judgement, and on
   inspection there is no judgement there to reuse. It answers two questions: *is this an
   address?* — which it does not compute, it **reads** it from the stored `kind` column — and *is
   this pointer foreign?*, computed from `origin_device_id`. A field value has **neither column**.
   Calling it with a synthetic `{kind, originDeviceId: null}` and a placeholder device id would
   have been ceremony: with a null origin it reduces to exactly the branch already taken, while
   threading a device id through two pure seams that ignore it.

   So the rule had to be **written** rather than borrowed: `inventory/external-href.ts`. It stays
   inside the feature deliberately. `lib/` is where this repo keeps a rule that is genuinely
   cross-feature — `image-data-url.ts` says exactly that of itself, and has callers in inventory
   *and* reports to show for it — whereas this one is a rule about a custom-field value with a
   single consumer. Lift it when a second feature needs it, not on the strength of a resemblance.

   Note what it is **not**: it does not unify the http(s) checks in `validateFieldValue` and
   `AttachmentRepository`, which stay where they are. Those are *write-time* validators whose job
   is to explain a refusal in the user's words, each differently; this one only has to answer yes
   or no. Nor is the split the one that `image-data-url.ts` models — `isImageDataUrl` is used at
   **both** times, inside `validateFieldValue` as well as at the renderer. The reason this rule is
   render-only is narrower and specific to `FILE`: there *is* no write-time answer to copy,
   because a `FILE` value is stored verbatim with no validation at all.
3. **Openability is a security gate, not a formatting choice — and nothing above said so.** A
   `URL` value is validated as http(s) at the point of save — and on import, which runs the same
   seam — but **nothing revalidates a value merged from a sync peer or restored from a backup**,
   nor one left behind when a definition was retyped. And `FILE` has no validation to fall short
   of at all. So `isExternalHref` admits `http:`/`https:` only,
   which is what stops a stored `javascript:` or `data:text/html` string ever reaching an `href`.
   This is the same rule, reached independently, that the `IMAGE` arm already states for
   `isImageDataUrl`: *only a value of exactly that shape becomes a `src`*. An out-of-band `URL`
   value degrades to plain **text** rather than to `pointer`, because "this is a file path" is a
   claim about it that nothing has established.
4. **No new click plumbing was needed, and that was not obvious enough to assume.** The item card,
   the dense row and the table row are all click-actionable bodies (`useCardClickAction`) that also
   start a pointer drag, so an anchor inside one could plausibly have followed the link *and*
   popped the card's own dialog. It does not: both gestures share `isInteractiveDragOrigin`, whose
   selector already lists `a`. Worth recording, because it is the fact that made a link safe to put
   on a card at all — and it would have been a real obstacle had it gone the other way.
5. **`FieldValue` had no exhaustiveness guard, and a component cannot get one for free.** Its
   `switch` ended without a `default:`, so a new `CardFieldValue` arm would have compiled while
   rendering nothing — the #355 hazard exactly, in the "a component has no return type to protect
   it" form. It now ends in `assertExhaustive`, so the *next* arm cannot be half-added.

**Deliberately not in scope:**

- **The editors.** A `URL` field's control is an `Input type="url"` and a `FILE` field's a text
  box ([TypedFieldControl.tsx:94,158](../../src/features/inventory/components/TypedFieldControl.tsx#L94)),
  neither offering a way to open what you just typed. That is a coherent small addition, but it is
  a different surface with a different question (an editor is for *setting* a value), and it is not
  what `C1`'s "readable but never actionable" charge is about.
- **The bridge.** It publishes the raw string and always has — the DTO comment already offers *"a
  datasheet URL"* as its worked example
  ([dto.ts:84-92](../../bridge/src/api/dto.ts#L84-L92)) — so a consumer's own renderer decides
  openability. Nothing to expose; this is a presentation change on our side only. (The standing
  bridge gap is still the **four** definition attributes `W1a`–`W1d` added, unchanged by this.)
- **Search and export.** A link is still a string to both, correctly: `field:` comparisons match on
  the stored text, and an exported cell holds the address a spreadsheet will linkify itself.

### 4.5 `W1e` — a number's decimal places (shipped)

A custom `NUMBER` definition can carry a number of **decimal places**. A value with more than it
allows is refused at the point of save, and a stored value is *written* to it wherever it is shown
— `5.5` on a two-decimal field reads `5.50` on the item card, the dense row, the table cell and the
location detail panel. Optional, per definition, and a field without it behaves exactly as before.

**Both halves shipped, and that was the decision — not a re-deferral.** §4.2 deferred this on the
grounds that the constraint half alone would read as broken ("someone who sets 2 dp and still sees
`5.5` will call it a bug") and that the display half forces a question about locale formatting. That
argument was accepted rather than restated: shipping half of it was never a real option, so the
locale question had to be answered.

**The design fork: a custom number does *not* join the locale-formatted world.** The app has a
whole `useFormatters` / Foundry `Money` seam for numbers that are — `quantity` groups, `currency`
takes the locale's decimal separator — and a custom `NUMBER` deliberately stays outside it. Three
reasons, each checkable rather than a preference:

1. **Grouping would be wrong as often as right.** `Formatters.quantity` groups because it formats a
   *count*. A custom number is whatever the user made it, and the preset library is full of ones
   that are not counts. A definition named "Year built" holding `2026` would render `2,026`. There
   is nothing on the definition that could tell the two apart, so enrolling them all would trade a
   cosmetic gain on some fields for a plainly wrong number on others.
2. **There would be no locale-aware way to type one back in.** Nothing on the entry path reads a
   locale decimal separator. The calculator behind the value box scans a number as digits, an
   optional `.`, digits, and returns `null` on any character it does not recognise
   ([evaluate-expression.ts:83-98](../../src/components/foundry/evaluate-expression.ts#L83-L98));
   below it `validateFieldValue` parses with a bare `Number(text)`, for which `'5,50'` is `NaN`.
   So under a German locale a card would read `5,50` and *neither* layer of the control that set
   it would take that string back.

   Worth recording what this reason is **not**, because the tempting version of it is false and
   review caught it: money is not different here. `MoneyInput` renders the same
   `Input type="number"` ([money-input.tsx:55-66](../../src/components/foundry/money-input.tsx#L55-L66)),
   which delegates to the same calculator text box
   ([input.tsx:24-31](../../src/components/foundry/input.tsx#L24-L31)), and `snapMoneyInput` parses
   `.`-separated text by its own documented design
   ([format.ts:438-455](../../src/lib/format.ts#L438-L455)) — `decimalSeparatorForLocale` has
   exactly one non-test consumer in the repo, and it is the CSV import dialog, not any money
   control. So money already ships this render-locale/parse-`.` asymmetry and absorbs it, because
   a currency symbol tells the reader what format they are looking at. A bare custom number
   carries no such marker. That makes this a difference of degree rather than of kind, and
   **reasons 1 and 3 are what actually decide it.**
3. **Every other surface publishes the stored string verbatim.** `field:` search comparisons match
   on it, the CSV export writes it, and the bridge serves it. A grouped or comma-separated card
   would be the one surface of five spelling the value differently.

So the display is a fixed-decimal rendering of the canonical form, in the same non-locale terms the
value is already stored and already shown in — not an `Intl.NumberFormat` call. **Rejected:**
enrolling custom numbers in `useFormatters`, and the half-way position of a locale decimal separator
without grouping (which keeps reason 2 and most of reason 3 while gaining almost nothing).

**What building it proved wrong, or made concrete, about the description above.**

1. **It is not "a constraint plus a formatter" — it is one call used twice.** §4.2 wrote the two
   halves as separate jobs. They collapse: the constraint is *"does writing this value at this
   precision lose anything?"*, which is literally `Number(n.toFixed(p)) === n` — the display call,
   compared back. So `field-number-format.ts` exports the pair, and the property that falls out is
   the one the whole design rests on: **a value the validator accepted is one the renderer only
   ever pads.** Rounding is reserved for a value that never met the validator — merged from a peer,
   restored from a backup, or left behind when the precision was tightened afterwards.
   Counting the digits in `String(n)` instead would have been the obvious implementation and a
   wrong one: `String(1e-7)` is `'1e-7'`, which a split on `.` reads as zero decimal places.
2. **The precision is applied on the way *out*, not baked into storage — and that is load-bearing.**
   A `NUMBER` is still stored as the canonical `String(n)`, so a two-decimal field stores `5.5`.
   That is what lets a precision *changed later* reformat every existing value at once, instead of
   leaving a column holding a mixture of old and new spellings that nothing could tell apart. It
   also keeps search, export and the bridge reading exactly what they read before.
3. **`0` is a setting, and it is the one value the surrounding idioms would have dropped.** Every
   other optional number on `field_defs` is meaningless at zero, so the codebase's habits — `??`,
   truthiness — are safe on all of them and wrong on this one. `precision: 0` had to survive the
   reuse path's `applyOnReuse` (which tests `!= null`, so it does), the retype-clearing branch, the
   editor's seeding of its box, the add form's `?? null` collapse (safe: `0` is not nullish), and
   the render arm. Each is now asserted by a test naming `0` specifically, because a truthiness
   slip at any one of them would silently turn "whole numbers only" into "as entered" — the exact
   opposite — with nothing on screen to explain it.
4. **`0` also needed its own message, not a degenerate plural.** "Shelves must have at most 0
   decimal places" is technically true and reads as a bug. The `precision = 0` case says *"Shelves
   must be a whole number."*, matching the `RATING` message beside it, which says the same thing
   about a different rule. The copy stays English rather than a `t()` lookup for the reason
   `rangeError` already records — the seam is dependency-free and runs in the repository and the
   CSV import, neither of which has a translator in scope — so routing it through the catalog is
   one change for all sixteen of that file's messages, not three of them.
5. **A blank guard was needed in the formatter even though every caller drops blanks first.**
   `Number('')` and `Number(' ')` are both `0`, so without it an empty value would render as a
   confident `0.00`. A test caught it. This is the same trap `validateFieldValue` and `resolveBound`
   already write around, met a third time.
6. **The editor's box clamps rather than refusing, unlike the range boxes beside it.** A count of
   decimal places is a bounded whole number — the shape of `due_lead_days`, not of a bound — so
   `9` settles to the cap and `2.5` to `3`, and the control has no error path at all. Its `maxLength`
   is 1 (the cap is a single digit), so a *typed* value can only overshoot the cap by one digit —
   `7`, `8` or `9`; reaching the clamp with anything further out takes a paste. It is still a text
   input with `inputMode="numeric"` rather than `type="number"`, for the reason §4.2's last
   paragraph gives, and `numeric` rather than `decimal` because the count itself is whole.

**Deliberately not in scope:**

- **The editors do not pad.** The value box holds `5.5` while the card reads `5.50`, and that is
  correct rather than inconsistent: the box holds the number you type (and calculator expressions
  on the way to it), and validation only ever refuses *too many* decimals — never too few — so what
  the box holds is always a legal value. Snapping on blur, as `snapMoneyInput` does for money, would
  add a second write path for no gain.
- **Search and export stay raw**, exactly as `W1f` left links: an exported cell holds the number a
  spreadsheet will format itself, and `field:x > 5.5` matches the stored text.
- **Bridge exposure.** `ITEM_FIELD_VALUE_KEYS` and `CategoryFieldDto`/`toCategoryField` still
  describe the pre-`W1a` shape, so a consumer cannot see a precision, a rank, a unit, a range or the
  due-date opt-in. Still one change, now covering **five** attributes, gated by the OpenAPI and
  field-vocabulary drift tests.
- **The preset library sets none.** Same call as `W1b`'s and `W1d`'s: seeding precisions would
  reformat existing users' values on adoption. It pairs with the preset unit-renaming work `W1b`
  deferred.

### 4.6 `W1g` — a `FILE` value's origin device (shipped)

A custom-field value now records **which device recorded it**. A `FILE` value holding a path
that came from a *different* device is marked as such wherever it is shown — the item card, the
dense row, the table cell and the location detail panel — instead of passing as an ordinary
path, and the editor says so beside the box that fixes it. `W1f` removed §11.7's *"with no
explanation"*; this removes the *specific* half it left: **this** path came from **another**
device, and here is how to re-home it.

**The two questions §4.4 could not settle from the read side, and how each was answered.**

**1. Every field value carries an origin, not only a `FILE` one — and the reason is not a
trade-off, it is that the alternative is unavailable.** `W1b`, `W1c` and `W1e` all gate their
column on `field_type` with a table CHECK, and the obvious move was to copy that. It cannot be
copied: those columns sit on `field_defs`, *beside* `field_type`, whereas a value row carries
only `def_id` — and a SQLite CHECK may not reach into another table. So there is no
type-gated shape to have. Three things follow, and they point the same way:

- **A type gate would have to be enforced in the write seam alone**, with nothing under it —
  the opposite of the arrangement §4.1/§4.2 chose deliberately, where the write seam gives the
  readable message and the CHECK is the backstop "under it (and under sync and restore)".
- **Retype-clearing would change scale.** `W1b`/`W1c`/`W1e` clear one `field_defs` row when a
  definition is retyped. Type-gating here would mean clearing every *value* of that definition
  across two tables on every retype — real cost for a column that is simply unread on any other
  type.
- **The fact is about the write, not the type, and it survives a retype.** "Which device
  recorded this string" stays true when a definition is later retyped `TEXT` → `FILE`; a
  type-gated column would hold NULL there, which reads as *unattributed*, which reads as
  **local** — a foreign path silently passing as this device's. The type-gated version is not
  merely more expensive, it is wrong in a case that actually occurs.

So the stored value is the plain fact of the write, and deciding whether it *matters* is the
render boundary's job — the same shape as `W1e`'s "applied on the way out, not baked into
storage". It carries **no CHECK**, for `W1d`'s reason rather than by omission: an opaque device
id has nothing to validate, and a peer's whole sync apply must never fail over an attribution.

**2. The re-linking flow is the editor that already exists — no second flow was built, and
`W1f`'s "editors deliberately not in scope" is not reversed.** `AttachmentManager` needs its
**Re-link** / **Use URL** pair because an attachment row has no inline editor at all: the pair
opens a draft input *and* chooses which `kind` to write. A custom-field value has neither
problem — it has one always-present box, and no `kind` to choose. Typing a path this device can
reach **is** Re-link; pasting a web address **is** Use URL. Adding buttons that focus a box
already on screen would be ceremony.

What was genuinely missing was therefore not a flow but two facts and a rule:

- the read surfaces say *this came from elsewhere* (a distinct icon on the warning token, and
  an assistive-technology label that names it — `title` too, since the icon alone cannot carry
  "and that device isn't this one");
- the editors repeat it under the control, so someone who arrived to fix it is told what to do;
- and the write **re-stamps the origin exactly when the value changes**, which is what makes
  re-linking work at all.

`W1f`'s scope note said editors are for *setting* a value and that `C1`'s "readable but never
actionable" charge is not about them. That still stands: nothing here adds a way to *open* a
value in an editor. This adds an explanation to the surface that already edits it.

**The re-stamp guard is the load-bearing part, and it is a guard rather than a plain
assignment.** Two callers re-send a value the user did not touch — one on each table — and the
thing to notice is that **both of them claim nothing while doing it**:

- A location's *Offer to items here* tick is stored by the same upsert, re-sending `value`
  unaltered to change only the flag, and passing no origin.
- A CSV import re-states **every** field value on a row it matched, unchanged ones included,
  through a port that takes no origin at all.

So the failure an unconditional assignment would cause today is the *same* on both tables: NULL
pushed over a good attribution, quietly downgrading a marked foreign path to an unmarked one.
The guard is symmetric, so it also stops the opposite error — a caller that *does* name a device
claiming a value it did not change — but no current caller can reach that, because the one
writer that names a device (the item editor) sends only the fields whose value actually changed.
That half is a standing guarantee, not a fix for a live bug, and it is worth saying which is
which. The assignment uses SQLite's null-safe `IS`, so clearing to blank and setting again is
judged as the change it is rather than collapsing to unknown.

**Only an *author* attributes; every other writer stays silent.** The stamp is passed per call
rather than read inside the repository or the mutation hook, because the callers genuinely
differ:

| writer | claims | why |
| --- | --- | --- |
| the item and location field editors | **this device** | a person typed the path here |
| clone | nothing | it copies a string; stamping the cloning device would assert a desktop path is reachable from the phone that cloned it |
| CSV import | nothing | a spreadsheet's cells were authored wherever the spreadsheet was, which the importing device cannot know |
| lookup auto-fill | nothing | the value came out of an external catalogue |

NULL therefore means *unattributed*, and unattributed reads as **local** — the legacy rule
`resolveAttachmentLink` has applied to a pre-v18 pointer since it shipped. That is deliberate in
both directions: the three copying paths above, and every row written before the column existed,
must not be warned about, because a warning on values nothing is wrong with is worse than the
silence `W1g` removes. The cost is stated rather than hidden: a cloned or imported foreign path
is **not** marked, and the wiki says so.

**What building it proved wrong, or made concrete, about the description above.**

1. **The effective-value view needed no change, and the touch-point list in the `W1g` entry
   above is wrong to name it.** `item_field_effective_values` projects `item_id, def_id, value`
   and has exactly two readers — the search AST translator and the due-date feed — neither of
   which wants an origin. The *rendered* item path does not go through the view at all:
   `resolveItemFields` resolves inheritance **in JS**, through the pure `location-inheritance`
   seam, from a separate whole-table read of the inheritable offers. So the origin follows
   `value` through `resolveFieldValue`, and the view was left alone. Adding it there would have
   doubled the recursive ancestor subquery on the search path to serve no reader.
2. **Sync and backup needed nothing, exactly as `W1e` found — but the bridge needed nothing
   either, and that was not safe to assume.** `buildSchemaDictionary` reads columns from
   `PRAGMA table_info` and the snapshot reads `SELECT *`, so the column syncs, backs up and
   restores untouched; `tombstone.ts` keys on tables, so its drift test is silent. The bridge is
   the part §4.4 flagged as possibly different, and it is — but the answer is still *no change*,
   and it is worth being exact about what stops the column at the wire, because it is **not** the
   repository read. The bridge reads item field values through `resolveItemFields` and location
   values through `listLocationFieldValues`, and this change widened **both** — the editors need
   the origin, and the bridge takes the same seams. What holds the line is one layer further out:
   `toItemFieldValues` and `toLocationFieldValues` (`bridge/src/api/dto.ts`) build their DTOs as
   explicit object literals, so a new property on the app's type is silently dropped rather than
   published. And it should be: a device id is only meaningful *compared against the reading
   device*, and the bridge is not a device — it has no Gubbins device identity to compare with,
   so publishing the id would be publishing an opaque token no consumer can interpret. (`item_attachments`, the existing device-stamped pointer, is likewise not exposed
   by the bridge at all.) The standing gap is still the **five** definition attributes
   `W1a`–`W1e` added, unchanged by this.
3. **`resolveAttachmentLink` is now partly reusable, which is precisely what §4.4 point 2 said
   it was not — and the shared part is the comparison, not the seam.** That note recorded that
   a field value had "neither column" the attachment seam reads, so calling it would be
   ceremony. Adding the origin column supplies one of the two. The other, `kind`, is still
   absent — a field value's openability is decided from the *string* by `external-href.ts` — so
   the seam as a whole still cannot be called. What is now genuinely shared is the one-line
   comparison **and its NULL rule**, lifted into `inventory/device-origin.ts` and called by
   both. Worth doing for a single line because the rule that *unattributed is not foreign* is
   the one both surfaces must never disagree about.
4. **The card's value map had to become an object, and a parallel map would have been the wrong
   economy.** `getItemFieldValues` returned `itemId → fieldId → string`; the card now needs a
   second fact per value. Threading a second `fieldId → origin` map beside it would have left
   nothing preventing the two describing different rows — precisely the failure a single entry
   rules out. The blast radius turned out to be small: the map is built once and spread onto the
   item surfaces by `cardFieldProps`, so the shape change cost three prop-type lines plus the
   resolver, and reached the card, the dense row and the table cell without any of *those* being
   otherwise touched. The location detail panel is **not** on that path — it reads
   `listLocationFieldValues` and calls `resolveLocationDetailFields`, so it took the origin by a
   separate route (one argument, and the `getDeviceId()` read to supply it) and had to be edited.
   That asymmetry is the pre-existing shape of the two subjects, not something this change
   introduced: `W1f` reached all four surfaces through one `customFieldValue` seam precisely
   because that seam is where they *do* converge, and it is still the only edit the renderers
   themselves needed here.
5. **An incomplete hand-built test fixture produced the exact inverse of the intended
   behaviour, and only running the tests caught it.** `LocationDetailCard.test.tsx` builds its
   `LocationFieldValue` objects by hand and had never listed the newer definition columns. With
   `originDeviceId` *absent* rather than null, `undefined !== null && undefined !== deviceId` is
   **true** — so every `FILE` path in that suite read as foreign. Types could not catch it
   (test files are excluded from `tsconfig.app.json`), and the failure surfaced only as a
   missing label. The fixture now spells the column out with a note saying why; the guard was
   deliberately *not* loosened to `!= null`, because in production the value comes from a typed
   mapper and defending against a shape the types forbid would be defending against nothing.
6. **A runtime probe proved the whole chain in a way no test does.** Changing
   `gubbins:device-id` in `localStorage` and reloading reproduces exactly what a synced row
   looks like from the other side, without needing a second device or a sync round trip. Driven
   against a dev server it confirmed: the save stamps this device; the card then marks the path
   and still shows it; the editor explains it; an untouched editor offers *nothing to save*, so
   the path cannot be re-homed by accident; and re-linking moves the origin and clears the mark
   everywhere.

**Deliberately not in scope:**

- **Search and export stay raw**, as `W1f` and `W1e` left them. The origin is not a value: it is
  metadata about where one was typed, meaningless in a `field:` comparison and meaningless in a
  spreadsheet cell.
- **No "re-link this everywhere" bulk action.** Several items can share a definition and each
  hold a different path, so there is no single substitution to apply. A find-and-replace across
  field values is a coherent, separate request.
- **The datasheet list is unchanged.** `item_attachments` has carried this since v18; the point
  of `W1g` is that the custom-field surfaces now agree with it, not that either changes.
- **Nothing is recorded *about* a device — only that it differed.** A device name would need a
  device registry that syncs, which is a much larger thing than the comparison this needs; and
  the id is device-local by design (`lib/env/device-id`).

## 5. Defects found while surveying

These are not archetype gaps — they are existing behaviour that looks wrong, found incidentally.
**All six are now filed as [#683](https://github.com/BootBlock/Gubbins/issues/683)–[#688](https://github.com/BootBlock/Gubbins/issues/688)**;
each issue carries the full evidence, so treat those as the live record and this section as the
summary of how they were found. Three of the six are documentation drift, where the wiki promises
behaviour that does not exist.

1. **Every `CONSUMABLE_GAUGE` item is valued at zero** ([#683](https://github.com/BootBlock/Gubbins/issues/683)). ✅ **Fixed** — a gauge now carries a
   `cost_per_unit_of_measure`, and every valuation read multiplies its `current_net_value` by that
   instead of its (always-zero) count: the headline, both breakdowns, `locationStats`, the trend,
   stock aging, dead stock and the insurance schedule. It is deliberately never priced from
   `unit_cost`, a manual current value or a supplier quote — all three price one *countable* unit,
   so reading one per gram would be wrong by whatever the capacity is — and a gauge holding
   unpriced material is surfaced by its own notice beside the foreign-currency one rather than
   totalled as nothing. As found: valuation is `MAX(i.quantity, 0) ×
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
2. **Batch expiry never raises an alert** ([#684](https://github.com/BootBlock/Gubbins/issues/684)) — §3.8 above. ✅ **Fixed** — the expiry
   predicate reaches into `stock_batches` for the earliest dated lot still in stock and compares it
   against the item's own date, and the derived date is projected onto every item read so the pure
   classifiers judge it the same way. As found: the stock-recompute triggers propagate quantity
   only, so nothing lifted a lot's expiry to the item. **The wiki asserted the opposite** under a
   section headed "Batches and expiry alerts": "Batch expiry dates feed the expiry tracking and the
   Alerts / Upcoming feeds, so a batch approaching its date surfaces before it lapses"
   ([Batches-and-Lots.md](../wiki/Batches-and-Lots.md)) — a second, user-facing defect alongside the
   behavioural one, and the one the fix makes true rather than retracts.
3. **Consumption rate sums incommensurable units** ([#685](https://github.com/BootBlock/Gubbins/issues/685)). ✅ **Fixed** — the read joins `items`
   and the report is now one line per unit of measure, with no total across them; the Reports
   screen, its per-unit panel and the CSV all label every figure. As found: grams, millilitres and
   screws were added together into one `totalConsumed` scalar, with no `GROUP BY` and no join to
   `items`, so the mixed figure was the *entire* report — rendered as both a daily rate and a total,
   and exported to CSV, with no unit and no qualifier.
4. **Clearing an item's activity log can report it as dead stock the next day** ([#686](https://github.com/BootBlock/Gubbins/issues/686)). ✅ **Fixed** — the
   clear marker now counts as evidence, so an item is judged from the later of its last movement
   and its last log clear, and only falls through to `items.created_at` when it has neither. As
   found: dead-stock idle
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
   booked verbatim as base-currency cost. ✅ **Fixed:** the guard and the preferred-supplier lookup
   now live in one shared module (`db/repositories/supplier-cost-sql.ts`) that both the reports and
   the sale path import, so a foreign price is declined on a sale exactly as it is in valuation.
6. **Straight-line depreciation is orphaned, and the documentation says otherwise** ([#688](https://github.com/BootBlock/Gubbins/issues/688)). ✅ **Fixed** — the
   depreciated purchase price is now the **last** step of the *valuation* precedence, below a manual
   current value, a manual unit cost and the preferred supplier price, so an asset priced only by
   what it cost and how long it lasts is valued at its book value rather than at nothing. The rule is
   stated in both halves of the valuation seam — the pure `valuedUnitValue` and the SQL that lets a
   whole-inventory total be summed by the database — and a randomised test pins the SQL formula
   against `currentValue()`. It stops at valuation: turnover's cost of goods, ABC's consumption value
   and dead stock's tied-up capital keep reading the bare cost seam, because a write-down refunds
   none of what stock cost, and a test pins that they still differ. The
   six affected wiki pages, the item editor's hint and the bridge schema now describe the real
   precedence, and the wiki's phantom "salvage floor" is gone. As found: `currentValue()`
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
