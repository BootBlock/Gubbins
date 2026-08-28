# Reorder & shopping list

Gubbins turns *"what's running low"* into *"what to buy"* automatically. Set reorder points and it
builds a **shopping list** of everything that needs restocking — the bridge between
[[low stock|Low-Stock-and-Gauges]] and a [[purchase order|Purchase-Orders]].

**Where to find it:** the **Reorder / Shopping list** tab on the **Purchase orders** screen.

![The Purchase orders screen and its Reorder / Shopping list tab](images/purchase-orders.png)

## Reorder points

A **reorder point** is the stock level at which an item should be bought again. When an item
drops to or below it, Gubbins flags it for reorder — and a target quantity tells it *how much* to
suggest buying back up to.

## The shopping list

Everything below its reorder point rolls up into a **shopping list** — the stock-driven "what to
buy now". From there you can turn items into a [[purchase order|Purchase-Orders]] to a supplier.

> **💡 Tip**
> Reorder points work best on things you never want to run out of — consumables, fasteners,
> common parts. Set the point a little above zero so replacements arrive *before* you hit empty.

> **ℹ️ Note**
> The reorder / shopping list is **stock-driven** — it's about replenishing things you already
> stock. For things you *don't* own yet but want to buy, use the **[[Wishlist]]** tab instead.

## Suppliers who quote in another currency

A [[supplier part|Supplier-Parts-and-Price-History]] can be priced in a currency other than your
base one. The shopping list keeps that price in the currency it was quoted in and shows it under
that currency's own symbol, so a part quoted at €12.50 reads as €12.50 rather than as £12.50.

- **The supplier's estimate** at the top of each group is shown in that supplier's currency.
- **A supplier quoting in more than one currency** gets no combined estimate — there is nothing
  Gubbins could add the prices up into, since it holds no exchange rates. The line prices are
  still shown, each in its own currency.
- **Create draft PO** raises the order **in the supplier's currency**, so the prices carried onto
  it mean what they say. Where a line's quote is in a different currency from the order's, that
  line is added **without a price** for you to fill in — the same refusal the
  [[Add line dialog|Purchase-Orders]] makes.
- **The exported file** names the currency of every row in its own `currency` column.

## Exporting the list

**Export** (above the list) saves the shopping list as a file — one row per item, with the
supplier and the price's currency on every row — in whichever form suits: **CSV**, **TSV** or an **Excel workbook (.xlsx)** for a
spreadsheet or an order portal, **JSON** for another tool, a **Markdown** table for notes, a
printable **HTML** page, or **plain text**. Your per-supplier quantity tweaks are included, so the
file matches exactly what you'd order. See [[Export & import|Export-and-Import]] for the same
formats elsewhere in Gubbins.

## Related pages

- **[[Low stock & gauges|Low-Stock-and-Gauges]]** — the thresholds that drive reordering.
- **[[Purchase orders|Purchase-Orders]]** — turning the list into an order.
- **[[Wishlist]]** — wanted-but-not-owned items.
- **[[Supplier parts & price history|Supplier-Parts-and-Price-History]]** — who to buy from.
