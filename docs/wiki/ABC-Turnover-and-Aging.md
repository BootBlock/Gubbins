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

An item's ranking comes from how much of it is **consumed** over the past year — used up, sold,
written off or adjusted away — priced at what it costs you. Lending something out is not consuming
it, so a tool that goes out every week and comes back every week does not climb the ranking: it
would read as a thing to buy more of when you already have enough of it.

> **💡 Tip**
> Tighten [[reorder points|Reorder-and-Shopping-List]] and [[cycle counts|Cycle-Counts-and-Audit-Day]]
> on your **A** items, and relax them on **C** items — that's where the effort pays off.

## Inventory turnover

**Turnover** measures how fast stock is used up and replaced. High turnover is healthy; very low
turnover points at overstocking or things you don't really need.

It counts the same thing ABC does, so the two panels always agree: stock consumed, not stock lent.
A frequently-borrowed tool shows no turnover, which is the honest answer — it is the same tool
coming back each time, not stock flowing through.

The table opens on the fastest movers and says how many items there are altogether; **Show more**
works down towards the slowest. The portfolio figures beside it cover your whole inventory either
way. The dead-stock list behaves the same, so a long worklist never looks shorter than it is — see
[[long lists in a report|Reports-Overview]].

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

"Unmoved" is measured from the item's most recent stock movement in its
[[activity log|Activity-Log]]. If it has never moved, its idle time runs from when it was added
instead — or, if you have **cleared** its log, from the moment of that clear: the clear takes the
movement records with it, so that is as far back as the evidence goes. A cleared item therefore
starts its idle count afresh rather than being judged against the day it was added.

> **💡 Tip**
> A regular glance at dead stock keeps your inventory honest — it's easy to accumulate things you
> no longer need, and this is how you find them.

### What ages the stock

Aging works from the same records, from the other end: an item's age is the age of its **newest
stock-in** — the last time more of it arrived. Where there's no such record, the **acquired**
date on the item is used instead.

Clearing an item's log removes those stock-in records too. When that happens the acquired date
takes over if you recorded one — it still describes the stock, and a clear doesn't change when
you got something. With no acquired date either, the age runs from the clear. Only an item with
none of the three is aged from the day it was added.

> **💡 Tip**
> Filling in **Acquired** on the things you keep long-term is what keeps them aging sensibly, no
> matter what happens to their log later.

## Related pages

- **[[Reports overview|Reports-Overview]]** — the full suite.
- **[[Valuation & spend|Valuation-and-Spend]]** — the value behind ABC.
- **[[Sales & disposals|Sales-and-Disposals]]** — clearing dead stock.
