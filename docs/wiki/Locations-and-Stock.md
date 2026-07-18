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
