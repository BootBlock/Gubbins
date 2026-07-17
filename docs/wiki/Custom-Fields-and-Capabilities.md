# Custom fields & capabilities

Gubbins' built-in fields cover the basics, but every collection has its own attributes. **Custom
fields** and **capabilities** let you record — and search on — exactly the properties that matter
to *your* inventory.

**Where to find it:** the **Classification** tab of an item's details, once the **Custom fields &
capabilities** capability is enabled ([[Modular UI|Modular-UI]]).

## Custom fields

A **custom field** adds your own labelled value to an item — `Voltage`, `Material`, `Location
code`, `Author`, whatever your domain needs. Custom fields are typically defined per
**category**, so every item in that category shares the same set.

You can [[search|Text-Query-Syntax]] on them with the `field:` prefix:

```
field:material=steel
```

> **💡 Tip**
> Because custom fields hang off a **category**, setting a category up once gives every item in
> it the right fields automatically — no need to re-add them item by item.

### Adding a field note

When you define a custom field you can give it an optional **Description** — a short note about
what the field is for. If you fill it in, an **(i)** info badge appears next to that field on
every item in the category; hovering or focusing it shows your note. It's the ideal place for a
reminder such as *where to read the value from*, *which units to use*, or a link to a reference.
The note supports Markdown, and leaving it blank simply hides the badge.

### Starting from a preset

Rather than adding fields one at a time, the category manager's **Add from a preset** picker
creates a ready-made category with a curated set of custom fields already attached — covering
maker and hobbyist staples like `Battery`, `Cable`, `Electronic component`, `Fastener`,
`3D Filament`, `Fabric`, `Paint`, `Adhesive` and `Model kit`, plus collector staples like
`Book`, `Trading card`, `Vinyl record` and `Coin`. Pick one, then rename, extend or trim its
fields to match your own inventory.

The picker is organised for browsing: sections down the left-hand side — **Workshop**,
**Electronics**, **Household**, **Crafts & hobbies**, **Media** and **Collectibles**, plus
**All presets** for the whole library at once — and, on the right, the presets of the chosen
section. Each preset shows its name, a one-line description and a sample of the custom fields
it creates, so you can see what you're getting before you add it.

A **search box** above the sections filters the library as you type, matching preset names,
descriptions and field names alike — so `isbn` finds the `Book` preset and `expiry` finds
`Food` and `Adhesive`. While you're searching, each section shows how many of its presets
match. Press the **✕** button — or **Escape** while typing in the search box — to clear the
search; pressing **Escape** anywhere else (or with the search box empty) closes the picker.

> **ℹ️ Note**
> A preset whose category already exists is marked **Added** and can't be imported twice, so
> there's no risk of duplicates.

## Capabilities

A **capability** is a *weighted* attribute — a property an item **has**, optionally with a
numeric value. Think `waterproof`, `voltage = 3.3`, `torque = 40`. Capabilities power Gubbins'
smartest searches:

- **Presence** — "items that are `waterproof`" (`cap:waterproof`).
- **Comparison** — "items with `voltage` over 3.3" (`cap:voltage>3.3`).
- **Best-match ranking** — when several items match, the ones whose capability is a *better* fit
  rank first, so the closest match rises to the top.

> **💡 Tip**
> Capabilities are ideal for *"find me something that can do X"* searches — the part with enough
> current rating, the tool with the right reach. Give the capability a value and let ranking
> surface the best option.

## Custom fields vs capabilities

> **ℹ️ Note**
> - A **custom field** records a fact *about* an item you want to store and display
>   (`Material = steel`).
> - A **capability** describes what an item *can do* and is built for ranked, comparative search
>   (`voltage ≥ 3.3`).
>
> Many items need only one or the other; use whichever matches how you'll look things up.

## Related pages

- **[[Search overview|Search-Overview]]** and **[[Text query syntax|Text-Query-Syntax]]** —
  searching on fields and capabilities.
- **[[Items]]** — categories and the rest of an item's data.
- **[[Tags, attachments & related items|Tags-Attachments-and-Related-Items]]** — the other
  Classification-tab tools.
