# Bridge automation & item metadata — grounding research + backlog (living plan)

> **Status:** 🟢 ACTIVE — open backlog; research complete, no tasks shipped yet. `A1` next.

Grounding research into whether the [Home Assistant bridge](../../bridge/README.md) can usefully
grow features that help **automation** — and, if so, which. Driven by the "smart bin" scenario: a
storage system with an LED on each box, where asking *"where are my M3 screws?"* should light the
box up.

Each task has a stable ID (`A1`, `A2`, …) so a session can be kicked off with just "implement `A2`".
This is a **living** backlog — the surface keeps growing, so new findings get appended rather than
replacing what's here.

## Verdict

**Yes — there is genuine value, and the highest-value piece is also the smallest.**

The LED scenario needs a chain of four links. Gubbins already has three of them:

| Link | Status |
| --- | --- |
| A stable identifier per storage location | ✅ `LocationDto.id`; MQTT already publishes `gubbins/location/<id>/state` and a discovery-created `sensor.gubbins_location_<id>` per user location. |
| Somewhere to record "this location's LED is `light.bin_42`" | ✅ **The substrate exists** — the field dictionary (`field_defs` + `location_field_values` / `item_field_values`, with the effective-value VIEW). It is simply **not exposed over the bridge**. |
| A way for Home Assistant to act on a location | ✅ Entirely HA's side — `light.turn_on` against whatever entity the user maps. Not our problem to solve. |
| **A signal that a lookup just resolved to a location** | ❌ **Missing. This is the blocker.** |

So the answer to the issue's question is: the bridge does **not** need to learn about LEDs, lights,
or any physical device. It needs to (a) **emit a lookup as an event** and (b) **stop hiding the
metadata the app already stores**. Everything downstream — which entity, what colour, how long it
stays lit — is an ordinary Home Assistant automation the user writes, and stays firmly out of
Gubbins.

The issue's own instinct ("may benefit from being able to add metadata to items that integrations
can pull from") is right, and cheaper than it sounds: the storage layer is already built and synced.

### Why the lookup event is the blocker

`GubbinsWhereIsIntent.async_handle` ([custom_components/gubbins/intent.py](../../custom_components/gubbins/intent.py))
is terminal: it asks the bridge for the spoken sentence, sets it as speech, and returns. It fires
no Home Assistant bus event, so **no automation can trigger on "someone asked where something
is"** — the answer is spoken and then discarded. The bridge's `whereIs` has the resolved location
ids in hand and throws them away too; `WhereIsResult` carries `placements` keyed by
`locationName`, not id.

The existing event pipeline doesn't fill the gap either. Every event type it emits
(`item.created`, `stock.adjusted`, `item.low_stock`, …) is derived from new rows in the
`item_history` ledger — they are **inventory-change** events. A read that changed nothing produces
no ledger row, and therefore no event. There is no "query" event class at all.

### Prior art

The "light up the bin holding the part you searched for" pattern is well-established among makers
but consistently **hand-rolled** — it is not a feature of the inventory apps themselves. Binner
lists a smart-bin LED tie-in as a future plan rather than a shipped feature; InvenTree has no
built-in physical locator (and still has an open request for tracking movable containers at all);
the well-known implementations are one-off builds (an LED-per-drawer resistor cabinet, a
laser-turret pointer). Nobody has shipped the generic seam.

That is the opportunity **and** the constraint. Gubbins should ship the *seam* — a location-keyed
lookup event plus readable metadata — and let each user's automation do the physical part. Trying
to ship the physical part itself would mean picking WLED vs. per-bin relays vs. addressable strips
on the user's behalf, which is exactly the sort of device-specific coupling the bridge has avoided
so far.

## Tasks

### A1 — Expose custom-field values over the read API

**The issue's explicit ask.** `field_defs` / `item_field_values` / `location_field_values` are
already in the v1 baseline schema, already synced, already editable in the app — and completely
invisible to any integration. `ItemDetailDto` carries `capabilities` (parametric values) but no
custom-field values; `LocationDto` carries only `id`, `name`, `parentId`, `isSystem`,
`description`, `color`, `itemCount`.

Add custom-field values to both, read-only, resolved through the app's existing effective-value
VIEW (so location-inherited values resolve exactly as they do in the app — never a fork, per
`[[field-dictionary-and-location-inheritance]]`). Gate them behind the existing **field-selection**
layer as an *extended* field (`include=fields`) so default payloads don't bloat and the DTO
contract stays additive-only.

This alone makes `ha_entity: light.bin_42` on a location a thing a user can record in the app and
an integration can read — with **no new schema, no new UI, and no HA-specific concept in the data
model**. Mirror it into the MCP item tools so agent callers see the same shape.

### A2 — A lookup event (`lookup.resolved`)

Give `whereIs` an event emission: when a lookup resolves, publish one event carrying the query, the
matched item ids/names, and — critically — the **resolved location ids** (not just names). Route it
through the existing transport-agnostic event model so it reaches webhooks, SSE and MQTT for free.

Design notes:
- Needs the `WhereIsMatch.placements` shape to carry `locationId` alongside `locationName`. The
  underlying `listStock` already returns it (`item-detail.ts` maps it into `PlacementDto`) — the
  query DTO is just dropping it.
- This is a **read**-triggered event, which is a genuine departure from "events come from the
  ledger". Document that clearly in the README's event section; the dedupe-friendly deterministic
  `id` contract needs a different derivation (there's no ledger row to hash).
- Off by default under its own flag, consistent with every other opt-in surface. A lookup event
  reveals *what someone searched for*, which is a mild privacy step beyond publishing inventory
  state — it should be an explicit choice, not implied by `GUBBINS_BRIDGE_EVENTS=on`.
- Rate-limit / debounce it: voice assistants retry, and a locate automation firing three times
  because the user rephrased is a poor experience.

### A3 — Fire a Home Assistant bus event from the intent handler

With `A2` shipped, make the custom component fire `gubbins_item_located` on the HA event bus from
`GubbinsWhereIsIntent` (in addition to speaking the sentence), carrying the matched item and
resolved location ids. An HA automation then uses a plain **event trigger** to turn on whatever
light the user has mapped — the documented, idiomatic HA pattern for reacting to a custom intent.

Also extend the `gubbins.search` service response with location ids, so a script/dashboard path
exists that doesn't involve voice at all.

Ship a worked example in the integration README: an automation that maps location id → light
entity and flashes it for N seconds. Keep the sample data synthetic.

### A4 — MQTT locate topic

For the no-custom-component path (`GUBBINS_BRIDGE_MQTT_DISCOVERY=on`), publish the `A2` lookup
event to a transient `gubbins/locate` topic. Node-RED and MQTT-trigger automations then get the
same capability without `custom_components/gubbins` installed. Transient, not retained — a late
subscriber must not re-light a bin from a lookup that happened yesterday.

### B1 — Location metadata as MQTT/discovery attributes

Once `A1` exposes location custom fields, surface them as attributes on the per-location MQTT state
payload and the discovery-created `sensor.gubbins_location_<id>`. That lets an HA template read the
mapped entity id straight off the sensor, rather than the user maintaining a parallel mapping table
in YAML.

## Explicitly out of scope

- **Gubbins driving lights, relays or LED strips itself.** The bridge dials *out* and opens no
  inbound port for device control; it should stay a source of facts and events, not a home-automation
  controller. The user's existing automation platform is better at this than we will ever be.
- **A first-class "HA entity id" column on locations or items.** The field dictionary already covers
  it generically, and a dedicated column would bake one integration's vocabulary into the schema —
  the next user wants Node-RED, or MQTT, or a URL.
- **Bridge-side automation rules** ("when X is low, do Y"). That is what the user's automation
  platform is for; the bridge's job is to emit the event cleanly.
- **Inbound device control endpoints.** Widening the bridge's attack surface for a convenience
  feature is a bad trade, and the outbound event model already solves the use case.

## Ongoing

Per the issue, this is **not** a one-shot investigation — it stays open. Append further findings and
task IDs here as the automation surface grows.
