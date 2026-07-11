# Supplier parts & price history

The same part often comes from several suppliers, at different prices and order codes. Gubbins
lets an item hold **supplier parts** — who sells it, under what code, at what price — and remembers
how those prices **change over time**.

**Where to find it:** the **Supplier & ops** tab of an item's details.

## Supplier parts

Link an item to one or more [[suppliers|Contacts]], each with:

- The supplier's **part number / order code** for it.
- The **price** (and, where relevant, price breaks for quantity).

So when it's time to reorder, you already know **who** to buy from, **their code**, and **what it
costs** — without digging through old invoices.

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

- **[[Purchase orders|Purchase-Orders]]** — ordering from a supplier.
- **[[Reorder & shopping list|Reorder-and-Shopping-List]]** — what to buy.
- **[[Scraping supplier data|Scraping-Supplier-Data]]** — pulling part details from a supplier
  page automatically.
