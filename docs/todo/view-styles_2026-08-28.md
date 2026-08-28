# Additional inventory View styles — grounding research (2026-08-28)

> **Status:** 🟢 ACTIVE — research complete, nothing implemented. `V1`–`V4` are the recommended
> shortlist; `V5`–`V8` are held; §7 records what was rejected and why.

Answers issue [#444](https://github.com/BootBlock/Gubbins/issues/444): *what other visual styles do
people want when they browse an inventory or a collection, and which of them should Gubbins add?*

**What this document is not.** No user was interviewed and no telemetry exists, so nothing here is
evidence of what *Gubbins'* users want. It is desk research: the view types comparable products ship
and document publicly, plus a keyword sample of one comparator's issue tracker, read against the
data Gubbins actually holds. Every claim about the codebase was checked by search against `main` at
`9e317b18`; every claim about another product is sourced in §3.

---

## 1. Where the View axis stands today

The **View** axis is the inventory grid's "how is this drawn" control, orthogonal to grouping
(how the list is arranged) and sorting (how it is ordered). Five modes exist, listed in
[`view-modes.ts`](../../src/features/inventory/view-modes.ts):

| Mode | Key | Draws |
| --- | --- | --- |
| Card | `visual` | One card per item, photo-led |
| Data | `data` | One dense row per item |
| Table | `table` | A spreadsheet grid of columns |
| Location map | `map` | The whole collection, spatially |
| Value treemap | `treemap` | The whole collection, by value |

Two shapes, not one. The first three are **per-item** renderers driven by the virtualised
[`ItemList`](../../src/features/inventory/components/ItemList.tsx) / `GroupedItemList`, and the type
system enforces that: `ItemDensity` is `Exclude<LayoutDensity, 'map' | 'treemap'>`
([`useLayoutStore.ts:52-60`](../../src/state/stores/useLayoutStore.ts#L52-L60)). The last two are
**whole-collection visualisations**, intercepted before the list and rendered by their own
components ([`InventoryScreen.tsx:1365-1380`](../../src/features/inventory/InventoryScreen.tsx#L1365-L1380)),
with pagination and the item-count control hidden.

That split is the single most useful fact for costing anything below. A new **per-item** view is a
new row renderer plus a row-height entry — small, and it inherits virtualisation, selection,
grouping, sorting, filtering and the URL state for free. A new **whole-collection** view is a new
screen-sized component that must fetch its own set, and inherits none of that.

## 2. What Gubbins can key a view on

A view style is only as good as the axis it draws. These exist today:

- **A photo.** `item_images` holds a `thumbnail_blob` plus a full-resolution OPFS path, ordered by
  `position` ([`v1-initial.ts:1143-1152`](../../src/db/migrations/v1-initial.ts#L1143-L1152)) — so a
  first image per item is cheap, and a large one is available on demand.
- **A place.** `location_id` is `NOT NULL` on every item, and the location tree is already
  hierarchical, coloured and drawn spatially by the Location map.
- **A category and tags.** Both optional, both already faceted in the filter bar.
- **A status.** Eight of them — `low-stock`, `out-of-stock`, `on-order`, `expiring`, `warranty`,
  `on-loan`, `overdue`, `maintenance-due`
  ([`status-filter.ts:49-60`](../../src/db/repositories/item/status-filter.ts#L49-L60)).
- **Dates.** `acquired_at`, `warranty_expires_at`, `expiry_date` on the item, plus lot expiry on
  `stock_batches`, maintenance schedules, checkouts and bookings. The
  [agenda seam](../../src/features/calendar/agenda.ts) already folds the forward-looking ones into
  a single chronological feed. `acquired_at` is a past date, so it has no lane there.
- **A value.** `purchase_price`, `cost_per_unit_of_measure`, and the valuation seam the treemap
  already consumes.
- **A quantity and a fill level.** `quantity`, and the four gauge scalars for a consumable.

What does **not** exist, and would have to be built first for the views that need it: a
**workflow status a user can set** (the eight statuses above are all *derived*, so nothing can be
dragged between them), an item-to-item **ordering** a user controls, and any **repeating** custom
field ([weak-item-archetypes §2](weak-item-archetypes_2026-07-31.md)).

## 3. What comparable products ship

Two families, and they want different things.

**Database and workspace tools** converge on nearly one list. Airtable's own docs name grid, form,
calendar, gallery, kanban, timeline, list and gantt
([Airtable](https://support.airtable.com/docs/getting-started-with-airtable-views)). Notion's name
table, board, timeline, calendar, list, gallery and chart
([Notion](https://www.notion.com/help/views-filters-and-sorts)). Six types appear on both lists —
grid/table, list, gallery, calendar, timeline and kanban/board — and that is about as close to a
consensus vocabulary as this space has.

Gubbins holds two of those six on the View axis: Table, and Data as a denser list. Calendar exists,
but as a [separate screen](../../src/features/calendar/CalendarScreen.tsx) rather than a way of
looking at the inventory. Gallery, timeline and board are absent entirely.

**Collector and home-inventory tools** are built around a different idea: the collection should
*look like* the collection. CLZ sells cover art as the point of the app, and its release notes
record adding cover thumbnails to the plain list view ([CLZ](https://clz.com/)). Delicious Library's
whole identity was a wooden shelf with the spines out, and that is still what it is remembered for
two decades on ([The Big Bookcase](https://www.bigbookcase.com/articles/delicious-library)).

The gap between the two families is the finding: Gubbins' existing five modes are all
**workspace-family** views. Nothing in it is built to make a collection look good, and that is the
half a collector judges an app on.

**What users actually ask for — a small negative result.** The two paragraphs above are product
documents, so they show what each vendor *built*, not what anyone *requested*. The nearest thing to
a demand sample available is the public issue tracker of the closest open-source comparator,
[Homebox](https://github.com/sysadminsmedia/homebox/issues). Searching it for *gallery view*, *card
view*, *grid view*, *view mode*, *kanban*, *photo wall* and *compact* returns **no request for a new
view type at all**. What it does return is
[#209, customising which columns the table view shows](https://github.com/sysadminsmedia/homebox/issues/209),
and a cluster about sort order not surviving a refresh and about thumbnails.

Two things follow. First, nobody is asking for view styles *by name*, so §4's ordering rests on
inference rather than on demand — say so, and do not dress it up. Second, and more useful: the
requests that *do* exist are for **configurability within a mode**, and Gubbins has already built
that. The card-field picker (backlog E1, [`card-fields.ts`](../../src/features/inventory/card-fields.ts))
chooses and orders the attributes a card shows, and the Table view's middle columns are that same
picker's output ([`ItemTable.tsx:32-34`](../../src/features/inventory/components/ItemTable.tsx#L32-L34)).
So the one thing the comparator's users demonstrably want is a thing Gubbins already does — which
is a reason to trust that the remaining gap really is a missing *style*, and not a reason to spend
on configurability first.

A keyword search of one tracker is thin evidence. Treat it as a prompt to look harder, not as a
settled answer.

## 4. The recommended shortlist

Ordered by value per unit of work. All four are per-item renderers, so all four inherit the list
plumbing from §1 — virtualisation, selection, grouping, sorting, filtering, URL state. That bounds
what each one costs; it does not make each one small. V1 and V2 are small. V3 and V4 each need a
question answered before they can be scheduled, and §8 says which.

### V1 — Gallery

A photo-first grid with the metadata reduced to a caption: image, name, and one configurable line.
Bigger images than Card, several to a row, no chrome between them.

*Why.* Gallery is one of the six types both workspace tools name, and Gubbins has no equivalent.
Card is a card with a photo *in* it, which is not the same thing as a wall of photos. It is also the
cheapest way to close the §3 gap, because a photo-led grid is what the collector family is built
around.

*Data.* `item_images.thumbnail_blob`, already loaded for Card. Nothing new.

*Cost.* A renderer, a row-height entry, an icon, two catalog keys. It needs one decision the other
views do not: what an item with **no** photo looks like, because a gallery of placeholders is worse
than a list. The category glyph watermark
([`CategoryGlyphWatermark.tsx`](../../src/features/inventory/components/CategoryGlyphWatermark.tsx))
is the obvious fallback.

### V2 — Compact list

One line per item, no photo, no card: the name and the key field. Denser than Data.

*Why.* It is the other half of the same axis, and the cheap one. Data is dense *for a row with a
thumbnail*; a user scanning 4,000 fasteners wants neither the thumbnail nor the row height it
forces. Both workspace tools name a "list" type separate from their table, and Notion
describes its own as a minimal layout.

*Data.* None beyond what a row already reads.

*Cost.* The smallest change on this page. It is close enough to Data that the two should be
specified together, so they do not converge into the same thing.

### V3 — Shelf

Items drawn as spines or boxes standing side by side inside their location, sized by the item rather
than by the grid. The location is the shelf, and the items sit on it.

*Why.* It is the one candidate here that no comparable product ships, and the only one that would
make Gubbins look unlike a spreadsheet. It fits Gubbins specifically, because Gubbins already knows
the location tree and already draws it spatially — a shelf view is the Location map's data at
reading scale, not a new dataset. The precedent is Delicious Library (§3), not a filed request:
nobody has asked for this, so it is a bet on the collector half rather than a response to demand.

*Data.* `location_id` plus the first image. Optionally `quantity`, for the width of a stack.

*Cost.* Higher than V1 and V2, and the honest risk on this list. It is per-item, but it is grouped
by construction, so it either forces `grouping=location` or has to define what it means without one.
Prototype it before committing to it.

### V4 — Board

Columns of cards, grouped by a chosen axis — category, tag, location or status — with a count per
column.

*Why.* It is on both workspace lists, and it answers a real inventory question the current views
answer badly: *what is the shape of the pile?* Sixty items across four categories is legible as four
columns and illegible as a list.

*Data.* Category, tag, location and status all exist, and all four are already faceted.

*Cost.* Moderate, with one caveat that must be stated up front: **the columns are read-only.** Every
axis Gubbins could group by is either a derived status or a field with its own editor, so dragging a
card between columns is not a free consequence of drawing the board. A board that looks draggable
and is not is worse than one that plainly is not, so the first version must not imply it.

## 5. Held, not rejected

- **V5 — Timeline.** Items on a horizontal date axis. Every date it needs exists, but the
  [Calendar screen](../../src/features/calendar/CalendarScreen.tsx) already answers "what is coming
  up" from the agenda seam. Revisit only if a *per-item* time question turns up that Calendar
  answers badly.
- **V6 — Comparison.** Two to four items side by side, field against field. Wanted whenever a
  collection holds near-duplicates. It is arguably a selection action rather than a view mode, which
  is why it is held rather than shortlisted.
- **V7 — Fill wall.** Every gauge item as a bar, sorted by how empty it is. Narrow, because it
  serves one tracking mode, but it serves that mode better than anything currently does.
- **V8 — Label sheet.** The inventory laid out as it would print. The
  [labels](../../src/features/inventory/labels) and
  [Catalogue](../../src/features/reports/CatalogueScreen.tsx) surfaces already cover most of this.
  The open question is only whether the *browsing* screen should preview it.

## 6. What any new mode costs beyond its renderer

Adding a mode is not only the drawing. Each one needs, in the same change:

1. A `LAYOUT_DENSITIES` entry ([`useLayoutStore.ts:35`](../../src/state/stores/useLayoutStore.ts#L35)),
   and — if it is per-item — a `LIST_ROW_HEIGHT` entry
   ([`list-window.ts:25`](../../src/features/inventory/list-window.ts#L25)). The row-height object
   is indexed by `ItemDensity`, so `tsc` rejects a new per-item mode until the entry is added.
   A multi-column mode also needs a branch in `useColumns`
   ([`ItemList.tsx:358`](../../src/features/inventory/components/ItemList.tsx#L358)), which today
   packs more than one item per virtual row for `visual` only.
2. A descriptor in [`view-modes.ts`](../../src/features/inventory/view-modes.ts) with an icon and a
   `labelKey`, plus that key in `en.json` **and** `de.json`. The catalog-drift test holds the
   English `label` byte-identical to `en.json`, so the two cannot drift silently.
3. A `normaliseDensity` path, because a persisted value from an older release must still land
   somewhere.
4. Wiki coverage. The View control is user-facing, so [`docs/wiki`](../wiki) must describe any mode
   that ships, with a regenerated screenshot.

## 7. Rejected

- **Chart view.** [Reports](../../src/features/reports) is where analysis lives. A chart *of* the
  inventory is not a way of *browsing* the inventory, and putting one on the View axis would blur a
  boundary that is currently clean.
- **Form view.** Airtable ships one because it collects other people's submissions. Gubbins has a
  create dialog and an import path, so a form view would serve nobody.
- **Feed view.** [Activity](../../src/features/activity) already is one.
- **A second map.** The Location map exists. A geographic map would need coordinates the schema does
  not hold, to answer a question — "where in the world is this?" — that no filed issue asks.

## 8. Suggested next step

Take V1 and V2 together as one change. They share the renderer plumbing, they are the two cheapest,
and shipping them at once forces the Card / Gallery / Data / Compact boundaries to be drawn
deliberately rather than one at a time. V3 wants a throwaway prototype before it is scheduled. V4
wants its read-only columns settled as a design decision before any code is written.

Nothing here is urgent. §3's negative result says no comparable tool's users are asking for a new
view type, and the one thing they *are* asking for is already built here. So this is a quality bet
on the collector half of the audience rather than a gap anyone has reported — which is the right
framing for scheduling it, and the reason V1 and V2 lead: they are the two that cost least if the
bet is wrong.
