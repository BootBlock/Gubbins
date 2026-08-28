# Inventory views

The same inventory can be shown in different ways depending on what you're doing — browsing the
pictures, scanning a dense list, or working spreadsheet-style. Gubbins offers five **view
densities**, plus grouping, sorting and a favourites filter.

**Where to find it:** the **More** menu on the Inventory screen → **View** (and **Group by** /
**Sort by**).

## The five densities

Each one draws the same items, matched to a different job. Nothing about your data changes when
you switch: the same items, in the same order, drawn a different way.

| View | Shows | Best for |
| --- | --- | --- |
| **Card** | A card per item: photo, status, fields and quick actions | Browsing with the details to hand |
| **Gallery** | A big picture per item, with the name and one line under it | Looking at a collection rather than reading it |
| **Data** | A dense two-line row per item | Working through a lot of items quickly |
| **Compact** | One text line per item: the name and one value | Fitting as many items on screen as possible |
| **Table** | A spreadsheet of columns | Comparing items field against field |

### Card

Rich cards with photos, status and quick actions — the most detail per item, best for browsing
when you want the numbers alongside the picture.

![The Card view](images/inventory-workspace.png)

### Gallery

A wall of pictures. Each item is a large image with its name and **one** field beneath it, and
nothing else — no card, no border, no buttons in the way. Several fit across a row, so a
photographed collection reads as the collection rather than as a list of records.

![The Gallery view](images/inventory-gallery.png)

Items you haven't photographed don't leave a hole: if the item's
[[category|Custom-Fields-and-Capabilities]] has a **glyph** (an emoji such as 🔋 or 📖), that glyph
fills the picture instead, so the wall stays readable. This happens whether or not you have
category watermarks switched on for cards — in Gallery the glyph *is* the picture, not a
decoration behind one.

> **💡 Tip**
> The line under each picture is the **first** of your chosen card fields that the item actually
> has a value for. So if you set **Category** first, Gallery captions each picture with its
> category — change the field order under **Settings → Inventory → Item cards** and the captions
> follow. See [Customising cards](#customising-cards) below.

### Data

A dense two-line row per item — the name, your chosen fields on the line beneath, the corner
badge and the stock value. More items on screen than Card, with the detail still there.

### Compact

The tightest view: **one line per item**, carrying the item's name and a single value, with no
photo and no row framing at all. Roughly twice as many items fit on screen as in Data. Reach for
it when you want to find a name in a long list rather than read anything about it.

![The Compact view](images/inventory-compact.png)

The value at the end of each line is chosen the same way as the Gallery caption — the first of
your card fields that this item has filled in.

### Table

A columned table — Name, Location, Category, Stock and more — for a spreadsheet-style overview
where you can compare rows at a glance.

![The Table view](images/inventory-table.png)

> **💡 Tip**
> Pick the density that matches the task: **Card** to browse, **Gallery** to look, **Data** to
> skim, **Compact** to find a name, **Table** to compare. It's a per-device preference, so your
> phone and desktop can differ.

> **ℹ️ Note**
> Every view works the same way under everything else on this page. Grouping, sorting, the search
> box, the status chips, the location tree and multi-select all apply whichever one you pick —
> including inside grouped location sections.

### With a screen reader

Every density announces itself as a structure you can navigate: the Card, Gallery, Data and
Compact views as a **list**, the Table view as a **table**. Because only the items near the
viewport are actually drawn, each one also announces where it sits in the whole result — "item 12
of 340" — so a long inventory reads as its true length rather than as the handful currently on
screen.

Every view also keeps each item's **More actions** menu, so edit, move, print a label and the
rest stay reachable from the keyboard in the plainest views exactly as they are on a card.

> **ℹ️ Note**
> Where Gubbins doesn't yet know the total — while the count is still being worked out, or inside
> a grouped location that has more items still to load — the position is still announced, but the
> total is reported as unknown rather than guessed at. With **Paginate long lists** turned on, the
> announced total is the page you are on, since the page control beneath the list is what tells you
> where that page sits in the whole result.

## Grouping

**Group by** clusters the list into sections — by location, category, or other axes — so a long
inventory breaks into meaningful chunks instead of one endless list.

## Sorting

**Sort by** sets the order the list is shown in. By default Gubbins leads with your favourites and
then runs alphabetically by name; pick any of these instead:

| Sort by | Useful for |
| --- | --- |
| **Name** | Straight alphabetical order. |
| **Quantity** | What you hold most — or least — of. |
| **Unit cost** | Your most and least expensive items. |
| **Manufacturer** | Keeping one brand's items together. |
| **MPN** | Working through a manufacturer's part numbers. |
| **Serial number** | Individually-tracked items in serial order. |
| **Date added** | What you've catalogued most recently. |
| **Last updated** | What you've touched most recently. |

Choosing a field applies the order that usually makes sense for it — names run **A → Z**, while
quantities, costs and dates start **largest** or **newest first**. Underneath the field list sit the
two directions, named for the field you picked (**A → Z** / **Z → A**, **Newest first** / **Oldest
first**), so you can flip it either way. Choose **Default** to go back to favourites-first.

**Where to find it:** the **More** menu → **Sort by**.

### Click a column to sort (Table view)

In the **Table** view you can sort straight from the header — click **Name**, **Stock**, or **Last
updated** to order by that column. An arrow marks the column you're sorted by and which way it's
running. Clicking the same column again reverses it, and a third click returns to the default
order, so you're never stuck in a sort you didn't want.

Columns that come from elsewhere — **Location**, **Category**, **Tags**, and your own custom
fields — aren't sortable and stay as plain labels.

> **💡 Tip**
> Sort by **Unit cost**, highest first, for a quick look at where the value in your inventory
> actually sits — or by **Last updated** to pick up wherever you left off.

> **ℹ️ Note**
> Sorting is a per-device preference and sticks between visits. Like the view density, it only
> changes the **order** items are shown in — never your data, and never which items match your
> current [[search|Search-Overview]], location and status filters. Your
> [[favourites|Saved-Searches-and-Favourites]] always lead the list, whichever sort you pick —
> the sort then orders everything below them.

## Pagination

By default a long list loads more items as you scroll (an endless list). If you'd rather step
through it in fixed **pages**, turn on **Paginate list** — a page control then appears at the foot
of the list with **Previous / Next**, numbered pages, and an editable **per-page** box where you
can pick a preset (10, 25, 50, 100) or type your own number.

![The pagination control at the foot of the list](images/inventory-pagination.png)

**Where to find it:** the **More** menu → **Paginate list**, or **Settings → Inventory → Lists**,
where you can also set the default **Items per page**. The per-page box on the control changes the
same shared setting, so whatever you pick sticks everywhere.

> **ℹ️ Note**
> Pagination is an app-wide preference — it applies to every list that offers it: the Inventory
> list, the [[Activity log|Activity-Log]] feed, and your [[Contacts|Contacts]],
> [[Projects|Projects-and-BOM]], [[Purchase orders|Purchase-Orders]],
> [[Suppliers|Suppliers]], [[Tags|Tags-Attachments-and-Related-Items]] and
> [[Wishlist|Wishlist]] screens alike. It only changes how a list is presented — never your data,
> and never which items match your current [[search|Search-Overview]] and filters. The page control
> only appears when there's more than one page to show, and it doesn't apply to the grouped view or
> the location map / value treemap.

## Fullscreen

Turn on **Fullscreen** to stretch Gubbins across your whole display, hiding the browser's own
toolbars and tabs for a distraction-free, data-dense view. Choose it again to return to the normal
windowed view — or just press **Escape**, which always leaves fullscreen.

**Where to find it:** the **More** menu → **Fullscreen**. A tick beside it shows when fullscreen is
active.

> **ℹ️ Note**
> Fullscreen is handled by your browser, so it's offered only where the browser supports it, and it
> applies to the whole app, not just the Inventory screen. It changes nothing about your data.

## Favourites filter

Pin the items you reach for most as **favourites** (the gold star on a card) and use the
favourites filter to show just them. See [[Saved searches & favourites|Saved-Searches-and-Favourites]].

## Status filters

Above the list sits a row of **status chips** — one-tap filters for the things that usually need
your attention. Choosing more than one widens the result rather than narrowing it: you see items
matching *any* chip you've selected, so **Low stock** + **On order** shows both, not just items
that are somehow both at once.

| Chip | Shows |
| --- | --- |
| **Low stock** | Items at or below their reorder point. |
| **Out of stock** | Items that have run down to zero on hand. |
| **On order** | Items with stock inbound on an open purchase order — ordered, but not yet arrived. |
| **Expiring** | Perishables past or nearing their expiry date. |
| **Warranty** | Assets whose warranty has expired or expires soon. |
| **On loan** | Items currently checked out to a contact. |
| **Overdue** | Items checked out and past their due date. |
| **Maintenance due** | Items with a service or calibration now due. |

Each chip carries a count of how many items it would show, and chips that currently match nothing
are hidden — so the row only ever offers filters that would actually do something. Chips are
additive to whatever location and search you already have applied.

> **💡 Tip**
> **Low stock** and **On order** answer the same question from opposite sides: what's running out,
> and what's already on its way. An item that's low *and* already ordered still appears under Low
> stock — the alert tracks what's on the shelf, not what's in the post — so pairing the two chips
> is a quick way to separate "still needs ordering" from "already handled".

> **ℹ️ Note**
> A chip only appears when the feature behind it is switched on. **On order** needs
> [[Purchase orders|Purchase-Orders]]; Expiring, Warranty, On loan and Maintenance due each need
> their own module. See [[Modular UI|Modular-UI]].

## Customising cards

Card view itself is configurable — which fields show, count pills, and more — under
**Settings → Dashboard / Inventory**. See [[Appearance & theming|Appearance-and-Theming]] and
[[Dashboard & widgets|Dashboard-and-Widgets]].

### The card detail (Card view)

In **Card** view, each item card has one large **detail** slot. The ± stepper already shows the
on-hand quantity, so this slot shows a genuinely useful *second* signal instead of repeating the
number. Point it at whichever matters most to you:

- **Stock health** — a colour-coded reorder status (In stock / Low / Out), from the item's reorder
  point (the default).
- **Total value** — unit cost × quantity.
- **Last updated** — how long ago the item changed.
- **Condition** — its tracked state (Mint / Good / …).
- **Manufacturer** — the item's maker / brand.

Pick a **fallback** too. If the chosen detail has nothing to show for a particular item — say
you've set **Manufacturer** but an item has no maker recorded — the fallback is shown for that one
item instead. So **Manufacturer** with a **Stock health** fallback shows the maker where you've
entered one and the reorder status everywhere else. Leave the fallback on **None** to keep a plain
dash for those items.

**Where to find it:** **Settings → Inventory → Item cards → Visual card details** (and **Detail
fallback**). It's a per-device preference. Gauge, serialised and untracked cards are unaffected —
their detail already shows something meaningful.

> **ℹ️ Note**
> When an item has a **manufacturer** recorded, it's also shown as a small subtitle directly under
> the item's name on its card — a quick brand cue, independent of the detail slot above.

### The corner badge

Every item card and row shows a small **badge in its top-right corner** — by default the item's
[[tracking mode|Tracking-Modes]] (Bulk / Serialised / Consumable / Untracked). You can point that
slot at something else instead:

- **Tracking mode** — the tracking pill (the default).
- **Unit price** — the cost of a single unit.
- **Total value** — unit cost × quantity.
- **Condition** — its tracked state (Mint / Good / …).
- **Nothing** — leave the corner empty.

Pick a **fallback** too. If the chosen badge has nothing to show for a particular item — say
you've set **Unit price** but an item has no price — the fallback is shown for that one item
instead. So "Unit price" with a "Tracking mode" fallback shows the price where you've entered one
and the tracking pill everywhere else.

**Where to find it:** **Settings → Inventory → Item cards → Item card badge** (and **Badge
fallback**). It's a per-device preference and applies to both the Card and Data views.

> **💡 Tip**
> Set the badge to **Total value** with a **Nothing** fallback to see stock value at a glance while
> browsing, without cluttering cards for items you haven't priced yet.

> **ℹ️ Note**
> The view density only changes how items are **drawn** — it never changes your data or which
> items match your current [[search|Search-Overview]], location and status filters.

### Category watermarks

If an item's [[category|Custom-Fields-and-Capabilities]] has a **glyph** (an emoji such as 🔋 or
📖), its Visual card shows that glyph as a large, faint greyscale watermark in the bottom-right
corner — a quick cue for what kind of thing each card is. Set a category's glyph from
**Categories & schemas**, and turn all watermarks on or off under **Settings → Inventory → Item
cards → Category watermarks** (on by default; the Data, Compact and Table views never show it).
The **Gallery** view uses the same glyph, but as a stand-in for a missing photo rather than as a
watermark — so it appears there whether the setting is on or off.

## Related pages

- **[[Search overview|Search-Overview]]** — narrowing which items are shown.
- **[[Locations & stock|Locations-and-Stock]]** — the tree that filters the list.
- **[[Bulk edit & clone|Bulk-Edit-and-Clone]]** — acting on many items at once.
