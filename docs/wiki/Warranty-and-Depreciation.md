# Warranty & depreciation

For tools, equipment and assets, Gubbins tracks the things that change over an item's life —
its **warranty** and its **depreciating value**.

**Where to find it:** the **Lifecycle** tab of an item's details, once the **Warranty &
depreciation** capability is enabled ([[Modular UI|Modular-UI]]).

## Warranty tracking

Record an item's warranty and Gubbins derives its **status** — in warranty, expiring soon, or
expired — from the dates, so you always know where you stand without doing the arithmetic.

Warranty status feeds the [[Alerts|Alerts]] and [[Upcoming|Upcoming-Agenda]] feeds, so a warranty
about to lapse surfaces while you can still act on it (make that claim, plan a replacement).

> **💡 Tip**
> Attach the receipt or warranty document on the item's **Media & docs** tab (see
> [[attachments|Tags-Attachments-and-Related-Items]]) so the proof of purchase is right beside
> the dates when you need to make a claim.

## Depreciation & replacement value

From an item's **purchase price** and expected life, Gubbins estimates its **depreciated value**
today using straight-line depreciation — a *book value* that only ever decreases, falling in equal
steps from the purchase price to **zero** over the term. There is no salvage floor: once the term
has run out, the book value is nothing.

This is the figure the valuation [[reports|Reports-Overview]] and the
[[insurance schedule|Insurance-and-Estate-Schedule]] fall back on, but it is the **last** thing
they try. An item is valued at the first of these that it has:

1. a manual **[[current value|Current-Value-and-Revaluation]]**;
2. its own **unit cost**;
3. its **[[preferred supplier's price|Supplier-Parts-and-Price-History]]**, if that price is in
   your base currency;
4. its **purchase price less depreciation** — the book value above.

So depreciation decides an item's worth only when nothing better prices it. An item with none of
the four is reported as **unpriced** rather than as worth nothing.

> **ℹ️ Note**
> Depreciation always trends **downwards**. For things that hold or gain value — collectibles,
> tools, property — record a manual **[[current value|Current-Value-and-Revaluation]]** instead;
> it can move up as well as down and takes precedence for valuation.

### Entering the figures

Type the **purchase price** as plain digits — `1250`, not `1,250` — using a full stop for any
decimals, and the **depreciation term** as a whole number of months above zero. Leaving either
box empty clears it: a blank purchase price means the item is unpriced, and a blank term means
its value stays flat.

> **⚠️ Heads-up**
> If what you type can't be read as a figure — a thousands separator, a comma decimal, a negative
> amount, a term of `0` — Gubbins says so beneath the box and won't let you save until it's
> fixed. What was already stored stays put in the meantime, so a mistyped price never quietly
> erases the one you had.

## Related pages

- **[[Current value & revaluation|Current-Value-and-Revaluation]]** — for assets that appreciate.
- **[[Insurance & estate schedule|Insurance-and-Estate-Schedule]]** — a printable replacement-value
  document.
- **[[Maintenance & servicing|Maintenance-and-Servicing]]** — keeping assets serviced.
- **[[Reports overview|Reports-Overview]]** — valuation across your inventory.
