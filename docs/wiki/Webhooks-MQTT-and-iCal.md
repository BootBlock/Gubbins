# Webhooks, MQTT & iCal

Beyond simple queries, the [[bridge|Bridge-Overview]] can **push** your inventory into other
systems — fire webhooks on changes, publish over MQTT, and serve a calendar feed. Each is a
separate opt-in.

> **ℹ️ Note**
> These are technical integrations, configured on the bridge itself rather than in Gubbins; this
> page explains what each is for, and the exact configuration is in the bridge `README` in the
> [Gubbins repository](https://github.com/BootBlock/Gubbins). **Webhooks are the exception** — they
> have their own screen in Gubbins, and their own page: [[Webhooks]].

## Change events: webhooks & SSE

The bridge can emit **change events** — an item's stock went low, something was added, a loan came
due. Two ways to consume them:

- **Webhooks** — a URL of your choosing is called when something happens, so another system can
  react. You set these up **in Gubbins**, on its own [[Webhooks]] screen; the bridge delivers them.
  That page covers events, filters, payloads, signing and the delivery log.
- **SSE event stream** — a live stream you can subscribe to for a running feed of changes, set up
  on the bridge.

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

With discovery on you also get a **Snapshot stale** sensor. If the bridge can no longer re-read
your data it keeps serving the last copy it had — the right call, so an integration doesn't go
dead — but the numbers are then out of date. This sensor turns *on* exactly then, so you can put a
warning on a dashboard or fire an automation. It's kept separate from the entities' availability on
purpose: the other sensors stay present (no gaps in their history) rather than vanishing the moment
a sync folder blips. If you'd actually rather they disappeared while the data is stale, point their
availability at this sensor in your own Home Assistant config.

> **ℹ️ Note**
> "Snapshot stale" is about the *data* being current, not about the bridge being reachable. A bridge
> that has stopped entirely shows its entities as *unavailable* the usual way; this sensor covers the
> subtler case where the bridge is up and answering, but from a copy of your data it can no longer
> refresh.

> **⚠️ Heads-up — if you already had MQTT publishing switched on**
> Locations' [[custom fields|Custom-Fields-and-Capabilities]] were added to what MQTT publishes,
> and they don't have a switch of their own — turning on MQTT publishing is what enables them. So
> if you'd already set MQTT up before this was added, your locations' field values start reaching
> your broker when you update, without you changing anything.
>
> That's the intended behaviour, and it's your own broker. It's just worth a glance at what you've
> recorded **on locations**: all of a location's fields are published, and you can't hold one back
> while publishing the rest. If something there is genuinely sensitive, move it to the item, limit
> the topic with a broker rule, or leave MQTT publishing off. Fields on *items* are never published
> this way.

See [[Home Assistant integration|Home-Assistant-Integration]].

## Calendar feed (iCal)

The bridge serves a read-only **iCalendar** feed of Gubbins' time-bearing facts — loan due-backs,
[[bookings|Bookings]], [[maintenance|Maintenance-and-Servicing]] and
[[warranty|Warranty-and-Depreciation]] dates — that **any calendar app can subscribe to**. Your
Gubbins deadlines then sit alongside the rest of your schedule, updating as your data changes.

> **💡 Tip**
> The calendar feed is the easiest of these to use — subscribe to it from your phone or desktop
> calendar and every Gubbins due-date appears automatically, no automation required.

Calendar apps re-check a subscription on their own schedule — some every few minutes — so the feed
tells them when nothing has changed rather than rebuilding the whole calendar each time. A check
that finds no new data is answered in a few bytes, which keeps a busy subscription (and the
activity feeds, and the metrics endpoint, which behave the same way) cheap on the machine running
the bridge. Nothing to configure: your calendar app handles it.

> **⚠️ Heads-up**
> These surfaces can send your data outward (to a webhook target, an MQTT broker, a calendar
> service). Each is opt-in, reachable only with an [[API token|Bridge-API-Tokens]] whose owner has
> permission for it, and best kept to trusted destinations and your local network. See
> [[Privacy & security|Privacy-and-Security]].

> **💡 Tip**
> A calendar subscription carries its token in the URL, which is easier to leak than a normal
> request. Mint that one against an account whose role does little beyond read bookings — see
> [[Bridge API tokens|Bridge-API-Tokens]].

## Related pages

- **[[Webhooks]]** — setting up webhooks in Gubbins itself.
- **[[Bridge overview|Bridge-Overview]]** and **[[Running the bridge|Running-the-Bridge]]** — the
  foundation.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — MQTT discovery in context.
- **[[Upcoming agenda|Upcoming-Agenda]]** — the in-app view of the same deadlines the iCal feed
  publishes.
