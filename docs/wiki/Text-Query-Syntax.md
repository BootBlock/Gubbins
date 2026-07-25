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
| Serial number | `serial`, `serialnumber`, `sn` | The unit's serial number |
| Quantity | `quantity`, `qty` | On-hand count *(numeric)* |
| Weight | `weight` | Item weight *(numeric)* |
| Dimensions | `width`, `height`, `depth` | Bounding size *(numeric)* |
| Reorder point | `reorder`, `reorderpoint` | The item's own low-stock floor *(numeric)* |
| Unit cost | `cost`, `unitcost` | What a unit costs *(money)* |
| Purchase price | `price`, `purchaseprice`, `paid` | What you paid *(money)* |
| Current value | `value`, `currentvalue`, `worth` | Latest [[revalued worth\|Current-Value-and-Revaluation]] *(money)* |
| Expiry date | `expiry`, `expires`, `expirydate` | When [[perishable stock\|Batches-and-Lots]] expires *(date)* |
| Warranty expiry | `warranty`, `warrantyexpires` | When [[cover ends\|Warranty-and-Depreciation]] *(date)* |
| Condition | `condition`, `cond` | [[Condition grade\|Condition-Grading]] *(choice)* |
| Tracking mode | `tracking`, `trackingmode` | [[How stock is tracked\|Tracking-Modes]] *(choice)* |
| Dead-stock reporting | `deadstock` | The item's [[dead-stock\|ABC-Turnover-and-Aging]] setting *(choice)* |
| Favourite | `favourite`, `favorite`, `fav` | Pinned favourites *(yes/no)* |
| Active | `active` | Excludes decommissioned items *(yes/no)* |
| Tag | `tag`, `tags`, `tagged` | A [[tag\|Tags-Attachments-and-Related-Items]] on the item |

## Comparisons

Numeric fields accept `>`, `<` and `=`:

```
qty<10            fewer than 10 in stock
qty=0             out of stock
weight>500        heavier than 500 g
```

Money is typed in your base currency's normal units — `cost>10` means over ten, not ten pence:

```
cost>10           units costing more than 10
value<50          worth less than 50 now
```

Dates are written `YYYY-MM-DD`, where `<` means *before* that day and `>` means *after* it:

```
expiry<2026-03-01     expiring before March
warranty>2027-01-01   still covered beyond 2027
expiry:2026-03-01     expiring on that exact day
```

Choice fields match one of a fixed set of values. Case doesn't matter, and you can write a
multi-word value with a hyphen (or quote it):

| Field | Accepted values |
| --- | --- |
| `condition` | `mint`, `good`, `needs-repair`, `out-for-calibration` |
| `tracking` | `discrete` *(shown as Bulk)*, `serialised`, `consumable-gauge`, `untracked` |
| `deadstock` | `inherit`, `always` *(shown as Report)*, `never` *(shown as Ignore)* |

```
condition=needs-repair    or condition:"needs repair"
tracking:serialised
deadstock:always
```

> **💡 Tip**
> Get one wrong and Gubbins lists the values it will accept, so you never have to guess.

The yes/no flags:

```
fav:yes           only your favourites
active:no         only decommissioned items
```

> **ℹ️ Note**
> Searches normally cover your live inventory only. Adding `active:no` (or `active:yes`) is the
> exception — it lets you go looking for decommissioned items deliberately.

## Tags

Filter by a [[tag|Tags-Attachments-and-Related-Items]] with the `tag:` prefix. `tag:` matches
**part** of a tag's name, `tag=` the **whole** name — both ignoring case, exactly as the tag
dictionary itself treats `Fragile` and `fragile` as one tag:

```
tag:fragile               items tagged "fragile"
tag:expo                  items tagged "expo-2026", "expo-spares", …
tag=expo-2026             only the tag named exactly "expo-2026"
tag:"needs a clean"       a tag name with spaces — quote it
```

An item matches if **any** of its tags does, so `tag:fragile tag:vintage` finds the items that
carry both.

> **ℹ️ Note**
> This searches the tags on the **item**. A tag on a *location* describes that place rather than
> the things inside it — narrow the location tree by its tag chips instead (see
> [[Tags|Tags-Attachments-and-Related-Items]]).

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
