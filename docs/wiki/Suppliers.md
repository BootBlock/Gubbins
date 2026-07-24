# Suppliers

Your suppliers are the companies you buy from, kept as **one shared list** behind every supplier
part and every purchase order — so a name is recorded once, correctly, and used everywhere.

**Where to find it:** **Suppliers** in the navigation menu.

## Why suppliers are their own list

A supplier used to be typed out afresh on each part and each order, which meant `RS Components`,
`rs components` and `RS-Components` were three unrelated pieces of text. Nothing could rename them
together, and buying lists split into three groups for one company.

Now each supplier is a single record. Every part and order points at it, so:

- **Renaming is instant and total** — fix a spelling here and it changes on every part and order.
- **Reorder grouping is reliable** — one company is one group, never split by spelling.
- **Spend reporting adds up** — purchases attributed to one company stay together.

> **ℹ️ Note**
> A supplier is its own record, not a [[contact|Contacts]]. Contacts are the people you lend to and
> borrow from; suppliers are who you buy from.

## The list

Each supplier shows its name, default currency, website and note, along with how much is filed
under it: how many **supplier parts** reference it, and how many **purchase orders**. Those two
numbers are what tell you the cost of deleting it — and whether merging it would be tidier.

Select a supplier to edit it.

> **💡 Tip**
> Turn on **Paginate lists** in settings if you'd rather page through a long list than scroll it.
> See [[Language & region|Language-and-Region]] and the settings pages for the display options.

## Adding and editing a supplier

**Add supplier** opens a short form:

| Field | What it's for |
| --- | --- |
| **Name** | How the supplier is known. Matching ignores capitals, spaces and punctuation. |
| **Website** | The supplier's home page or storefront. A supplier *part* keeps its own link to the specific product page. |
| **Default currency** | Pick a common currency from the list, or type any three-letter ISO 4217 code (e.g. `GBP`, `USD`, `EUR`). Used when a part or order under this supplier doesn't state a currency of its own; leave it blank to fall back to your [[base currency|Language-and-Region]]. |
| **Note** | Anything worth remembering: account number, delivery quirks, who to ask for. |

You don't have to come here first. Naming a supplier on a [[supplier part|Supplier-Parts-and-Price-History]]
or a [[purchase order|Purchase-Orders]] adds it to this list automatically, folding it onto an
existing supplier when the name matches one.

> **⚠️ Heads-up**
> Renaming a supplier to a name another supplier already uses isn't allowed — the two would then be
> the same supplier under one identity. Gubbins says so and offers to **merge** them instead, which
> is almost always what was meant.

## Merging two suppliers

**Merge suppliers** is the repair path for duplicates that already exist, and the way to retire a
supplier while its order history keeps naming a supplier.

Pick the supplier to **merge away** and the one to **merge into**. Before anything happens, Gubbins
spells out exactly what will move — for example *"12 supplier parts and 3 purchase orders will move
to RS Components; RS-Components will be deleted."* — and asks you to confirm.

Merging then, in one step:

1. Re-points every supplier part at the supplier you're keeping.
2. Re-points every purchase order at it too, so spend history is preserved in full.
3. Deletes the supplier you merged away.

The kept supplier's own details — name, website, currency and note — are the ones that survive.

> **⚠️ Heads-up**
> Merging can't be undone, and the two suppliers can't be separated again afterwards. Read the
> summary before confirming.

## Deleting a supplier

Any supplier can be deleted. Before it happens, the confirmation spells out both consequences:

- **Supplier parts filed under it are deleted with it** — the confirmation says how many.
- **Purchase orders are kept** — deleting a supplier never destroys a record of what you spent.
  Those orders simply stop naming a supplier, and show as *Unknown supplier* from then on.

If the supplier was a **duplicate**, merge it instead: the orders move to the supplier you keep and
carry on naming one, rather than being left unattributed. See [Merging two suppliers](#merging-two-suppliers)
above.

> **💡 Tip**
> If a supplier has simply gone out of business, neither is necessarily right — a supplier you no
> longer buy from but did buy from is worth keeping, so past orders still name who they came from.

## Turning the screen off

Suppliers is a module like any other page: hide it from **Modules** if you don't need it. Supplier
names still work on parts and orders — you just won't have the screen for tidying the list. See
[[Modular UI|Modular-UI]].

## Related pages

- **[[Supplier parts & price history|Supplier-Parts-and-Price-History]]** — who sells an item, at
  what code and price.
- **[[Purchase orders|Purchase-Orders]]** — ordering from a supplier.
- **[[Reorder & shopping list|Reorder-and-Shopping-List]]** — what to buy, grouped by supplier.
- **[[Valuation & spend|Valuation-and-Spend]]** — what you've spent, by supplier.
- **[[Contacts]]** — the separate list of people you lend to and borrow from.
