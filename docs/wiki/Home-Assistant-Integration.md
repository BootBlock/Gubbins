# Home Assistant integration

Connect Gubbins to **Home Assistant** and your inventory becomes part of your smart home — ask a
voice assistant *"where are my allen keys?"*, or surface stock levels as entities for automations
and dashboards. This runs through the [[bridge|Bridge-Overview]].

> **ℹ️ Note**
> This is an enthusiast feature that assumes you already run Home Assistant and the
> [[bridge|Running-the-Bridge]]. The authoritative setup steps live in the bridge `README` and the
> Home Assistant integration in the [Gubbins repository](https://github.com/BootBlock/Gubbins).

## What you can do

- **Ask where things are.** A custom integration answers spoken *"where is / where are my…"*
  questions, speaking the location back — Gubbins does the lookup and Home Assistant relays it.
- **See stock as entities.** Via **MQTT discovery**, Gubbins can publish summary figures (like
  low/out-of-stock counts) that appear automatically as Home Assistant entities — ready for
  dashboards and automations.
- **Automate on changes.** Because the bridge emits [[change events|Webhooks-MQTT-and-iCal]], you
  can trigger Home Assistant automations from inventory changes (e.g. notify when something runs
  low).

## Discovery

The bridge can advertise itself on your network (mDNS/zeroconf), so Home Assistant can **discover**
it rather than you typing addresses — an opt-in, locally-gated convenience.

## Optional write-back

If you choose to enable it, Home Assistant can also *adjust* stock through the bridge — a peer
device that writes back through Gubbins' safe [[merge|Cloud-Sync]] so it can't cause drift.
Write-back is **off by default**.

> **⚠️ Heads-up**
> Exposing the bridge to Home Assistant means it's reachable on your LAN. Use a strong
> [[token|Running-the-Bridge]], keep write-back off unless you need it, and treat the whole setup
> as trusted-network only. See [[Privacy & security|Privacy-and-Security]].

## Related pages

- **[[Bridge overview|Bridge-Overview]]** and **[[Running the bridge|Running-the-Bridge]]** — the
  foundation.
- **[[AI assistant query (MCP)|AI-Assistant-Query-MCP]]** — the same lookups for AI assistants.
- **[[Webhooks, MQTT & iCal|Webhooks-MQTT-and-iCal]]** — events, MQTT and calendar in detail.
