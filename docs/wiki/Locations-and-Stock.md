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

## Capacity & fullness

A location can be given a **capacity**, after which Gubbins shows a fullness gauge — handy for
knowing when a shelf or bin is running out of room before you over-fill it.

## Going deeper: batches

Beneath each location, stock can be split further into [[batches & lots|Batches-and-Lots]] —
useful when different deliveries have different **expiry dates**, so Gubbins can consume the
oldest first.

## Related pages

- **[[Core concepts|Core-Concepts]]** — how items, stock and locations relate.
- **[[Batches & lots|Batches-and-Lots]]** — expiry tracking and first-expiry-first-out.
- **[[Cycle counts & audit day|Cycle-Counts-and-Audit-Day]]** — checking that on-hand counts
  match reality, location by location.
