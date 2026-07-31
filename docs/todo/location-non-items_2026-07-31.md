# Non-items attached to a Location — what the ask really is (2026-07-31)

> **Status:** 🟢 ACTIVE — research complete. `N1` and `N2` shipped together (2026-07-31), along with
> both §9 defects ([#689](https://github.com/BootBlock/Gubbins/issues/689),
> [#690](https://github.com/BootBlock/Gubbins/issues/690) — both closed). `N6`
> ([#691](https://github.com/BootBlock/Gubbins/issues/691)) shipped 2026-07-31 — see §11.5, and the
> limitation it left ([#693](https://github.com/BootBlock/Gubbins/issues/693)) shipped the same day.
> `N7` shipped 2026-07-31 — see §11.6. `N3` and `N4` are both **resolved without building them** —
> see §11.4 and §11.7. `N5` remains open (and belongs to `W1`), as does the deferred `locations_fts`
> table.

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
the two that genuinely need more than a surface — a document, and a date that can raise something —
each sit beside work already filed or ranked elsewhere, so both want scoping against it rather than
starting fresh. Building a polymorphic "location child" table would be solving the one part of this
that isn't broken.

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
has no location counterpart, and a `URL` or `FILE` custom field — both of which store a link
string, not bytes — is the only route. Overlaps
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
| Typed custom-field values, any number, optionally inherited by contents | [`location_field_values`](../../src/db/migrations/v1-initial.ts#L649) | As the location's *own* detail: only inside the Edit dialog's Details tab. An *inheritable* value also surfaces on the items that adopt it |
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
description survives sync and restore. No *export* carries one. The Markdown vault gets closest,
reducing a location to a folder name
([run-export.ts:400-415](../../src/features/export/run-export.ts#L400),
[export-data.ts:371](../../src/features/export/export-data.ts#L371)); the JSON payload is
`{ items, contacts, checkouts }` with no locations array at all
([export-data.ts:22-31](../../src/features/export/export-data.ts#L22)), so an item carries a bare
`locationId` UUID; and the items CSV has no location column, while the catalogue CSV writes the same
raw UUID — which is [#596](https://github.com/BootBlock/Gubbins/issues/596) from the item side.
Nothing anywhere exports a location's description, kind, capacity, dimensions or walk order, and the
[tabular-export seam](../../src/features/export/tabular-export.ts) — which covers a dozen lists,
from Contacts to the insurance schedule — has no location list at all.

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
2. **A location's own detail renders in exactly one place.** `LocationFieldsEditor` is mounted only
   in the Edit dialog's Details tab, and nothing else in the app reads a location's field values
   *as facts about the location* — not `LocationInfoCard`, not the tree, not the item list, not
   search, not any export. Note the asymmetry that proves the point: a value marked **inheritable**
   is read all over the place, because it stops being the location's detail and becomes the item's
   — the card-field resolver reads
   `location_field_values WHERE is_inheritable = 1`
   ([CategoryRepository.ts:455](../../src/db/repositories/CategoryRepository.ts#L455)), and the
   `item_field_effective_values` view carries the same value into search
   ([:712-736](../../src/db/migrations/v1-initial.ts#L712)) and the catalogue export. So the app
   already knows how to surface these values — it just refuses to do it for the one flag state whose
   documented purpose is "this is about the place".
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

- the vault item count, the location's item-count badge and its capacity gauge — the three triggers
  that *increment* `location_item_counts` all fire on `items`
  ([:2120-2159](../../src/db/migrations/v1-initial.ts#L2120)), and the only other one sweeps the
  cache when a location is deleted (`:2165`);
- inventory valuation and its **unpriced-inventory** count, and therefore the printed insurance
  schedule and the parts catalogue;
- the data-hygiene report — four of its seven checks immediately (no category, no price, no photo,
  never counted) and a fifth once it goes stale
  ([data-hygiene.ts:21-28](../../src/features/reports/data-hygiene.ts#L21)). Not `missing-location`,
  which flags only the Unassigned holding pen (`:37-38`), and not `duplicate-mpn`;
- stock aging unconditionally, and dead-stock reporting wherever the note's location chain has
  opted in — that one is opt-in by design
  ([dead-stock.ts:4-7](../../src/features/reports/dead-stock.ts#L4));
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
- **Storing a *document's* bytes.** Gubbins holds image bytes (a photo's thumbnail blob plus its
  OPFS full-res, and a bounded WebP inside an `IMAGE` field value) but nothing else:
  `item_attachments.kind` is `URL | LOCAL_POINTER`
  ([constants.ts:326](../../src/db/repositories/constants.ts#L326)), a link or a path string. That is
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
because §5 is the finding: the mechanism is built and nobody can see it. `N1` and `N2` shipped
together on 2026-07-31 (see §11 for what building them proved wrong); `N6`
([#691](https://github.com/BootBlock/Gubbins/issues/691)) and `N7` shipped the same day (§11.5,
§11.6); `N3` and `N4` are each resolved without being built (§11.4, §11.7); `N5` is unstarted.

- **`N1` — Give a location's own detail somewhere to appear. ✅ SHIPPED.** Render a location's
  non-inheritable field values, alongside its description, where a location is actually looked
  at — the `LocationInfoCard` strip above the item list, and/or the `SubLocationNav` cards — rather
  than only inside the Edit dialog. Rename the *"Inheritable fields"* panel to name what it holds
  (§9). **Zero schema change**, and it is the whole difference between "a location can hold a note"
  (true today) and "a location's note is worth writing" (not yet). Adjacent to
  [#619](https://github.com/BootBlock/Gubbins/issues/619), which asks the same question for items
  and does not cover locations.
  *As built:* the existing description block above the item list became a **detail panel**
  (`LocationDetailCard`) carrying both halves, the compact strip was left alone, and the
  `SubLocationNav` cards gained a one-line plain-text preview of a child's description. The panel
  shows **every** value the location holds, not only the non-inheritable ones — see §11.1 for why
  the scope above turned out to be wrong.
- **`N2` — Make a location's own text findable. ✅ SHIPPED.** Extend `locationsMatchingQuery` to match
  `description` — and, once `N1` lands, its field values — alongside the ancestry path. Cheap,
  client-side, and it is what turns an attached note from write-only into retrievable. The larger
  version is a `locations_fts` table so the global search box can return a *place* and not only its
  contents; scope that separately — **still deferred, and still unstarted.**
  *As built:* `description` rides on the flat list the sidebar already reads; field values come
  from one bounded `listLocationFieldSearchText()` read that is deferred until the user types.
- **`N5` — A date on a location that can raise something.** The only candidate here that needs the
  feed layer rather than the schema: a `DATE` value on a location is already recordable and fires
  nothing, because no alert lane or agenda lane reads `location_field_values` — or
  `item_field_values`, which is the identical gap `W1` records for items. **Do it with `W1`, as one
  change over two subjects**, not as a location-only special case. Unlocks use case D (inspections,
  PAT tests, seasonal checks).
- **`N6` — A location activity record. ✅ SHIPPED
  ([#691](https://github.com/BootBlock/Gubbins/issues/691), 2026-07-31).** Renaming, re-parenting,
  archiving, resizing or re-colouring
  a location records **nothing** beyond bumping its own `updated_at` — `LocationRepository.update`
  writes a bare `UPDATE` and no ledger row. Only *deleting* a location leaves a readable trace, and
  even then only as item-scoped entries: `RE_PARENTED` on the items **homed** there
  ([LocationRepository.ts:491-498](../../src/db/repositories/LocationRepository.ts#L491)) and
  `CHECKED_IN` on anything out on loan to it. Stock merely *placed* at the location is re-homed by
  the batch merge with no ledger entry at all (`:508-518`). There are
  also **zero `location.*` event types** — the whole vocabulary is `item.*` plus `stock.adjusted`,
  `events.truncated` and `lookup.resolved`
  ([event-types.ts:35-112](../../src/features/events/event-types.ts#L35)). `item_history.item_id` is
  `NOT NULL` by construction, so this is a sibling table or a nullable subject column, not a tweak.
  This is the strongest answer to the issue's "what else can be improved", and it is what would make
  [#565](https://github.com/BootBlock/Gubbins/issues/565) diagnosable.
  *As built:* a `location_history` sibling table, appended from `LocationRepository` for create,
  rename, re-parent, archive/restore and delete (and on each sub-location a delete promotes); a
  `location.*` event slice reaching the webhook subscription picker and the bridge's event stream;
  and a **History** tab on the location editor. It does **not** reach the app's global Activity
  feed, which still reads `item_history` alone — a cross-location activity view is the obvious
  follow-on and is deliberately not in this pass. Geometry, colour, capacity, walk order and policy
  edits record nothing. §11.5 records the three places the entry above turned out to be wrong about
  the shape of it.
  *Follow-on, since shipped:* that cross-location view is now built
  ([#693](https://github.com/BootBlock/Gubbins/issues/693), 2026-07-31) as a second **lane** on the
  existing Activity screen, selected by an Items/Locations switch — so the honest limitation §11.5
  records (a deleted location's entries having no in-app reader) no longer holds. The lanes are
  switched between rather than interleaved; a genuine chronological merge of the two ledgers stays
  deliberately unbuilt.
- **`N4` — Location attachments (links and local pointers). ⛔ RESOLVED WITHOUT BUILDING IT — the
  scoping came back "no".** The proposal was to mirror `item_attachments` on a location: the boiler
  manual, the wiring diagram, the certificate. It was written to be honest about the case — a `URL`
  custom field already does most of this, so what a table buys is **several of them, ordered and
  labelled**, not a new capability — and to be scoped against
  [#466](https://github.com/BootBlock/Gubbins/issues/466) before starting. Scoped, it fails on
  exactly that honesty: the parity is not "most of it" but **both kinds**, `URL` and `FILE`, and the
  three things a table would genuinely add are each a two-subject change already owned elsewhere —
  ordering and repeats by `W2`, an openable value and a pointer's device attribution by the new
  `W1f`. §11.7 has the evidence, including why #466 does not *subsume* this but does make building it
  now premature.
- **`N7` — A location list export. ✅ SHIPPED (2026-07-31).** Add locations to the tabular-export
  seam, and carry the description (and kind/capacity/dimensions/walk order) in the JSON export and
  as a folder-level page in the Markdown vault. Mechanical, and it closes §4's third weakness.
  *As built:* all three, exactly as scoped. A `TabularExportMenu` in the Inventory sidebar's
  Locations header, over a pure `locations-export.ts` whose rows carry the ancestry a flat table
  loses; a `locations` array in the JSON payload (format version 2); and an Obsidian folder note
  per location folder in the vault. It does **not** close
  [#596](https://github.com/BootBlock/Gubbins/issues/596) — see §11.6.
- **`N3` — A repeating note list on a location. ⛔ RESOLVED WITHOUT BUILDING IT — the condition
  came back "no".** The proposal was a narrow `location_notes` table shaped like `location_photos`
  (`id`, `location_id` CASCADE, `body`, `kind`, `position`, timestamps), deliberately last and
  deliberately conditional on *`N1` proving one field isn't enough*. `N1` has shipped, and it
  proves the opposite: **"one field" was never the ceiling**, so a second free-text mechanism
  would be a duplicate rather than a capability. The evidence, and the one genuine gap it leaves,
  are in §11.4. What remains — *several notes under the **same** label* — is exactly `W2`
  (repeating fields) in the archetypes audit, whose `UNIQUE` ceiling exists identically on both
  subjects; solve it once, for both.

## 9. Defects found while surveying

Not part of the ask — existing behaviour that looks wrong, found on the way. **Both are now filed
as [#689](https://github.com/BootBlock/Gubbins/issues/689) and
[#690](https://github.com/BootBlock/Gubbins/issues/690)**; those issues carry the full evidence and
are the live record, so treat this section as the summary of how they were found. **Both are now
fixed and closed** — #689 alongside `N1` (the panel is now titled *"Fields"*), and #690 separately
on 2026-07-31.

1. **A location's own detail lives under a heading that says it is for something else**
   ([#689](https://github.com/BootBlock/Gubbins/issues/689)). The
   custom-field panel in the Edit dialog is titled *"Inheritable fields"*
   ([en.json:615](../../src/features/i18n/catalogs/en.json#L615)), but a **non**-inheritable value is
   an explicitly supported and documented use: the checkbox hint says "When off, the value is kept
   as this location's own detail and is not offered to anything inside it" (`:623`); the component's
   own doc comment gives the examples ("a shelf's load rating, a room's humidity",
   [LocationFieldsEditor.tsx:16-23](../../src/features/inventory/components/LocationFieldsEditor.tsx#L16));
   and the wiki repeats the same note. So the panel is named after its *optional* behaviour rather
   than its content, and a user looking for where to record a fact about a place is told this isn't
   it. Both the heading and the wiki section titles — there are two pages carrying it — need to
   change together.
2. **Database Maintenance reports a photo count and a byte figure that don't measure the same
   thing** ([#690](https://github.com/BootBlock/Gubbins/issues/690)). The stats panel renders
   *"Photos: N · X on disk"*
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

## 11. What building `N1`/`N2`/`N6`/`N7` proved wrong (2026-07-31)

Recorded because the research above is otherwise a snapshot of `d4d8d385` and would keep reading as
live guidance. First the three `N1`/`N2` corrections, one of which changed the design — then §11.4,
which is not a correction but the verdict `N1` was built to make possible, §11.5, what building
`N6` corrected in turn, §11.6, what building `N7` settled about its neighbour
[#596](https://github.com/BootBlock/Gubbins/issues/596), and §11.7 — the second verdict, `N4` scoped
against [#466](https://github.com/BootBlock/Gubbins/issues/466) and refused.

1. **"Non-inheritable field values" was the wrong scope for the panel — it now shows them all.**
   §5's asymmetry argument is sound as far as it goes, but it misses that `LocationFieldsEditor`
   **seeds a newly-added value as inheritable** — deliberately, with a comment saying so
   ([:141](../../src/features/inventory/components/LocationFieldsEditor.tsx#L141)). A panel showing
   only the non-inheritable half would therefore be empty for anyone who took the default, and `N1`
   would have appeared to do nothing. The flag says "*also* offer this downward", not "this is not
   about the place": what it changes is who **else** reads the value, never whether the location
   does. So the panel — and the `N2` search — take every value the location holds. This is the same
   argument [#689](https://github.com/BootBlock/Gubbins/issues/689) makes about the heading, applied
   to the read surface.
2. **A location's *description* already had a surface; only the field half was missing.** §5.2 says
   "a location's own detail renders in exactly one place", but `LocationDescriptionCard` had been
   rendering the description above the item list since #108 — §3's own table says so. The accurate
   statement is narrower and is what shipped: the **field values** rendered nowhere outside the Edit
   dialog. That existing block became the detail panel rather than a new one being invented.
3. **`FlatNode` needed no new read for the description, and one bounded read for the values.**
   `useLocations()` returns `LocationWithCount`, which already carries `description`, so `N2`'s
   first half is pure threading. The field values did need a read, and it is deliberately **deferred
   until the user types** and excludes `IMAGE` values in SQL — the stored value there is a base64
   `data:` URL, so indexing it would ship megabytes into a haystack where it can only produce
   nonsense matches.

`N3` remained conditional on exactly the evidence `N1` was meant to produce, and that evidence is now
gathered — §11.4 records what it said.

### 11.4 `N3` reassessed against the evidence `N1` produced — the answer is "don't build it"

`N3` was written conditional on *"only if `N1` proves one field isn't enough"*. `N1` has shipped, so
that is now answerable from the schema and the shipped surface rather than from intuition. The
condition comes back **no**, and for a reason the original framing had wrong: the question was never
*how many free-text fields* a location gets.

**A location can already hold as many labelled notes as a user cares to name.** `field_defs` is a
global dictionary with one definition per name
([`UNIQUE INDEX … name COLLATE NOCASE`](../../src/db/migrations/v1-initial.ts#L670)), and a location
records one value per definition
([`location_field_values`, `UNIQUE (location_id, def_id)`](../../src/db/migrations/v1-initial.ts#L711)).
So *"Access instructions"*, *"Warnings"* and *"Maintenance notes"* are three `LONG_TEXT` definitions
and three separate, individually-labelled notes on the same place — plus `description` as the
unlabelled one. `LocationFieldsEditor` offers every definition the location hasn't used yet, and
since `N1` the detail panel renders each of them, wrapping rather than truncating precisely because
they may be long. A `location_notes` table would therefore be a **second** free-text mechanism
sitting beside a working one — the outcome `N3` itself warned was "strictly worse than one".

**The one real gap is repeats of the same label, and it is not location-shaped.** What the field
mechanism genuinely cannot do is hold *two values for one definition* — three entries all called
"Site visit", ordered, appended to over time. That ceiling is the `UNIQUE` above, and the identical
constraint exists on items as
[`UNIQUE (item_id, def_id)`](../../src/db/migrations/v1-initial.ts#L740). It is `W2` (repeating
fields) in the [archetypes audit](weak-item-archetypes_2026-07-31.md#4-candidate-work-items), which
named only the item constraint until this reassessment; its scope now carries the location one too,
exactly as `N5` folds into `W1`. **One change over two subjects, not a location-only table.**

So §5's diagnosis holds and is now complete: the mechanism was built, sufficient, and invisible.
`N1` and `N2` made it visible and findable, and nothing about a location's own text needs new schema.
The remaining location gaps are the other §8 entries — a document with ordering and labels (`N4`)
and a date that raises something (`N5`); the activity record
(`N6`/[#691](https://github.com/BootBlock/Gubbins/issues/691)) and the export (`N7`) are now built,
and §11.5 and §11.6 record what building each corrected.

### 11.5 What building `N6` proved wrong (2026-07-31)

`N6`'s §8 entry and [#691](https://github.com/BootBlock/Gubbins/issues/691) both framed the answer
as *"a sibling table shaped like `item_history`, same immutability trigger"*. The sibling table was
right — the fork is a judgement call, and Gubbins' narrow-typed-table-per-need precedent settles it
against relaxing `item_history.item_id`'s `NOT NULL`. Three details of the *shape* were not.

1. **The immutability trigger had to go, because the sync classification came out differently.**
   `item_history` is a bespoke **union-by-id** snapshot section, which is what lets it be strictly
   immutable — a merge only ever `INSERT OR IGNORE`s into it, so no `UPDATE` is ever attempted.
   `location_history` did not need that plumbing: it is an ordinary **LWW leaf** in `SYNC_TABLES`,
   like the project's other synced append-only logs (`revaluations`, `test_records`,
   `supplier_part_price_history`). Because the repository only appends, an id a peer already holds
   always presents an identical row, and `upsertWouldNoOp` (`reconcile.ts`) drops a byte-identical
   winner before a statement is even built — union-by-id in effect, with none of the bespoke
   snapshot, reconcile, clone, restore and backup code the ledger needs. What that leaves is the
   reason the trigger had to go, and it is broader than "a hostile peer": the upsert the merge
   *does* build is an **unconditional** `ON CONFLICT(id) DO UPDATE SET …` (`merge.ts`) — there is no
   `WHERE excluded.updated_at > updated_at` guard in the SQL, the LWW comparison having happened in
   JavaScript — and `restoreSnapshot` has no LWW gate at all. So any row that differs from the copy
   held locally fires a real UPDATE, and a trigger there would **ABORT the whole transaction**.
   Append-only is therefore enforced where it is written, not by a trigger.
2. **"Re-attribute rather than erase" applies to the *subject*, not only the actor — and neither
   of `item_history`'s two FK behaviours is the right one for it.** The issue read that ledger's
   deleted-*user* handling (`ON DELETE SET DEFAULT` → System) as the precedent to copy, and it was,
   verbatim, for `actor_user_id`. But its *subject* column is `ON DELETE CASCADE`: hard-deleting an
   item destroys its ledger, which would have made `location.removed` the one event whose own
   record is deleted in the same transaction that raises it. The obvious repair, `ON DELETE SET
   NULL`, is *also* wrong, and less obviously so — it keeps the row but blanks the id on **every**
   `DELETED` entry the instant it is written, so a subscriber could never be told *which* location
   went. So `location_id` carries **no foreign key at all**: a historical coordinate, the shape
   `stock_deltas.location_id` already takes, alongside the `location_name` snapshot. A deleted
   location's trail survives whole — id, name and all — in the ledger, in a backup and across a
   sync. The honest limitation that remains: the shipped History tab is opened *from* a location,
   so a deleted one's entries have no in-app reader; the deletion reaches a person through the
   `location.removed` event (which is what
   [#565](https://github.com/BootBlock/Gubbins/issues/565) needed) and through the ledger's durable
   copy. A cross-location activity view would close it; it is not this issue.
3. **A location write can legitimately not happen, which an item write never does.** A parent move
   rides an atomic cycle guard in the `UPDATE`'s `WHERE` (`PARENT_MOVE_CYCLE_GUARD`), so a
   concurrent re-parent can make the whole statement match zero rows *after* the pre-check passed.
   An unconditional `INSERT` beside it would then record a move that never happened — the one
   failure mode an audit trail must not have. Every entry an edit emits therefore carries the same
   guard, via `INSERT … SELECT … WHERE <guard>`; the vetoed edit records neither the move nor the
   rename that would have ridden the same statement.

One thing the §8 entry understated rather than got wrong: the `location.*` slice is **not** purely
additive on the bridge. `BridgeEventData` is item-shaped, so the event union gained a third arm, and
`events.truncated` became the one type that can arrive with either payload — which is why
`isLocationEvent` discriminates on `data.locationName` rather than on the dotted type name. Three
sibling surfaces had to move with it and are easy to miss: the OpenAPI `BridgeEvent.data` `oneOf`,
the synthetic **test event** (a location-only subscription must be test-fired with a location-shaped
payload, or the button greenlights a receiver that cannot read the real thing), and the per-ledger
fan-out cap — kept deliberately independent, because a shared budget would let a bulk item import
starve the location events entirely.

And one thing the *delete* path proved: the re-parent nobody asks for is the one most worth
recording. Deleting a location promotes its children to its parent, which is the exact
"why is this shelf suddenly under a different room?" the issue opens with — so each promoted child
records its own `RE_PARENTED` entry, mirroring the per-item `RE_PARENTED` the same method already
wrote for the items it re-homes.

### 11.6 What building `N7` settled (2026-07-31)

`N7`'s §8 entry called it "mechanical", and the three halves it named — the tabular seam, the JSON
payload, the vault's folder-level page — all landed as scoped. Four things it did not say.

1. **The export cannot read the list the sidebar is holding, even though that list is uncapped.**
   `useLocations()` reads `LocationRepository.listAll`, so unlike every other list export the
   sidebar genuinely *has* every row — the read-everything argument (§8's own constraint) looks
   satisfied for free. It isn't, for a different reason: the sidebar filters that list before it
   renders it — archived branches hidden, a tag chip or the search box narrowing the tree — so
   serialising what is on screen would quietly export the current view. The export therefore
   re-reads through the paged `list` via `exportEveryPage`, and the file deliberately carries
   **every** location including archived ones. That difference is stated in the wiki, because it
   is the one place the app's "the file matches what's in front of you" rule does not hold.
2. **A flat table loses the hierarchy, which is most of what a location *is*.** A row saying
   "Drawer 3" names nothing outside Gubbins. Each row therefore carries its immediate parent *and*
   its full path, resolved against the whole set — never the filtered subset, because a path that
   stopped at the first unexported ancestor would be wrong rather than short. The vault's folder
   notes take the identical row (`VaultLocation` ≡ `LocationExportRow`), so the orchestrator
   resolves ancestry once and feeds both.
3. **The vault's folders are keyed by a location's *name*, not its path** — a pre-existing fact
   that only becomes visible once a folder gains a note. Two "Cabinet A"s in different branches
   already share one vault folder, so the second one to claim `Folder/Folder.md` takes the same
   id-suffixed fallback a colliding item name takes, and each note's `path` frontmatter is what
   says which location it describes. Folder notes are written **before** the items so the folder
   note keeps the canonical name; an item that happens to share its location's name is the one
   that moves.
4. **It does *not* close [#596](https://github.com/BootBlock/Gubbins/issues/596), and shouldn't.**
   That issue is about the **catalogue CSV** writing a raw `locationId` UUID where a name would be
   readable and portable — and it is a *round-trip* format, so the column's contents are an import
   contract as much as an export one. Nothing here touches it: the location list export is a new,
   separate file, and the JSON payload gained a `locations` array rather than changing what an item
   row writes. #596 also carries two decisions this work had no reason to take — whether to write a
   bare name or a qualified path, and how the importer resolves an ambiguous one — plus a
   dependency on [#407](https://github.com/BootBlock/Gubbins/issues/407) for the category half of
   the same column. Closing it off the back of this would be claiming a fix that isn't there. What
   *has* changed is that the JSON export no longer has the same defect: an item's `locationId`
   resolves within the file.
5. **The shared export timestamp seam threw on a value it could not render, and now doesn't.**
   Locations are the first list export whose columns include two *optional* stored instants
   (`archived_at`, `last_counted_at`). `isoTimestamp` (`features/export/export-every-page.ts`) —
   the seam every list export writes its date columns through — called `toISOString` on anything
   non-null, which raises both on a `NaN` and on a perfectly finite number past the ±8.64e15 ms
   range `Date` can represent. One unreadable stored value would have failed the whole file rather
   than blanking its own cell, and the fix belongs in the seam rather than at this call site:
   hardening it once means the vault's folder note and the location list agree about what happens,
   and every other list export (loans, contacts, bookings, purchase orders, activity) stops sharing
   the defect too. That is the only change here that reaches past `N7`'s three parts.

### 11.7 `N4` scoped against #466 — the answer is "don't build it" (2026-07-31)

`N4`'s §8 entry required it to be *"scoped against
[#466](https://github.com/BootBlock/Gubbins/issues/466) before starting"*, and wrote its own case
honestly: a `URL` custom field *"already does most of this, so what a table buys is several of them,
ordered and labelled, not a new capability"*. Scoped, it fails on exactly that sentence. The parity
is better than it claimed, the residue is smaller than it claimed, and none of the residue is
location-shaped. **Don't build `location_attachments`.**

1. **A location does not have "most of" `item_attachments`. It has both of its kinds.**
   `item_attachments.kind` is `URL | LOCAL_POINTER`
   ([constants.ts:405](../../src/db/repositories/constants.ts#L405)) — an http(s) link, or a literal
   local path string that never travels. A location's field dictionary offers **both**: a `URL`
   value is validated as a parseable http(s) link
   ([custom-fields.ts:134-144](../../src/features/inventory/custom-fields.ts#L134-L144)), and a
   `FILE` value is defined as *"a local path, a UNC share (`\\server\share\…`), or a `file://` /
   `http(s)` URI… Only the string travels… the file itself is never copied"*
   ([constants.ts:318-321](../../src/db/repositories/constants.ts#L318-L321)). `FILE` is
   `LOCAL_POINTER` under another name, adopted for the same Strict-Sync-Isolation reason. So the
   boiler manual, the wiring diagram and the fire certificate are each recordable on a location
   today, each under its own name, in whichever of the two kinds fits — and since `N1`, each is
   rendered on the detail panel. The remaining difference between the two mechanisms is not *what
   can be stored*.

2. **What a dedicated table would genuinely add is three things, and each is a two-subject change
   already owned elsewhere.**
   - **Several under one label, ordered** — `position`, and repeats of the same name. This is the
     identical `UNIQUE (location_id, def_id)` ceiling §11.4 already ruled on, and `N4`'s own
     phrasing ("several of them, ordered and labelled") is almost word-for-word the sentence `N3`
     was refused for. `W2` in the [archetypes audit](weak-item-archetypes_2026-07-31.md), whose
     scope §11.4 already widened to both subjects.
   - **A link that can be opened.** A real gap, and the reason this reassessment is worth more than
     its verdict: `CardFieldValue`'s union has **no link arm at all** — `text`, `measure`, `money`,
     `condition`, `tags`, `image`, `empty` — and `customFieldValue`, shared verbatim by the item
     card and the location detail panel as its own doc comment says, falls a `URL` and a `FILE`
     value through to `{ kind: 'text' }`
     ([card-fields.ts:352-371](../../src/features/inventory/card-fields.ts#L352-L371)); the `text`
     case then only takes care that a long URL *wraps*
     ([ItemCardFields.tsx:77-89](../../src/features/inventory/components/ItemCardFields.tsx#L77-L89)).
     So on the panel `N1` shipped — whose doc comment offers *"a link to the boiler manual"* as its
     worked example — the boiler manual is **unclickable text**, exactly as it is on an item card,
     and no other surface renders one as a link either. That is `C1`'s "readable but never
     actionable" charge in miniature, it is one union arm plus one `switch` case, and it fixes both
     subjects at once. Filed as `W1f`.
   - **A foreign pointer that degrades honestly.** `item_attachments` stamps `origin_device_id` on
     the way in ([AttachmentRepository.ts:49-56](../../src/db/repositories/AttachmentRepository.ts#L49-L56)),
     resolves a pointer against the current device through a pure seam
     ([attachment-link.ts:41-52](../../src/features/inventory/attachment-link.ts#L41-L52)), and
     renders a foreign one as an *"Unlinked Local File"* placeholder offering **Re-link** or
     **Use URL**, never a fetch
     ([AttachmentManager.tsx:186-232](../../src/features/inventory/components/AttachmentManager.tsx#L186-L232)).
     A `FILE` field value carries no origin at all — neither `item_field_values` nor
     `location_field_values` has such a column — so a synced path is shown as a dead string with no
     explanation, on an item exactly as much as on a location. A `FILE`-field gap, not a
     missing-table gap; carried by `W1f` with the point above.

3. **#466 does not *subsume* `N4`, but it does make building it now premature.** #466 asks for
   *categorised* asset documentation — dedicated tabs for Manuals, Warranties, Receipts and
   Schematics — with the PDF **embedded** and readable on the device. It never mentions locations,
   so it cannot honestly be said to cover them, and the §8 entry was right to make this a scoping
   question rather than a duplicate check. But both of its halves land on `item_attachments`: the
   embedding half is storing a document's bytes, which is `W6` and a standing §7 non-goal here, and
   the categorising half is a new dimension on the table. Whichever way #466 lands, it restructures
   the very shape `N4` proposed to mirror — so building the mirror first buys a second table to
   carry through that restructure, in exchange for a capability the field dictionary already
   provides.

4. **The cost is the §7 checklist — smaller than that non-goal implies, and still the wrong
   trade.** §7 rejected a *polymorphic* child table partly on this list, so it is worth being exact
   about which of it a **narrow** table actually pays, measured against what `item_attachments`
   itself pays today. It genuinely costs: `SYNC_TABLES` classification, which the drift test forces
   ([tombstone.ts:83](../../src/db/repositories/tombstone.ts#L83)) and which brings snapshot,
   restore and merge with it rather than as extra work, since those all iterate `SYNC_TABLES`
   generically; a tombstone on delete; an `FK_REFS` entry
   ([fk-refs.ts:136](../../src/features/sync/fk-refs.ts#L136)); a repository, a manager component,
   `t()` in both catalogues and a wiki page; and the exports `N7` has just built. Three costs it
   does **not** pay, and the §8 entry would have been wrong to assume it did: there is no
   permission subject — `AttachmentRepository` asserts `items:write`, so a location table would
   assert `locations:write` and add nothing to the registry; there is no separate Danger-Zone
   target — `item_attachments` is one `tombstoneSelect` line inside the existing **All items**
   target ([erase-targets.ts:180](../../src/features/danger-zone/erase-targets.ts#L180)); and there
   is **no bridge surface at all**, because `item_attachments` has never had one. That last absence
   is the interesting one, and it cuts the other way from the rest: the bridge's own DTO comment
   describes custom fields as *"a supplier reference, a datasheet URL, the entity id of the lamp
   above a shelf — recorded against an item **or a location**"*
   ([dto.ts:84-92](../../bridge/src/api/dto.ts#L84-L92)). A location's datasheet URL already reaches
   Home Assistant *because* it is a field value; an item's actual attachment never has. Set the
   honest cost against the residue in point 2 — one union arm, one renderer case, one nullable
   column, over both subjects — and the table is still the expensive way to get less.

So `N4` is refused, for a reason adjacent to but not the same as `N3`'s. `N3` was refused because the
existing mechanism was already **sufficient**; `N4` is refused because the existing mechanism is
already **equivalent in kind**, and because what it is genuinely missing is missing on items too.
§7's rule stands unchanged and settles it: *add a table per thing, or add nothing* — and there is no
thing here that a table is the answer to.

That leaves `N5` (which belongs to `W1`) and the deferred `locations_fts` as the only open work in
this document. (Since written: `W1f`'s link half has shipped — a location's `URL`/`FILE` value is
now openable on the `N1` panel, from the shared seam — and its origin-attribution half was split
out there as `W1g`. See §4.4 of the [archetypes audit](weak-item-archetypes_2026-07-31.md).)
