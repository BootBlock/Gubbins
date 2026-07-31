# Non-items attached to a Location — what the ask really is (2026-07-31)

> **Status:** 🟢 ACTIVE — research complete; the ranked candidates `N1`–`N7` are an open backlog,
> none started.

Answers issue [#617](https://github.com/BootBlock/Gubbins/issues/617): *is there a valid use for
attaching an "item" to a `Location` that isn't an actual `Item` — a Note, say — and what else can be
added or improved in these areas?*

Method: three parallel reads of the location schema and repositories, the item model, and the
surrounding entity map, followed by point verification of every claim asserted below. File
references are to the state of `main` at `d4d8d385`.

---

## 1. The finding in one paragraph

**Yes — but the Note is the wrong example, because a location already has one.** A `Location` can
carry free text ([`description`](../../src/db/migrations/v1-initial.ts#L1360), rendered as
Markdown), any number of typed custom-field values
([`location_field_values`](../../src/db/migrations/v1-initial.ts#L649) — including `LONG_TEXT`,
`URL`, `DATE`, `IMAGE` and `FILE`), tags, and photos with named regions drawn on them. What it
cannot do is **show** them. A location has no page of its own — it is a *filter on `/inventory`*,
not a screen — so everything attached to it either rides as a hover tooltip, hides inside an Edit
dialog, or is published to Home Assistant and never rendered in the app at all. The valid non-item
attachments are real, but the binding constraint is a **missing surface, not a missing table**; and
the two that genuinely need schema — a document, and a date that can raise something — are each
already a filed issue or a candidate in the archetypes audit. Building a polymorphic "location
child" table would be solving the one part of this that isn't broken.

## 2. What a user might actually mean

Five distinct asks hide inside "a non-item attached to a Location". They have different answers, and
conflating them is what makes the issue look like one schema change.

**A. Free text about the place** — *"Shelf B is the overflow for the workshop"*, *"no solvents here,
unventilated"*, *"key is in the kitchen drawer"*. **Already possible** (`description`), with three
specific weaknesses — §4.

**B. A structured fact about the place** — a shelf's load rating, a room's humidity, an access code,
who looks after it. **Already possible** and fully typed (`location_field_values`), and effectively
invisible — §5.

**C. A document pinned to the place** — the boiler manual in the airing cupboard, the workshop's
wiring diagram, a fire-safety certificate for the garage. **Genuinely absent**: `item_attachments`
has no location counterpart, and a `URL` custom field is the only route. Overlaps
[#466](https://github.com/BootBlock/Gubbins/issues/466) and `W6` in the archetypes audit — §8 `N4`.

**D. A dated, actionable thing about the place** — an inspection due, a PAT test, *"check for damp in
spring"*. **Recordable, inert.** A `DATE` value on a location is stored and displayed and raises
nothing, which is precisely `W1` in the
[archetypes audit](weak-item-archetypes_2026-07-31.md#4-candidate-work-items) with a location as the
subject instead of an item — §8 `N5`.

**E. A placeholder for contents you aren't cataloguing** — *"a box of assorted cables"*. This one
only *looks* like a non-item. `UNTRACKED` exists for exactly it — "catalogued, searchable and
locatable, but with no quantity to count"
([constants.ts:62-71](../../src/db/repositories/constants.ts#L62-L71)) — and is the honest answer,
with the caveats in §6.

Anything a user wants to attach that is **not** one of these five is, on inspection, one of the
non-goals in §7.

## 3. What can already be attached to a Location

| Thing | Where it lives | Where the user sees it |
| --- | --- | --- |
| One free-text description (Markdown) | `locations.description` ([:1360](../../src/db/migrations/v1-initial.ts#L1360)) | Hover tooltip on the tree row; a card above the item list when selected |
| Typed custom-field values, any number, optionally inherited by contents | [`location_field_values`](../../src/db/migrations/v1-initial.ts#L649) | **Only** inside the Edit dialog's Details tab |
| Tags | [`location_tags`](../../src/db/migrations/v1-initial.ts#L761) | Edit dialog; the sidebar's tag filter |
| Photos, and named regions drawn on them | [`location_photos`](../../src/db/migrations/v1-initial.ts#L2020), [`location_regions`](../../src/db/migrations/v1-initial.ts#L2046) | Edit dialog's Photos tab; the location map view |
| Child locations | `locations.parent_id` | The tree, and `SubLocationNav` |
| Policy and geometry (capacity, W×H×D, packing factor, walk order, dead-stock mode) | columns on `locations` | Edit dialog; the fullness bar |

There is also one existing precedent for **a record, rather than an item, pointing at a location**:
a loan's borrower is a tagged union of contact XOR project XOR location
([:977-1001](../../src/db/migrations/v1-initial.ts#L977)), so *"out in the van"* is already a
non-item thing attached to a place. The wiki documents it
([Locations-and-Stock.md](../wiki/Locations-and-Stock.md), *Portable & mobile containers*). Worth
noting because it establishes that a location can be the subject of a record without any of the
machinery this issue imagines it needs.

## 4. Why the Note feels missing anyway

`locations.description` is a real free-text note. Three things make it feel like one isn't there.

**It cannot be found.** The sidebar's search box matches a location's **ancestry path only** —
`locationsMatchingQuery` builds `"Parent / Child"` and tests that
([location-tree.ts:146-171](../../src/features/inventory/location-tree.ts#L146-L171)) — and the
global search box is `items_fts`, which indexes seven **item** columns and nothing else
([:924](../../src/db/migrations/v1-initial.ts#L924)). So the words you typed into a location's
description cannot be searched for, from anywhere in the app. A note you can't retrieve is a note
you stop writing.

**It is one field doing three jobs.** The wiki's own description of it — "free notes about the
location (what it holds, how to get to it, a link)" — is three different kinds of statement, and the
one that most wants to stand out (a *warning*: unventilated, damp, load limit) has no way to look
different from the one that wants to stay quiet.

**It leaves the app in a backup but not in an export.** `locations` is a synced table, so a
description survives sync and restore. But every *export* reduces a location to a name string —
the JSON and CSV payloads carry `locationName` per item
([run-export.ts:400-415](../../src/features/export/run-export.ts#L400)) and the Markdown vault uses
it as a folder name ([export-data.ts:371](../../src/features/export/export-data.ts#L371)). No export
carries a location's description, kind, capacity, dimensions or walk order, and the
[tabular-export seam](../../src/features/export/tabular-export.ts) — which covers ten lists,
including Tags and Contacts — has no location list at all.

## 5. The general mechanism already exists, and is hidden

`location_field_values` is a fully typed key/value store on a location: a `LONG_TEXT` value *is* a
second note, a `URL` value *is* a linked document, a `DATE` value *is* a recorded due date. It
shares the `field_defs` dictionary with items and categories, and it carries one thing items don't —
an explicit `is_inheritable` flag, so a location can hold a value purely as **its own detail**
without offering it to the items inside
([:649-658](../../src/db/migrations/v1-initial.ts#L649)).

Three things bury it:

1. **The panel is named after the thing it optionally does to items, not what it holds.** It is
   titled *"Inheritable fields"*
   ([en.json:615](../../src/features/i18n/catalogs/en.json#L615)), directly above a checkbox whose
   own hint says the opposite is supported — "When off, the value is kept as this location's own
   detail and is not offered to anything inside it" (`:623`). The component's doc comment agrees
   ("a shelf's load rating, a room's humidity"), and so does the wiki. A user looking for somewhere
   to record a fact about a shelf is reading a heading that tells them this panel is for something
   else. See §9.
2. **It renders in exactly one place.** `LocationFieldsEditor` is mounted only in the Edit dialog's
   Details tab. Nothing else in the app reads a location's field values — not `LocationInfoCard`,
   not the tree, not the item list, not search, not any export. Verified by call-site sweep.
3. **The bridge publishes them.** `include=fields` on the REST location view
   ([location-view.ts:48](../../bridge/src/api/location-view.ts#L48)) and the retained MQTT state
   ([mqtt/state.ts:109](../../bridge/src/mqtt/state.ts#L109)) both expose `fieldValues` per
   location, which Home Assistant surfaces as entity attributes.

So a Home Assistant dashboard already shows a location's own detail; Gubbins itself will only show
it to you if you open the location's editor. That asymmetry — **published, but not displayed** — is
the single clearest statement of what #617 is actually asking for.

## 6. What happens if you fake it with an Item today

The issue's framing ("an item that isn't an actual item") is right to be wary. An item is cheap to
create — the only genuinely required input is a name
([create.ts:73-79](../../src/db/repositories/item/create.ts#L73)) — and expensive to have around,
because **every aggregate in the app keys off `items`**. A note-shaped item pollutes:

- the vault item count, the location's item-count badge and its capacity gauge — the
  `location_item_counts` cache is maintained by three triggers that fire on `items` and nothing else
  ([:2120-2159](../../src/db/migrations/v1-initial.ts#L2120));
- inventory valuation and its **unpriced-inventory** count, and therefore the printed insurance
  schedule and the parts catalogue;
- the data-hygiene report, which a note fails on six of its seven checks — every one bar
  `duplicate-mpn` ([data-hygiene.ts:21-28](../../src/features/reports/data-hygiene.ts#L21));
- dead-stock and stock-aging, since a note is idle by definition;
- the cycle-count sheet — a `DISCRETE` note becomes a line to tick off at every audit;
- FTS search and the command palette, every export and the sync payload;
- an `item.created` webhook/SSE event, and the Home Assistant `itemsTotal` sensor.

`UNTRACKED` removes the worst of it — it is excluded from low-stock, reorder, cycle count, checkout
and bookings by design — but it is still *an item*: still counted, still valued, still in the
hygiene report, still exported, still a Home Assistant number. It is the right tool for **use case E**
(a real physical thing you decline to count) and the wrong tool for A–D.

The useful corollary: because every aggregate keys off `items`, **anything that isn't an `items` row
is automatically excluded from all of it.** Non-item attachment is structurally safe here; that is
not the hard part.

## 7. What this issue is *not*

Recorded so they aren't folded in and used to inflate the scope.

- **An item that *is* a place** — the flight case, the toolbox you bought. That is the same table
  boundary from the opposite side and is `W3` in the
  [archetypes audit](weak-item-archetypes_2026-07-31.md#4-candidate-work-items) (§3.7 there). Neither
  implies the other.
- **A bookable location.** `asset_bookings.item_id` is the only booking subject
  ([:1587](../../src/db/migrations/v1-initial.ts#L1587)); §3.10 of the archetypes audit.
- **Storing file *bytes*.** Gubbins cannot store a file — `item_attachments.kind` is
  `URL | LOCAL_POINTER` ([constants.ts:326](../../src/db/repositories/constants.ts#L326)). That is
  `W6` / [#466](https://github.com/BootBlock/Gubbins/issues/466), and `N4` below must not quietly
  become it.
- **A polymorphic `location_children` table.** Gubbins' precedent is a **narrow typed table per
  need** — `location_tags`, `location_field_values`, `location_photos` are each their own table with
  their own cascade. A polymorphic child would have to be threaded through sync classification (and
  its drift test), tombstones, `FK_REFS`, natural-key collision rules, the permission registry, the
  snapshot filter, the bridge DTOs and every export — for no capability a narrow table doesn't
  already give. Add a table per thing, or add nothing.
- **Tasks and people as first-class entities** — a standing non-goal (§6 of the archetypes audit);
  contacts are an address book by design. `N5` is a *date that can alert*, not a task system.

## 8. Candidates, ranked

Ranked by *(what it unlocks) ÷ (cost)*, and deliberately weighted toward **surfacing what exists**,
because §5 is the finding: the mechanism is built and nobody can see it. None started.

- **`N1` — Give a location's own detail somewhere to appear.** Render a location's
  non-inheritable field values, alongside its description, where a location is actually looked
  at — the `LocationInfoCard` strip above the item list, and/or the `SubLocationNav` cards — rather
  than only inside the Edit dialog. Rename the *"Inheritable fields"* panel to name what it holds
  (§9). **Zero schema change**, and it is the whole difference between "a location can hold a note"
  (true today) and "a location's note is worth writing" (not yet). Adjacent to
  [#619](https://github.com/BootBlock/Gubbins/issues/619), which asks the same question for items
  and does not cover locations.
- **`N2` — Make a location's own text findable.** Extend `locationsMatchingQuery` to match
  `description` — and, once `N1` lands, its field values — alongside the ancestry path. Cheap,
  client-side, and it is what turns an attached note from write-only into retrievable. The larger
  version is a `locations_fts` table so the global search box can return a *place* and not only its
  contents; scope that separately.
- **`N5` — A date on a location that can raise something.** The only candidate here that needs the
  feed layer rather than the schema: a `DATE` value on a location is already recordable and fires
  nothing, because no alert lane or agenda lane reads `location_field_values` — or
  `item_field_values`, which is the identical gap `W1` records for items. **Do it with `W1`, as one
  change over two subjects**, not as a location-only special case. Unlocks use case D (inspections,
  PAT tests, seasonal checks).
- **`N6` — A location activity record.** Renaming, re-parenting, archiving, resizing or re-colouring
  a location records **nothing, anywhere** — `LocationRepository.update` writes a bare `UPDATE` and
  no ledger row. Only *deleting* a location leaves a trace, and even then as item-scoped
  `RE_PARENTED` entries on everything it re-homed
  ([LocationRepository.ts:491-498](../../src/db/repositories/LocationRepository.ts#L491)). There are
  also **zero `location.*` event types** — the whole vocabulary is `item.*` plus `stock.adjusted`,
  `events.truncated` and `lookup.resolved`
  ([event-types.ts:35-112](../../src/features/events/event-types.ts#L35)). `item_history.item_id` is
  `NOT NULL` by construction, so this is a sibling table or a nullable subject column, not a tweak.
  This is the strongest answer to the issue's "what else can be improved", and it is what would make
  [#565](https://github.com/BootBlock/Gubbins/issues/565) diagnosable.
- **`N4` — Location attachments (links and local pointers).** Mirror `item_attachments` on a
  location: the boiler manual, the wiring diagram, the certificate. Be honest about the case — a
  `URL` custom field already does most of this, so what a table buys is **several of them, ordered
  and labelled**, not a new capability. Must not drift into storing bytes (`W6`), and should be
  scoped against [#466](https://github.com/BootBlock/Gubbins/issues/466) before starting.
- **`N7` — A location list export.** Add locations to the tabular-export seam, and carry the
  description (and kind/capacity/dimensions/walk order) in the JSON export and as a folder-level
  page in the Markdown vault. Mechanical, and it closes §4's third weakness.
- **`N3` — A repeating note list on a location — *only if `N1` proves one field isn't enough*.** A
  narrow `location_notes` table shaped like `location_photos` (`id`, `location_id` CASCADE, `body`,
  `kind`, `position`, timestamps). Deliberately last, and deliberately conditional: a second
  free-text field that nothing reads is strictly worse than one. If the real want is *many typed
  notes*, that is `W2` (repeating fields) in the archetypes audit, applied to a location — solve it
  once, for both subjects.

## 9. Defects found while surveying

Not part of the ask — existing behaviour that looks wrong, found on the way.

1. **A location's own detail lives under a heading that says it is for something else.** The
   custom-field panel in the Edit dialog is titled *"Inheritable fields"*
   ([en.json:615](../../src/features/i18n/catalogs/en.json#L615)), but a **non**-inheritable value is
   an explicitly supported and documented use: the checkbox hint says "When off, the value is kept
   as this location's own detail and is not offered to anything inside it" (`:623`); the component's
   own doc comment gives the examples ("a shelf's load rating, a room's humidity",
   [LocationFieldsEditor.tsx:16-23](../../src/features/inventory/components/LocationFieldsEditor.tsx#L16));
   and the wiki repeats the same note. So the panel is named after its *optional* behaviour rather
   than its content, and a user looking for where to record a fact about a place is told this isn't
   it. Both the heading and the wiki section title need to change together.
2. **Database Maintenance reports a photo count and a byte figure that don't measure the same
   thing.** The stats panel renders *"Photos: N · X on disk"*
   ([DatabaseMaintenanceDialog.tsx:499-503](../../src/features/maintenance/DatabaseMaintenanceDialog.tsx#L499)),
   where `N` is `COUNT(*)` over **`item_images` only**
   ([db-maintenance-actions.ts:480](../../src/features/maintenance/db-maintenance-actions.ts#L480))
   while `X` is the measured size of the whole OPFS `images/` directory — which item photos and
   **location** photos share, as the orphan sweep's own comment states ("item photos and location
   photos share one flat `images/` directory", `:203-206`). A vault with location photos therefore
   reads a count that excludes them beside a size that includes them. The fallback path is wrong the
   other way: with OPFS unmeasurable, `imageBytes` is estimated from `imageCount` (`:492`), so
   location photos are estimated at zero bytes. Both arms of the same figure; one fix.

## 10. Recommendation

Take `N1` and `N2` first, as one change. Together they cost no schema and they answer #617's literal
question — *can a non-item be attached to a location?* — with **yes, it already can, and now you can
see it and find it.** Only after that is it possible to tell whether `N3`/`N4` are wanted, or whether
the existing field mechanism was sufficient all along and simply invisible. `N5` should be folded
into `W1` when that is picked up, and `N6` is worth filing on its own merits regardless of what
happens to the rest of this document.
