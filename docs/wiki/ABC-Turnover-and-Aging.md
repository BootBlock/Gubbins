# ABC, turnover & aging

Three related reports answer *"which items really matter, and which are just sitting there?"* —
so you can focus attention (and money) where it counts.

**Where to find it:** the **Reports** screen (Advanced analytics).

![ABC analysis, inventory turnover and stock aging](images/reports.png)

## ABC analysis

**ABC analysis** ranks your items into classes by value/importance — the **A** items (the vital
few that account for most of the value), **B** (the middle), and **C** (the trivial many). It's
the classic "80/20" lens: a small number of items usually dominate, and they deserve the most
careful stock control.

> **💡 Tip**
> Tighten [[reorder points|Reorder-and-Shopping-List]] and [[cycle counts|Cycle-Counts-and-Audit-Day]]
> on your **A** items, and relax them on **C** items — that's where the effort pays off.

## Inventory turnover

**Turnover** measures how fast stock moves — how often it's used and replaced. High turnover is
healthy; very low turnover points at overstocking or things you don't really need.

## Stock aging & dead stock

**Aging** buckets stock by how long it's sat untouched, and **dead-stock detection** surfaces the
items that haven't moved at all — the candidates to use up, sell, or [[write off|Sales-and-Disposals]].

### Choosing what gets watched

Dead-stock reporting is **opt-in**. Nothing appears on the report until you ask for it, so the list
stays a short, meaningful set rather than every item you happen to own.

You can switch it on in two places:

- **On a location** — open a location and set **Dead-stock reporting** to *Report*. Everything
  stored there, including in its sub-locations, is watched from then on. This is usually the
  quickest way in: point it at the cupboard or shelf you actually want to keep lean.
- **On an individual item** — open the item's **Dead-stock reporting** panel and choose *Report*.

Both offer the same three choices:

| Choice | What it does |
| --- | --- |
| **Inherit** | Follow the location above. This is the default; if nothing above opts in, the item isn't reported. |
| **Report** | Always watch it, whatever the location says. |
| **Ignore** | Never watch it, even if its location reports everything stored there. |

An item's own choice always beats its location's, so you can watch a whole cupboard and still
exempt the one thing that's meant to sit there untouched.

### How long is "too long"?

An item counts as dead once it has gone unmoved for the **idle threshold**. The default lives in
**Settings → Inventory → Stock alerts & lifecycle → Dead-stock threshold** (90 days out of the
box).

Individual locations can override it: open a location and set its own **Idle threshold**. That
applies to everything inside it, sub-locations included, unless one of those sets its own. Leave it
blank to use the value from above. This is what lets deep storage only raise a flag after a year
while a workbench goes stale in a month.

> **ℹ️ Note**
> The threshold and the opt-in are independent — a location can set a house threshold for its
> contents without switching reporting on for them.

> **💡 Tip**
> A regular glance at dead stock keeps your inventory honest — it's easy to accumulate things you
> no longer need, and this is how you find them.

## Related pages

- **[[Reports overview|Reports-Overview]]** — the full suite.
- **[[Valuation & spend|Valuation-and-Spend]]** — the value behind ABC.
- **[[Sales & disposals|Sales-and-Disposals]]** — clearing dead stock.
