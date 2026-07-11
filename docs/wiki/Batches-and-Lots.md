# Batches & lots

Sometimes *how many* isn't enough — you also need to know *which delivery* stock came from, and
**when it expires**. Batches (or lots) split an item's stock in a location into dated groups, so
Gubbins can always use the oldest first.

**Where to find it:** batch controls appear on an item's stock once the **Batches & lots**
capability is enabled ([[Modular UI|Modular-UI]]).

## What a batch is

A **batch** sits *beneath* a [[location|Locations-and-Stock]] in the stock hierarchy:

> Item → Location → **Batch** (with its own quantity and expiry date)

So *20 units of adhesive on Shelf A* might be two batches — 12 from March (expiring soon) and 8
from June. Together they're still 20 on Shelf A, but Gubbins knows the split.

## First-expiry-first-out (FEFO)

When you consume stock of a batched item, Gubbins draws from the batch that **expires first** —
*first-expiry-first-out*. That means the stock most at risk of lapsing gets used up before it
does, automatically, without you having to pick a batch each time.

> **💡 Tip**
> FEFO is ideal for anything perishable or shelf-life-limited — adhesives, chemicals, food,
> photographic supplies, calibration standards. Record the expiry when stock arrives and Gubbins
> handles the rotation.

## Batches and expiry alerts

Batch expiry dates feed the [[expiry tracking|Low-Stock-and-Gauges]] and the
[[Alerts|Alerts]] / [[Upcoming|Upcoming-Agenda]] feeds, so a batch approaching its date surfaces
before it lapses rather than being discovered too late.

> **ℹ️ Note**
> Batches are optional. If you don't need delivery- or expiry-level detail, leave the capability
> off and just track a single quantity per location — everything else works exactly the same.

## Related pages

- **[[Locations & stock|Locations-and-Stock]]** — the per-location ledger batches sit under.
- **[[Cycle counts & audit day|Cycle-Counts-and-Audit-Day]]** — reconciling stock, including
  per-batch.
- **[[Alerts|Alerts]]** — where expiring batches surface.
