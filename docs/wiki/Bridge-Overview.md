# Bridge overview

The **bridge** is an optional companion server that makes your Gubbins data available to *other*
tools — a voice assistant, [[Home Assistant|Home-Assistant-Integration]], an
[[AI assistant|AI-Assistant-Query-MCP]], your calendar, a dashboard. The Gubbins app itself never
runs a server; the bridge is a separate thing **you** choose to run.

> **ℹ️ Note**
> The bridge is a more technical, enthusiast-oriented feature. If you just want to *use* Gubbins,
> you can skip this whole section — nothing here is required. Full technical detail lives in the
> bridge's own `README` in the [Gubbins repository](https://github.com/BootBlock/Gubbins).

## What it offers

Pointed at a copy of your data (a [[sync snapshot or the SQLite file|Cloud-Sync]]), the bridge can
expose:

- A **read-only query API** — search and read your items over HTTP.
- A **[[calendar feed|Webhooks-MQTT-and-iCal]]** (iCal) of due-backs, bookings, maintenance and
  warranties.
- **[[Webhooks]]** — calls a URL of your choosing when something changes.
- A **[[live event stream|Webhooks-MQTT-and-iCal]]** (SSE) of the same changes.
- **[[MQTT publishing + Home Assistant discovery|Home-Assistant-Integration]]**.
- An **[[MCP server|AI-Assistant-Query-MCP]]** so an AI assistant can answer *"where are my…"*.

## Safe by design

The bridge is built to be cautious:

- **Loopback by default** — it listens only on your own machine (`127.0.0.1`) unless you
  deliberately expose it. It speaks plain HTTP, so if you *do* bind it to the network, put it behind
  HTTPS on anything you don't fully trust — see
  [[exposing it beyond your own machine|Running-the-Bridge]].
- **Per-user tokens** — requests need an [[API token|Bridge-API-Tokens]] you mint in the app
  against a particular account, and they can only do what that account can do.
- **Read-only by default** — it can't change your data unless you explicitly turn writes on.
- **Everything network-facing is opt-in** — each feature (events, MQTT, discovery) is off until you
  enable it, and every choice is logged at startup.

Because you run it yourself, the bridge only updates when you update it — and Gubbins warns you on
the **Sync** screen when the one you're connected to has fallen behind the app. See
[[Keeping it up to date|Running-the-Bridge]].

> **⚠️ Heads-up**
> The bridge reads a *copy* of your data and can serve it over the network if you configure it to.
> Treat an [[API token|Bridge-API-Tokens]] like a password, keep the default loopback bind unless
> you know you need a LAN, and never commit a token anywhere. See
> [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Running the bridge|Running-the-Bridge]]** — starting it up.
- **[[Bridge API tokens|Bridge-API-Tokens]]** — how tools are given access, and how to take it back.
- **[[Home Assistant integration|Home-Assistant-Integration]]** — the flagship use.
- **[[AI assistant query (MCP)|AI-Assistant-Query-MCP]]**, **[[Webhooks]]** and
  **[[Webhooks, MQTT & iCal|Webhooks-MQTT-and-iCal]]** — the other surfaces.
