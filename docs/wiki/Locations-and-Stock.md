# Locations & stock

**Locations** are where your items live, and **stock** is how many you have in each one.
Together they answer the two questions Gubbins exists to answer: *what have I got?* and
*where is it?*

**Where to find it:** the location tree down the side of the **Inventory** screen.

## The location tree

Locations are **hierarchical** — a location can sit inside another, as deep as you like:

> Garage → Shelf A → Bin 3

![The location tree, with a nested location and colour swatches](images/locations-tree.png)

Each location can have:

- **A name** — a room, shelf, drawer, box, or anywhere else things live.
- **A colour** — a swatch that tints the location and the cards of items stored in it, so the
  grid reads at a glance.
- **A description** — free notes about the location (what it holds, how to get to it, a link).
  It shows as a tooltip when you hover the location in the tree, and — when that location is
  selected — as a panel above the item list.
- **A parent** — the location it sits inside.

Selecting a location **filters** the inventory to what it holds, including everything nested
beneath it, and shows the location's description (if it has one) above the items. Select
**All items** to clear the filter.

## Finding a location

Above the tree is a **search box**. Type into it and the tree narrows to the locations that
match, with the branches leading down to them opened for you — so you can jump straight to a
deeply nested bin without expanding anything by hand.

Search matches the **whole path**, not just the location's own name, and every word you type has
to appear somewhere on it. So `garage bin` finds *Garage → Shelf A → Bin 3*, and typing just
`garage` narrows the tree to the Garage and everything inside it.

Clear the box (with the **✕**, or by pressing `Escape` while typing in it) and the tree comes
back exactly as you left it — searching never changes which branches you had open.

> **💡 Tip**
> Search combines with the **tag filter** below it: pick a tag *and* type a name to narrow by
> both at once.

> **ℹ️ Note**
> Very large location trees are drawn a screenful at a time as you scroll, so the sidebar stays
> quick no matter how many locations you have. Search and the keyboard still reach every one of
> them.

## Photos of a location

A location can also carry **photos**, with named regions drawn on them, so an item can point at
exactly where on a shelf it sits. See [[Location photos & regions|Location-Photos-and-Regions]].

> **💡 Tip**
> Descriptions support **Markdown** — headings, **bold**, lists, tables, and links all render,
> in both the hover tooltip and the panel above the item list. Handy for access notes or a link
> to a supplier.

> **💡 Tip**
> The tree is fully keyboard-navigable: arrow keys move between locations, Left/Right collapse
> and expand, and Enter selects. Great for quick filtering without reaching for the mouse.

> **💡 Tip**
> You can **drag an item card onto a location** to move its stock there — a fast way to tidy up
> after a reorganise. On a touchscreen, **press and hold** the card briefly until it lifts, then
> drag it onto the location; a quick swipe still scrolls the list as usual.

## Stock is tracked per location

The key idea: Gubbins tracks quantity **separately in each location**. If you have 200 screws
on *Shelf A* and 50 in the *Kitchen*, that's one item with a total on-hand of 250 — but the app
remembers the 200/50 split. Adjust the count where the stock physically is, and the item's
total keeps itself correct automatically.

> **ℹ️ Note**
> An item's total quantity is always the sum of its per-location stock — you never edit the
> total directly, you edit stock *somewhere*.

## Transfers

A **transfer** moves quantity from one location to another. The total on-hand doesn't change —
the stock just now lives somewhere else. This is how you record moving a batch of parts from
receiving to a shelf, or loading tools into a van.

## Passing values down to the items inside

A location can hold **custom field values** of its own, and offer them to everything stored
inside it. If a whole cabinet holds Ryobi tools, set `Manufacturer = Ryobi` once on the cabinet
instead of typing it onto every item.

Open the location's **Edit** dialog and find **Inheritable fields**:

1. Pick a field from the list (fields are defined under **Categories & schemas** — see
   [[Custom fields & capabilities|Custom-Fields-and-Capabilities]]).
2. Give it a value.
3. Tick **Offer to items here**.

![The Inheritable fields panel in a location's Edit dialog: a Storage conditions field set to "Dry, unheated", with "Offer to items here" ticked](images/location-inheritable-fields.png)

Items in that location — and in any location nested inside it — can then choose **Inherit** for
that field instead of entering their own value. It's opt-in per item, and the value stays live:
change it on the location and every item inheriting it updates straight away.

Nested locations override their parents, so a value on `Cabinet A` beats the one on the
`Workshop` above it.

> **ℹ️ Note**
> Setting a value and *offering* it are separate steps. Leave **Offer to items here** unticked
> to keep a value as the location's own detail — a shelf's load rating, say — without the items
> inside picking it up.

The full behaviour, including what happens when you withdraw an offer, is covered in
[[Custom fields & capabilities|Custom-Fields-and-Capabilities]].

## Capacity & fullness

A location can be given a **capacity**, after which Gubbins shows a fullness gauge — handy for
knowing when a shelf or bin is running out of room before you over-fill it.

## Dimensions & space

Alongside a count-based capacity, a location can record its **internal size** — the usable
width, height and depth inside it. Enter all three when you add or edit a location and Gubbins
works out the **volume** for you, shown right below the fields.

![The Dimensions fields on a location's Edit dialog — width, height and depth in millimetres with a derived volume of about 30 litres shown underneath](images/location-dimensions.png)

Sizes are entered and shown in your chosen **dimension unit** (change it in **Settings →
Measurements**), and the volume in your **volume unit** — left on **Automatic**, that picks a
readable scale for you, so a drawer reads in litres and a whole storage bay in cubic metres.
Measurements are optional: leave them blank for anything you don't measure, and the location
behaves exactly as before.

> **ℹ️ Note**
> The width, height and depth are the **inside** of the container — the space you can actually
> fill — not its outside footprint. Measuring the interior is what makes the volume honest.

> **💡 Tip**
> The unit is only how the size is *shown* — the measurement itself is stored independently, so
> switching between millimetres, inches or metres in **Settings** simply re-displays the same
> size. Nothing is converted or lost.

## Statistics for a location

Every location's **Edit** dialog has a **Statistics** tab that adds up what's stored there, so
you can see a location's worth and contents at a glance without opening the full reports:

- **Total value** — the combined value of all the stock physically held here, in your base
  currency. It uses the same valuation as [[Valuation & spend|Valuation-and-Spend]] (an item's
  manual current value, else its cost, else its preferred supplier's price), so a location's figure
  here always matches its row on that report's *value by location* breakdown.
- **Items** — how many distinct items have stock here.
- **Units** — the total on-hand quantity across those items.
- **Value by category** — where that value sits, broken down by category, largest first.

![The Statistics tab of a location's Edit dialog: Total value, Items and Units tiles above a value-by-category breakdown](images/location-statistics.png)

If the location has sub-locations, a **This location / With sub-locations** switch lets you roll
the figures up its whole subtree — so *Garage* can show the value of everything on every shelf and
in every drawer beneath it, not just what sits loose in the garage itself.

> **ℹ️ Note**
> An item with no value set is still counted under **Items** and **Units**, but adds nothing to
> **Total value** — a line beneath the tiles tells you how many items that affects, so a total is
> never quietly short without saying so.

## Watching a location for dead stock

A location can be set to report everything stored in it as **dead stock** once it goes unused —
so you can keep an eye on a whole cupboard without visiting each item. Set **Dead-stock
reporting** to *Report* when editing the location, and it applies to its sub-locations too.

You can also give the location its own **idle threshold** — how long is "too long" here —
overriding the global default for everything inside it. Handy when one place keeps different
time to the rest: deep storage might only be worth flagging after a year.

Any individual item can override what its location decided. See
[[ABC, turnover & aging|ABC-Turnover-and-Aging]] for the full picture.

## Portable & mobile containers

Not everything that holds items stays put. A **toolbox**, a **camera bag**, a **first-aid kit**
or a **van** all travel around — and Gubbins handles them without any special "mobile" setting.
The trick is that a location tracks *what is inside it*, not where it sits on a map, so a
portable container is simply a **location** like any other:

1. Make the container a location — nest it wherever it normally lives (e.g. *Garage → Camera bag*).
2. Give it a matching **type** so it reads at a glance: **Box**, **Bag** or **Vehicle** all carry
   their own icon.
3. Store the items inside it, just as you would on a shelf.

Because Gubbins records containment rather than a physical position, **picking the bag up and
carrying it out of the door changes nothing** — its contents are still "in the bag". If you want
to record that the whole container has moved home for good, drag it to a new parent in the tree;
if you're lending it out with its contents, a [[loan|Loans-Check-Out-and-In]] can be made out to
the container's location.

> **💡 Tip**
> A container is a great place to use **capacity** (below) — a first-aid kit or grab-bag with a
> set number of slots shows its fullness gauge, so you can see at a glance whether it's fully
> stocked before you head out.

## Going deeper: batches

Beneath each location, stock can be split further into [[batches & lots|Batches-and-Lots]] —
useful when different deliveries have different **expiry dates**, so Gubbins can consume the
oldest first.

## Related pages

- **[[Core concepts|Core-Concepts]]** — how items, stock and locations relate.
- **[[Batches & lots|Batches-and-Lots]]** — expiry tracking and first-expiry-first-out.
- **[[Cycle counts & audit day|Cycle-Counts-and-Audit-Day]]** — checking that on-hand counts
  match reality, location by location.
- **[[ABC, turnover & aging|ABC-Turnover-and-Aging]]** — dead-stock reporting, and how a
  location's setting passes down to the items inside it.
