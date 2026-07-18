# Supplier parts & price history

The same part often comes from several suppliers, at different prices and order codes. Gubbins
lets an item hold **supplier parts** — who sells it, under what code, at what price — and remembers
how those prices **change over time**.

**Where to find it:** the **Supplier & ops** tab of an item's details.

## Supplier parts

Record one or more suppliers against an item, each with:

- The **supplier** it comes from.
- The supplier's **part number / order code** for it.
- The **price** (and, where relevant, price breaks for quantity).

So when it's time to reorder, you already know **who** to buy from, **their code**, and **what it
costs** — without digging through old invoices.

### Choosing the supplier

The **Supplier** field lists the suppliers you already use — pick one, or just **type a new
name** and it's added when you save. There's no setup step to do first.

Gubbins matches what you type against your existing suppliers **ignoring capitals, spaces and
punctuation**, so typing `rs-components` finds your existing **RS Components** rather than
creating a near-duplicate beside it. The field tells you which it's about to do before you save:
either that it matches a supplier you already have, or that it's adding a new one.

> **ℹ️ Note**
> A supplier is its own record, not a link to a [[contact|Contacts]]. Because every item points at
> the same record, renaming a supplier updates it everywhere at once — and
> [[reorder|Reorder-and-Shopping-List]] grouping can never be split by two spellings of one name.
> The whole list lives on the [[Suppliers]] screen, where you can rename, merge or remove one.

## Price history

Each time a supplier's price changes, Gubbins keeps the previous figures, building a **price
history** for the part. That lets you see whether something is getting cheaper or dearer, and
spot when a supplier's price has crept up.

> **💡 Tip**
> Recording a couple of suppliers per critical part pays off the day one is out of stock — you've
> got the alternative's code and price ready to go.

> **ℹ️ Note**
> Supplier prices feed [[valuation and spend|Valuation-and-Spend]] reporting and inform the
> [[reorder|Reorder-and-Shopping-List]] and [[purchase order|Purchase-Orders]] flows.

## Related pages

- **[[Suppliers]]** — the shared list of who you buy from: rename, merge and remove.
- **[[Purchase orders|Purchase-Orders]]** — ordering from a supplier.
- **[[Reorder & shopping list|Reorder-and-Shopping-List]]** — what to buy.
- **[[Scraping supplier data|Scraping-Supplier-Data]]** — pulling part details from a supplier
  page automatically.
