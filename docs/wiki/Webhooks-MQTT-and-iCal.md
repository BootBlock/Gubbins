# Webhooks, MQTT & iCal

Beyond simple queries, the [[bridge|Bridge-Overview]] can **push** your inventory into other
systems — fire webhooks on changes, publish over MQTT, and serve a calendar feed. Each is a
separate opt-in.

> **ℹ️ Note**
> These are technical integrations. Exact configuration is in the bridge `README` in the
> [Gubbins repository](https://github.com/BootBlock/Gubbins); this page explains what each is for.

## Change events: webhooks & SSE

The bridge can emit **change events** — an item's stock went low, something was added, a loan came
due. Two ways to consume them:

- **Webhooks** — the bridge calls a URL you provide when something happens, so another system can
  react.
- **SSE event stream** — a live stream you can subscribe to for a running feed of changes.

Both are **off until you enable them**.

### Lookup events

The bridge can also announce when a *"where is…"* question **resolves** — the question asked, what
matched, and which locations it's in. That's what lets an automation light up the right bin as the
answer is read back.

This one is different from every other event: the rest report something that **changed** in your
inventory, whereas this reports something that was merely **looked up**. Because it publishes what
someone searched for, it has its own separate switch and stays off even if you've enabled events
generally — turning on change events never turns this on for you.

> **💡 Tip**
> Repeated or rephrased questions are grouped together for a few seconds, so asking twice won't
> set the same automation off twice.

## MQTT publishing & Home Assistant discovery

The bridge can **publish** to an MQTT broker — including summary topics like stock counts — and
announce them via **Home Assistant MQTT discovery**, so they show up as entities automatically.
Each location is published with its item count and its own
[[custom fields|Custom-Fields-and-Capabilities]] alongside, so an automation can read something
like "which light is above this shelf" straight off the location.

If you've turned on lookup events, a resolved *"where is…"* question is also published to its own
topic, so a Node-RED flow or an MQTT trigger can act on the answer without the Home Assistant
custom integration. That one is sent **live only** — it is never replayed to something that
connects later, so an old question can't set an automation off.

See [[Home Assistant integration|Home-Assistant-Integration]].

## Calendar feed (iCal)

The bridge serves a read-only **iCalendar** feed of Gubbins' time-bearing facts — loan due-backs,
[[bookings|Bookings]], [[maintenance|Maintenance-and-Servicing]] and
[[warranty|Warranty-and-Depreciation]] dates — that **any calendar app can subscribe to**. Your
Gubbins deadlines then sit alongside the rest of your schedule, updating as your data changes.

> **💡 Tip**
> The calendar feed is the easiest of these to use — subscribe to it from your phone or desktop
> calendar and every Gubbins due-date appears automatically, no automation required.

> **⚠️ Heads-up**
> These surfaces can send your data outward (to a webhook target, an MQTT broker, a calendar
> service). Each is opt-in, token-protected, and best kept to trusted destinations and your local
> network. See [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Bridge overview|Bridge-Overview]]** and **[[Running the bridge|Running-the-Bridge]]** — the
  foundation.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — MQTT discovery in context.
- **[[Upcoming agenda|Upcoming-Agenda]]** — the in-app view of the same deadlines the iCal feed
  publishes.
