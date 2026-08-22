# Current value & revaluation

Not everything loses value. Collectibles, quality tools, instruments and property can **hold or
gain** worth over time — and an insurance replacement figure needs *today's* value, not a
depreciated one. Gubbins lets you set a manual **current value** and keep a history of how it's
changed.

**Where to find it:** the **Lifecycle** tab of an item's details.

## Why a manual value

Without a current value, Gubbins works an item's worth out from what it costs to replace — its
unit cost, or its preferred supplier's price — and, failing those, from its purchase price minus
[[depreciation|Warranty-and-Depreciation]], a *book value* that only ever falls. Every one of
those is wrong for something that appreciates. Setting a **current value** overrides the lot with
a figure you control, which can move in either direction.

> **ℹ️ Note**
> When an item has a manual current value, that figure wins over the depreciated book value
> everywhere it matters — the valuation [[reports|Reports-Overview]], the
> [[insurance schedule|Insurance-and-Estate-Schedule]] and the
> [[parts catalogue|Parts-Catalogue]] all use today's value. The depreciated figure is still
> shown, relabelled **Book value**, so you can see both.

## Revaluation history

Each time you update the value, Gubbins keeps an **append-only revaluation log** — a dated entry
with the amount and an optional note — and shows the trend as a small sparkline. So you can see
how a collectible has appreciated over the years, not just its latest number.

> **💡 Tip**
> Add a note to each revaluation (*"valued by dealer"*, *"comparable sold at auction"*) so the
> history explains itself later. It's a running record of provenance as well as value.

> **ℹ️ Note**
> Enter the new value as plain digits — `1250`, not `1,250` — with a full stop for any decimals.
> Anything that can't be read as a figure is explained beneath the box rather than leaving
> **Record revaluation** unavailable without saying why.

> **ℹ️ Note**
> Current value stays **manual** and offline — Gubbins never fetches live market prices (that
> would need a cloud service and a key, against its local-first, secret-free design). You decide
> when and to what a value changes.

## Related pages

- **[[Warranty & depreciation|Warranty-and-Depreciation]]** — the book-value side.
- **[[Insurance & estate schedule|Insurance-and-Estate-Schedule]]** — where current value is used.
- **[[Parts catalogue|Parts-Catalogue]]** — the printed catalogue values items the same way.
- **[[Reports overview|Reports-Overview]]** — valuation over time.
