# Text query syntax

The **power search** box accepts a compact text syntax for precise filtering — ideal if you'd
rather type `qty<10 mfr:acme` than click through the [[visual builder|Visual-Query-Builder]].
Pressing **Enter** runs it (and fills the builder, so you can fine-tune afterwards).

**Where to find it:** the second box in the **Visual search** panel (Inventory → **More** →
**Visual search**).

![The power-search box, with an example query](images/search-visual-builder.png)

## The basics

A query is a list of terms separated by spaces. A bare word matches item **names**:

```
esp32
```

Add a `field:` prefix to search a specific field:

```
mfr:acme          items whose manufacturer contains "acme"
name:bracket      items whose name contains "bracket"
```

Field names are **case-insensitive** and accept short aliases.

## Fields you can search

| Field | Aliases | Matches |
| --- | --- | --- |
| Name | `name` | The item name |
| Description | `description`, `desc` | The description |
| Notes | `notes`, `note` | Free-text notes |
| Manufacturer | `manufacturer`, `mfr`, `make` | The maker |
| Part number | `mpn` | Manufacturer part number |
| Barcode | `barcode`, `gtin`, `upc`, `ean` | A scanned/entered barcode |
| Quantity | `quantity`, `qty` | On-hand count *(numeric)* |
| Weight | `weight` | Item weight *(numeric)* |
| Dimensions | `width`, `height`, `depth` | Bounding size *(numeric)* |
| Favourite | `favourite`, `favorite`, `fav` | Pinned favourites *(yes/no)* |

## Comparisons

Numeric fields accept `>`, `<` and `=`:

```
qty<10            fewer than 10 in stock
qty=0             out of stock
weight>500        heavier than 500 g
```

The favourite flag is a yes/no:

```
fav:yes           only your favourites
```

## Capabilities

[[Capabilities|Custom-Fields-and-Capabilities]] are weighted attributes you define. Use the
`cap:` prefix:

```
cap:waterproof            items that have the "waterproof" capability
cap:voltage>3.3           capability "voltage" greater than 3.3
cap:colour=red            capability "colour" equal to "red"
```

Custom category fields work the same way with `field:` (or `cf:`):

```
field:material=steel
```

## Combining terms

- **Spaces mean AND** — every term must match: `qty<10 mfr:acme`.
- **`OR`** — either side: `mfr:acme OR mfr:globex`.
- **Parentheses** group logic: `cap:voltage>3.3 (qty<10 OR mfr:acme)`.

> **💡 Tip**
> A value containing a bracket or a `|` must be quoted so it isn't read as grouping — for
> example `name:"a|b"`.

> **ℹ️ Note**
> If a term can't be understood, Gubbins tells you why rather than silently ignoring it — so a
> typo'd field name is easy to spot and fix.

## Related pages

- **[[Visual query builder|Visual-Query-Builder]]** — the same queries, built by clicking.
- **[[Natural-language search|Natural-Language-Search]]** — no syntax to learn at all.
- **[[Saved searches & favourites|Saved-Searches-and-Favourites]]** — keep a query for reuse.
