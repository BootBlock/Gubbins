# Sales & margin

If you **sell** any of your stock, Gubbins reports what you sold and the **profit margin** on it —
turning [[sales & disposals|Sales-and-Disposals]] records into a clear picture of what's making
money.

**Where to find it:** the **Reports** screen (fed by items you've marked as sold).

## What it shows

When you record an item as **sold** (see [[Sales & disposals|Sales-and-Disposals]]), you capture
what it went for. The **sales & margin** report then compares that against the item's cost to show:

- **Revenue** — what your sales brought in.
- **Margin** — the profit after cost, per item and overall.

So you can see which items are worth selling, and which barely cover their cost.

> **💡 Tip**
> Even if you only sell occasionally — clearing surplus, flipping the odd find — the margin view
> tells you whether it's worth the effort or whether you're practically giving things away.

> **ℹ️ Note**
> Margins are only as good as your **cost** figures. Keep [[unit costs|Items]] up to date (and
> use [[supplier price history|Supplier-Parts-and-Price-History]]) so profit reflects reality.

## Where the cost comes from

The cost side of the margin is captured **at the moment you record the sale**, and it stays as it
was — a later price edit never rewrites a sale you've already made. Gubbins takes the item's own
**unit cost** if it has one, otherwise the **preferred supplier's** price.

Two things follow from that:

- **Set a unit cost before you sell.** An item with no cost of either kind still counts its
  revenue, but contributes no cost — so it reads as pure profit. The report flags how much of it
  you're looking at: *"Margin excludes N sold units with no recorded cost."*
- **A supplier price in another currency isn't used.** Gubbins holds no exchange rates and never
  converts, so a part quoted in yen can't become a cost in pounds — the sale is counted as one of
  those uncosted units instead of being booked at a wrong figure. The same rule applies to
  [[valuation & spend|Valuation-and-Spend]] and the
  [[insurance schedule|Insurance-and-Estate-Schedule]]. Give the item its own **unit cost**, in your
  base currency, so its sales carry a real cost into the margin.

## Related pages

- **[[Sales & disposals|Sales-and-Disposals]]** — recording a sale.
- **[[Reports overview|Reports-Overview]]** — the full suite.
- **[[Valuation & spend|Valuation-and-Spend]]** — the cost/value side.
