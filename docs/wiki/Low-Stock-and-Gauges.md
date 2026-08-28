# Low stock & gauges

Gubbins can tell you, at a glance, when something is running low — with a coloured status on
every item card and thresholds you control. This is the foundation of the
[[Alerts|Alerts]] and [[reorder|Reorder-and-Shopping-List]] features.

**Where to find it:** low-stock thresholds live in **Settings → Inventory** (and per item); the
status shows on every item card.

## At-a-glance status

Every item card shows a stock status — *In stock*, *Low stock*, *Out of stock* — with a colour
so a shelf that needs attention stands out without reading numbers.

![An item card showing its stock status](images/item-card.png)

For [[consumable items|Tracking-Modes]], the status is a **fill gauge** rather than a count, so
you can see how much is left in a spool or bottle.

![A consumable item's fill gauge](images/item-card-gauge.png)

You keep that gauge up to date however suits the moment — record usage, weigh it in on a scale,
top it up, or (when there's no scale to hand) just **Estimate** the level from *Full* to *Empty*.
The gauge threshold below then flags it as low the same way, whichever method you used.

Weighing one in needs Gubbins to know the **tare** — what the empty spool or bottle itself weighs
— so it can tell the container apart from what's in it. You can pick that from the
[[container weights|Container-Weights]] library instead of typing it each time.

Bringing a shelf full of consumables in from a spreadsheet works too. Mark the rows as
*Consumable* — with a tracking column, or by setting **Tracking for new items** in the import
wizard — and give the file a **Unit of measure** and a **Gross capacity** column (optionally
**Tare weight** and **Net remaining**); then [[import|Export-and-Import]] it like any other list.

## What a gauge is worth

A gauge holds a measure, not a count, so there's no quantity for a **unit cost** to multiply. Give
it a **cost per unit of measure** instead — the field sits beside *Unit cost* on the item and is
labelled with the gauge's own unit (*Cost per g*, *Cost per ml*). Gubbins then values the item at
**what's in it × that cost**, so a spool with 400 g left at `0.025` per gram is worth `£10.00`.

That figure feeds the [[valuation reports|Valuation-and-Spend]], the
[[insurance schedule|Insurance-and-Estate-Schedule]] and the aging and dead-stock reports, and it
falls as you use the material up.

> **⚠️ Heads-up**
> Leave the cost blank and the gauge's contents are **reported as unpriced** rather than counted as
> worth nothing — a notice on the Reports screen and the insurance schedule says how many gauges
> that applies to. Unit cost won't stand in for it: Gubbins won't read the price of a whole spool as
> the price of a gram.

## Attrition — when using some costs more than you use

Some materials cost you more than you actually use. Take 100 g of flour out of the bag and
nearer 110 g really leaves it, once the dusting left on the board and in the bag is counted.
Trimmings, spillage and offcuts all work the same way.

A consumable item can carry an optional **attrition** percentage to account for that. Set it
when you add the item, or later under **Gauge setup** on the item itself. At `10%`, recording
`100` used takes `110` off the gauge — and the dialog shows you both figures before you
confirm, so nothing changes behind your back:

> Using 100g costs 110g (10g waste at 10%)

Leave the field blank — the default — and nothing changes: what you record used is exactly what
comes off.

> **ℹ️ Note**
> Attrition applies only when you **record an amount used**. A weigh-in already measures what is
> physically left, so the waste is in that reading — applying a rate on top would count it
> twice. Refills and estimates aren't draws either, so they're unaffected.

Each entry in the item's [[Activity Log|Activity-Log]] records what you asked for alongside what
actually left, so the waste is visible after the fact rather than silently folded into the total.

> **💡 Tip**
> Not sure what rate to use? Leave it off at first. If cycle counts on an item keep coming up
> short by roughly the same proportion, that gap *is* your attrition rate — see
> [[Cycle counts & audit day|Cycle-Counts-and-Audit-Day]].

## Thresholds

A **low-stock threshold** is the quantity at or below which an item counts as "low". You can set:

- A **default** threshold applied across your inventory, and
- A **per-item** threshold for anything that needs a different trigger point.

There's also a separate **gauge threshold** for how empty a consumable can get before it's
flagged.

> **💡 Tip**
> Set thresholds where reordering actually makes sense — a fast-moving fastener might warrant a
> threshold of 100, while a spare you rarely need can sit at 1. Tune them in
> **Settings → Inventory**.

## What never counts as low

Some items have no shelf level to run down, so they stay quiet whatever their thresholds say —
on the item card, in the widgets and alerts, and in anything reading your inventory from
outside (such as [[Home Assistant|Home-Assistant-Integration]]):

- **Unlimited supply** items — mains water, air or a bulk pile you always have on hand
  ([[Tracking modes|Tracking-Modes]]).
- **Serialised** single assets and **presence-only** items — a count of one, or no count at all,
  isn't a stock level.
- **Parent items with [[variants|Variants-and-SKUs]]** — the stock sits on the child variants,
  so the parent is never low or out on its own account. Set thresholds on the variants instead.

## Where low stock surfaces

Once something crosses its threshold it appears in several places, so you notice however you
work:

- The **Low stock** dashboard widget and the [[Alerts|Alerts]] feed.
- The inventory **status chips** and [[searches|Search-Overview]] (`qty<10`, or *"low stock"* in
  [[plain English|Natural-Language-Search]]).
- The [[reorder / shopping list|Reorder-and-Shopping-List]], which turns low stock into things
  to buy.
- Optional [[OS reminder notifications|Reminder-Notifications]] on an installed app.
- The [[bridge|Bridge-Overview]] surfaces — the [[Home Assistant|Home-Assistant-Integration]]
  sensors, the [[MQTT summary and webhooks|Webhooks-MQTT-and-iCal]] and the metrics a dashboard
  scrapes.

> **⚠️ Heads-up**
> The bridge reads your inventory, not your browser, so it can only see a **default** threshold you
> have chosen to share. Turn on
> [[sharing settings between devices|Sharing-Settings-Between-Devices]] with the *Alerts &
> thresholds* group ticked, and sync — then the Home Assistant low-stock sensor, the MQTT counts
> and the low-stock events all use the same default the app does. Without that the bridge falls
> back to the shipped default of *off*, so it flags only items given a **per-item** threshold.
> Per-item thresholds are part of the item itself, so they reach the bridge either way.

## Related pages

- **[[Container weights|Container-Weights]]** — the empty weight of the spool or jar a gauge's
  contents sit in.

- **[[Alerts|Alerts]]** — everything needing attention in one feed.
- **[[Reorder & shopping list|Reorder-and-Shopping-List]]** — acting on low stock.
- **[[Tracking modes|Tracking-Modes]]** — how counts and gauges differ.
