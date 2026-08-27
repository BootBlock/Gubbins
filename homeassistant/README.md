# Gubbins for Home Assistant

Ask your Home Assistant voice assistant **"Where are my M3 screws?"** and hear the answer
from your Gubbins inventory.

This folder documents a small **read-only-by-default** Home Assistant custom integration plus a
no-code YAML fallback. The integration itself lives at the **repository root**
(`custom_components/gubbins/`) so that HACS can install it directly; this folder holds the
voice sentences and this guide. Both talk to the **Gubbins
bridge** — a separate local companion service (see [`../bridge/`](../bridge/README.md))
that exposes a bearer-token-protected HTTP API over an exported Gubbins snapshot.

```
Gubbins PWA → gubbins-sync.json (synced folder) → Gubbins bridge (your hardware)
                                                         │  HTTP, token, LAN-local
                                                         ▼
                                              Home Assistant  ── "Where are my M3 screws?"
```

Nothing leaves your network, and nothing here writes to your inventory unless you deliberately
switch writes on at the bridge — the integration issues `GET` requests for everything except the
five opt-in write services described below, which are inert until then. The bridge is the only
data path.

> **Prerequisite — the bridge must be running first.** Set up and start the bridge as
> described in [`../bridge/README.md`](../bridge/README.md) ("Run the read-only HTTP
> server"). You will need the bridge's **host** and **port**, plus an **API token** minted
> in the Gubbins app (Users → an account → API tokens). If Home Assistant runs on a
> *different* machine from the bridge, start the bridge with `GUBBINS_BRIDGE_HOST=0.0.0.0`
> so HA can reach it over the LAN.

---

## What you get

| Piece | Purpose |
| --- | --- |
| **Conversation intent** `GubbinsWhereIs` | The voice experience — "where are my {item}", "find my {item}", "how many {item} do I have". Speaks the bridge's ready-made sentence back. |
| **Config flow** (UI setup) | Enter host, port and token in the UI. The token is stored by Home Assistant, never in YAML or this repo. A rotated token prompts you to reconnect, a bridge that changes IP is [followed automatically](#if-the-token-is-rotated-or-the-bridge-moves), and *Reconfigure* moves the entry to a new host/port — none of them needs the entry re-added. |
| **`gubbins.search` service** | A read-only search you can call from scripts/automations; returns the matched items as response data. |
| **`gubbins.adjust_quantity` service** | **Opt-in** signed change to a counted item's stock (negative = some went out). Moves a number only — for lending to a named borrower see the loan services below. Only works when the bridge runs with `GUBBINS_BRIDGE_ALLOW_WRITES=on`; the change syncs back to the app conflict-free. |
| **`gubbins.adjust_gauge` service** | **Opt-in** use / refill of a *measured* consumable — grams of filament, millilitres of resin — by a (possibly fractional) signed amount. Same `GUBBINS_BRIDGE_ALLOW_WRITES=on` opt-in, same conflict-free sync back. |
| **`gubbins.transfer_stock` service** | **Opt-in** move of units of a *counted* item between two locations, leaving its total alone — the *where*, not the *how much*. All of it moves or none does. Same `GUBBINS_BRIDGE_ALLOW_WRITES=on` opt-in and stock permission as `adjust_quantity`. |
| **`gubbins.check_out` / `gubbins.check_in` services** | **Opt-in** lending: hand an item to a person, project or place (optionally with a due date) and take it back again. Unlike adjusting a quantity this records *who* has it — which is what the **on loan** and **overdue** sensors report, so an automation can now close the loan it was told about rather than only announcing it. Same `GUBBINS_BRIDGE_ALLOW_WRITES=on` opt-in; the token's account also needs permission to lend. |
| **Inventory-items sensor** | Optional `/health` sensor (item count + snapshot timestamp) for dashboards and "bridge offline" automations. |
| **Attention binary sensors** | One per inventory status — low stock, out of stock, on order, expiring, warranty expiring, on loan, overdue, maintenance due — on whenever anything matches, with the exact figure as a `count` attribute. |

Three ways to install: the **custom integration** (Option A, recommended — gives you the config
flow, the voice intent, the services and the sensors); the **no-code YAML recipe** (Option B — no
`custom_components/`, just the voice intent); or **MQTT discovery** (Option C — no
`custom_components/`, auto-created dashboard sensors via your MQTT broker). All three are documented
below; pick the one that fits your setup.

---

## Option A — the custom integration (recommended)

### 1. Install the files

> **Requires Home Assistant 2025.2 or newer.** The integration is built against current Home
> Assistant config-flow and update-coordinator APIs, so older releases cannot load it. Options
> B and C below are plain Home Assistant configuration and have no such requirement.

**Via HACS (recommended).** The integration lives at the **root** of the Gubbins repository
(`custom_components/gubbins/`, with `hacs.json` alongside it), which is exactly the layout
HACS requires. In HACS, open the menu → **Custom repositories**, add the repository using
its `owner/repo` form — **`BootBlock/Gubbins`** (or the full `https://github.com/BootBlock/Gubbins`
URL) — and choose category **Integration**, then install **Gubbins Inventory** from the list.

> **Note:** point HACS at the *repository*, not a sub-path. A `…/tree/main/homeassistant/…`
> URL is **not** a valid custom repository and produces a *"Repository structure … is not
> compliant"* error — HACS always scans the repository root for
> `custom_components/<domain>/manifest.json`.

**Manual copy (no HACS).** Copy the integration folder from the repository root into your
Home Assistant configuration directory so you end up with:

```
<config>/custom_components/gubbins/      ← copy of custom_components/gubbins/ (repo root)
```

Then restart Home Assistant.

### 2. Add it from the UI

> **Auto-discovery (optional).** If you start the bridge with mDNS advertising enabled
> (`GUBBINS_BRIDGE_MDNS=on`, and LAN-exposed with `GUBBINS_BRIDGE_HOST=0.0.0.0` — see
> [`../bridge/README.md`](../bridge/README.md#mdns--zeroconf-discovery)), Home Assistant
> discovers it automatically: a **Gubbins Inventory** card appears under *Settings → Devices
> & services* with the host/port already filled in. Click **Configure** and you only need to
> enter the **token** (the token is never advertised). The manual steps below still work as a
> fallback — and are required if you keep the bridge on loopback or don't enable mDNS.

1. **Settings → Devices & services → Add integration**.
2. Search for **Gubbins Inventory**.
3. Enter:
   - **Host** — where the bridge runs, e.g. `127.0.0.1` (same machine as HA) or the
     bridge's LAN IP / hostname, e.g. `homeassistant.local` or `192.0.2.10`.
   - **Port** — the bridge port (default `8787`).
   - **Access token** — an API token from Gubbins (Users → an account → API tokens). It is
     shown once when created, so copy it then.
4. The integration calls `GET /health` to verify the connection and token before saving.
   - *"Could not reach the bridge"* → check host/port and that the bridge is running (and
     that it binds `0.0.0.0` if HA is on another machine).
   - *"The bridge did not recognise the token"* → it was mistyped, or it has been revoked in
     the Gubbins app. Create a fresh one and paste that; the bridge needs no restart.

### If the token is rotated, or the bridge moves

Neither case needs the entry deleted and re-added.

- **Rotated or revoked token.** The bridge starts rejecting the stored token, and Home
  Assistant raises a **"Reconfigure/reauthenticate"** notification for the Gubbins entry.
  Mint a fresh API token in Gubbins (Users → an account → API tokens), paste it in, and the
  entry reconnects with its entities and history intact.
- **Bridge picked up a new IP address.** With mDNS advertising on, nothing to do: the entry is keyed
  on the bridge's own [stable id](../bridge/README.md#the-bridges-stable-identity), not on its
  address, so the next advertisement updates the existing entry in place — the entities, their
  history and every automation using them carry on. Home Assistant says *"its existing entry now
  points at the address it answered on"* rather than offering the bridge as a second integration.
- **Bridge moved to a different host or port** (or mDNS is off). Open *Settings → Devices & services
  → Gubbins Inventory → ⋮ → **Reconfigure***, and change the host, port and token together.
  The new details are verified against `GET /health` before they are saved, and the entry
  reloads itself afterwards.

  You have to re-enter the token on this step: Home Assistant never displays a stored
  credential back to you, so there is nothing to pre-fill it with.

  Typing the new address into **Add integration** instead works too — it recognises the bridge and
  corrects the entry you already have rather than adding a duplicate.

> **Upgrading from an older bridge.** An entry added before the bridge reported an identity is still
> keyed on `host:port`; it is re-keyed automatically the first time it connects to an updated bridge.
> Until both sides are updated, an address change still needs *Reconfigure*.

### 3. Wire the voice sentences into Assist

Home Assistant's built-in Assist agent needs to know which spoken phrases map to the
`GubbinsWhereIs` intent. Copy the bundled sentences file into your config:

```
homeassistant/custom_sentences/en/gubbins.yaml
        ↓ copy to
<config>/custom_sentences/en/gubbins.yaml
```

Then **restart Home Assistant**. (You can edit that file to add your own phrasings; the
`{item}` placeholder is a wildcard, so anything the user says after it is sent to the
bridge.)

### 4. Try it

Open **Settings → Voice assistants → (your assistant) → Try it**, or just talk to Assist,
and say one of:

- *"Where are my M3 screws?"*
- *"Where is my ESP32 dev board?"*
- *"How many M3 washers do I have?"*

Assist reads back the bridge's sentence, e.g.
*"Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock."* or, for a multi-location item,
*"Your ESP32 Dev Board is spread across 2 locations: 5 on Shelf 2 and 2 in Bin 4 — 7 in total."*

### 5. (Optional) Use the search service and sensor

**Service** — *Developer Tools → Actions → `gubbins.search`*, or in a script:

```yaml
action: gubbins.search
data:
  query: "ESP32"
  limit: 5
response_variable: result
# result.matches         → [{ id, name, quantity, locationName, mpn, manufacturer }, ...]
# result.location_ids    → ["loc-bin-42", "loc-shelf-2"]   (deduped, every match)
# result.located_matches → [{ item_id, item_name, placements: [
#                            { location_id, location_name, quantity }, ... ] }, ...]
```

`location_ids` and `located_matches` are the same shape the `gubbins_item_located` event
uses (see step 8), so one template works for both the voice path and a script/dashboard
path. A bridge that predates location ids still answers — those fields just come back
empty.

**Sensor** — the integration adds `sensor.gubbins_bridge_inventory_items` (item count), with `ok`
and `snapshot_generated_at` attributes. Use it on a dashboard, or to alert when the bridge stops
responding.

> An entry added before the device name dropped the bridge's address keeps the ids it was given
> (`sensor.gubbins_bridge_<host>_<port>_inventory_items`) — Home Assistant never re-mints an entity
> id, which is what keeps existing automations working. Check *Settings → Devices & services →
> Gubbins Inventory* for the ids your own install has.

**Attention binary sensors** — one per inventory status, alongside the item-count sensor on the
same device: *Low stock*, *Out of stock*, *On order*, *Expiring soon*, *Warranty expiring*,
*On loan*, *Overdue loans* and *Maintenance due*. Each is **on** whenever at least one item
matches, and carries the exact figure as a `count` attribute — so a single entity covers both
"is anything low?" and "how many?":

```yaml
# Notify once more than five things are low.
triggers:
  - trigger: numeric_state
    entity_id: binary_sensor.gubbins_bridge_low_stock
    attribute: count
    above: 5
```

The counts are the same ones the app's own inventory filters show. They refresh on a slow poll
(they only change when the bridge picks up a new snapshot), and a bridge older than this
integration simply leaves these entities unavailable — everything else keeps working.

### 6. (Optional) Change stock — `gubbins.adjust_quantity` / `gubbins.adjust_gauge` / `gubbins.transfer_stock`

These, and the two loan services in step 7, are the **only** services that *change* inventory, and
all of them are **off unless you enable writes on the bridge**. Start the bridge with
`GUBBINS_BRIDGE_ALLOW_WRITES=on` (see
[`../bridge/README.md`](../bridge/README.md#limited-writes-opt-in)); otherwise they return a clear
"writes disabled" error and change nothing.

The first two change **how much** there is, and which you want depends on how the item is tracked:
`adjust_quantity` for something you **count**, `adjust_gauge` for something you **measure**. The
third changes **where** it is.

```yaml
# Something counted: check one out of the drawer.
action: gubbins.adjust_quantity
data:
  item_id: "item-esp32"     # the Gubbins record id (find it via gubbins.search)
  delta: -1                 # negative = check out, positive = check in
  note: "Taken to the workshop"
```

```yaml
# Something measured: record 45 g of filament used.
action: gubbins.adjust_gauge
data:
  item_id: "item-pla-filament"
  delta: -45                # negative = used, positive = refilled; fractions are fine
  note: "Printed the bracket"
```

`adjust_gauge` is the natural pair for a consumable sitting on a smart scale: read the weight in
Home Assistant, send the difference. The app clamps the result between empty and the item's
capacity, and refuses the call if the item isn't gauge-tracked.

```yaml
# Moving, not changing: five come off the shelf and go into the bin.
action: gubbins.transfer_stock
data:
  item_id: "item-esp32"
  from_location_id: "loc-shelf-2"   # location ids come from the app, or GET /api/v1/locations
  to_location_id: "loc-bin-4"
  quantity: 5
```

`transfer_stock` leaves the item's total alone — it moves units between two places, and each moved
lot keeps its batch and expiry at the destination. It applies to **counted** items only: a gauge
measures one body of material, so there is nothing to split across locations and the call is
refused. Two `adjust_quantity` calls are **not** a substitute either: that service only ever
touches the item's own location, so it has no way to name the two ends of a move. The whole amount
moves or none of it does; too little at the source is an error rather than a partial transfer, so
an automation is never left half-done.

The bridge applies any of these through the app's own mutation and writes it back into the synced
`gubbins-sync.json`, so the PWA merges it conflict-free on its next sync — no bespoke database
write, no drift. (Writes are deliberately **not** wired into the voice intent; a voice
"check out" automation can call these services explicitly.)

#### Retrying a write safely — `idempotency_key`

Every write service takes an optional `idempotency_key`, and an automation that has an error
branch should use it. All five of them make a **relative** change — a delta, a move, a loan — so
calling one twice applies it twice; the number drifts and the item's history shows two entries for
one real event.

That is not hypothetical, because a bridge write costs work proportional to the size of the whole
inventory rather than the size of the change. On a large one it can take longer than this
integration waits, and the bridge finishes the write regardless of whether anyone is still
listening. So a call that reports a timeout has very likely **already been applied** — and running
it again is exactly the wrong response.

```yaml
# A scale reports what was used. The key is minted ONCE, as a variable...
- variables:
    attempt_key: "filament-{{ now().timestamp() | int }}"
- action: gubbins.adjust_gauge
  data:
    item_id: "item-pla-filament"
    delta: -45
    idempotency_key: "{{ attempt_key }}"    # ...and the same variable is used here...
  continue_on_error: true
- action: gubbins.adjust_gauge              # ...and again here, by the retry.
  data:
    item_id: "item-pla-filament"
    delta: -45
    idempotency_key: "{{ attempt_key }}"
```

Give a **fresh** value for each intended change and reuse that same value only when repeating that
change — which means minting it *outside* the call, as a variable, so the retry can refer to the
same one. (Building the key inline would produce a new value on the second call, protecting
nothing.) The bridge then replies with the first attempt's result instead of applying anything
again. Leave the field out and behaviour is unchanged — every call applies.

A write that does time out now reports so plainly, and says the change may already have landed,
rather than reading as "could not reach the bridge". A bridge older than this feature ignores the
key, so passing one is always safe.

### 7. (Optional) Lend and return — `gubbins.check_out` / `gubbins.check_in`

Adjusting a quantity moves a number. A **loan** records *who* has the item and when it is due —
which is what the **on loan** and **overdue** binary sensors from step 5 are counting, and what
Gubbins publishes to a calendar. Without these two, an automation could be told a loan was overdue
and had no way to close it; now it can do both ends.

Same `GUBBINS_BRIDGE_ALLOW_WRITES=on` opt-in as step 6. The token's account additionally needs
permission to **lend** (`checkouts:write`) rather than only to adjust stock — the same line the app
draws between the two.

```yaml
# Lend two to a person, due back on a given day.
action: gubbins.check_out
data:
  item_id: "item-esp32"        # the Gubbins record id (find it via gubbins.search)
  contact_name: "Sam Okafor"   # created if nobody of that name exists yet
  quantity: 2
  due_date: "2026-08-14"       # optional; omit for an open-ended loan
  note: "For the bench build"
```

Supply **exactly one** borrower: `contact_name`, `contact_id`, `project_id` (out on a job) or
`location_id` (out in the van). Anything else comes back as a clear rejection.

```yaml
# It's back. With one loan open, the item id is all you need.
action: gubbins.check_in
data:
  item_id: "item-esp32"
  note: "Back on the shelf"
```

The stock returns to the exact place — and lot — it was lent from. Pass `checkout_id` only when the
item is out on more than one loan at once and you need to say which one came back; `check_out`
returns the loan (use `response_variable`) if you want to keep its id.

```yaml
# The whole round trip: a button hands the meter to whoever's on shift.
actions:
  - action: gubbins.check_out
    data:
      item_id: "item-multimeter"
      contact_name: "{{ states('input_text.on_shift') }}"
      due_date: "{{ (now() + timedelta(days=7)).date() }}"
    response_variable: loan
  - action: notify.persistent_notification
    data:
      # dueDate is UNIX *milliseconds*, and is null on an open-ended loan.
      message: >-
        Multimeter lent out{% if loan.checkout.dueDate %}, due
        {{ (loan.checkout.dueDate / 1000) | timestamp_custom('%d %b') }}{% endif %}.
```

> A due date is a **day**, not a moment: a loan due the 20th only counts as overdue once the 20th
> has ended where you are. A day that doesn't exist (31 February) is refused rather than quietly
> shifted.

**Chasing an overdue loan.** The **overdue** binary sensor from step 5 is what to trigger on.
Gubbins also publishes loan due-backs to a
[calendar feed](../bridge/README.md#calendar-subscription), and that event *does* name the loan —
but only inside its `UID`, and Home Assistant's calendar triggers expose an event's summary,
description and times, never the `UID`. So neither route hands your automation a loan to close: the
sensor reports a count and the calendar event a name.

That is usually fine, because `check_in` needs only the `item_id` — which an automation that did
the lending already holds, and which `gubbins.search` can find otherwise. Trigger on the sensor for
"something is late", and keep the item you care about in the automation itself.

### 8. (Optional) React to a lookup — the `gubbins_item_located` event

Every time a voice lookup **resolves to at least one item**, the integration fires
`gubbins_item_located` on the Home Assistant event bus, in addition to speaking the answer.
An automation can then use a plain **event trigger** to do something physical — the usual
example being to flash the light above the bin the item is in.

The event is *not* fired when the lookup matched nothing, or when the bridge couldn't be
reached, so an automation triggered on it always has somewhere to point at. Speech always
wins: if the event can't be fired for any reason it is logged and ignored, and the spoken
answer is unaffected.

**Event data**

| Field | Type | Meaning |
| --- | --- | --- |
| `query` | string | What the user asked for (the `{item}` slot, verbatim). |
| `item_ids` | list of string | Gubbins record id of every matched item. |
| `location_ids` | list of string | Every resolved location id, flattened and deduped. |
| `matches` | list | One entry per item: `item_id`, `item_name`, and `placements`. |
| `matches[].placements` | list | `location_id`, `location_name`, `quantity` per place the item sits. |

```yaml
# Example event data (synthetic)
query: "ESP32"
item_ids: ["item-esp32"]
location_ids: ["loc-bin-42", "loc-shelf-2"]
matches:
  - item_id: "item-esp32"
    item_name: "ESP32 Dev Board"
    placements:
      - location_id: "loc-bin-42"
        location_name: "Bin 42"
        quantity: 5
      - location_id: "loc-shelf-2"
        location_name: "Shelf 2"
        quantity: 2
```

> **ℹ️ Note** — `location_id` needs a bridge that reports location ids. An older bridge
> sends only names, in which case `location_ids` is empty and `location_name` still works
> (you can map on the name instead, at the cost of a rename breaking the mapping).

**Worked example — flash the light above the bin**

Keep one plain YAML dictionary mapping a Gubbins location id to the light entity above it,
then flash whichever lights the lookup resolved to. To extend it, add a line to `bin_lights`
— nothing else changes. (All ids and entities below are made up; use your own.)

```yaml
alias: "Gubbins — flash the bin a located item is in"
mode: restart
triggers:
  - trigger: event
    event_type: gubbins_item_located
variables:
  # Gubbins location id → the light entity above that location.
  bin_lights:
    loc-bin-42: light.bin_42
    loc-shelf-2: light.shelf_2
    loc-drawer-a: light.drawer_a
  flash_seconds: 20
  # The lights matching the locations this lookup resolved to.
  lights: >-
    {%- set ns = namespace(found=[]) -%}
    {%- for loc in trigger.event.data.location_ids -%}
      {%- if loc in bin_lights -%}
        {%- set ns.found = ns.found + [bin_lights[loc]] -%}
      {%- endif -%}
    {%- endfor -%}
    {{ ns.found }}
conditions:
  - condition: template
    value_template: "{{ lights | count > 0 }}"
actions:
  - action: light.turn_on
    target:
      entity_id: "{{ lights }}"
  - delay:
      seconds: "{{ flash_seconds }}"
  - action: light.turn_off
    target:
      entity_id: "{{ lights }}"
```

Say *"where is my ESP32 dev board?"* and Assist reads the answer back **and** the light above
Bin 42 flashes for 20 seconds. `mode: restart` means a second lookup while the first is still
lit restarts the timer rather than queueing.

> **💡 Tip** — if you'd rather not maintain the mapping in YAML, an entity named after the
> location (`light.<location_name | slugify>`) works too:
> `{{ trigger.event.data.matches[0].placements[0].location_name | slugify }}`.

---

## Option B — no-code YAML recipe (no custom_components)

If you'd rather not install a custom integration, you can get the **voice intent** alone
with a `rest_command` + `intent_script`. This has no config-flow UI, so the token lives in
your (private, never-committed) `secrets.yaml`.

**1. `secrets.yaml`** (this file is local to your HA install — never commit it). Store the
whole header value so the word `Bearer` stays out of `configuration.yaml`:

```yaml
gubbins_bridge_token_header: "Bearer <YOUR_TOKEN>"
```

**2. `configuration.yaml`:**

```yaml
rest_command:
  gubbins_where_is:
    url: "http://127.0.0.1:8787/where?q={{ item | urlencode }}"
    method: GET
    headers:
      Authorization: !secret gubbins_bridge_token_header
    timeout: 10

intent_script:
  GubbinsWhereIs:
    action:
      - service: rest_command.gubbins_where_is
        data:
          item: "{{ item }}"
        response_variable: action_response
    speech:
      text: >
        {% if action_response is defined and action_response.content is defined
              and action_response.content.spoken is defined %}
          {{ action_response.content.spoken }}
        {% else %}
          Sorry, I couldn't reach the Gubbins inventory bridge just now.
        {% endif %}
```

**3. Sentences** — copy `custom_sentences/en/gubbins.yaml` to
`<config>/custom_sentences/en/gubbins.yaml` exactly as in Option A, step 3, then restart.

The custom integration (Option A) is recommended because it keeps the token in HA's
encrypted entry store (out of YAML entirely), adds graceful typed error handling, and gives
you the service and sensor too.

---

## Option C — MQTT discovery (no custom_components, auto-created entities)

If you already run an MQTT broker with Home Assistant (the Mosquitto add-on is the common
setup), the bridge can publish straight to it and let HA **auto-create the entities** — **no
`custom_components/gubbins` at all**. This is an *alternative* to Option A, not an addition:
pick one. Option A gives you the **voice intent** and the read/write **services**; Option C
gives you **auto-discovered dashboard sensors** with zero HA-side YAML. (You can run both if
you want the voice experience *and* the MQTT sensors, but you don't need to.)

**1. Point the bridge at your broker** (in the bridge's git-ignored `.env` — see
[`bridge/README.md` → MQTT publishing](../bridge/README.md#mqtt-publishing-opt-in)):

```bash
GUBBINS_BRIDGE_MQTT=on
GUBBINS_BRIDGE_MQTT_URL=mqtt://127.0.0.1:1883        # your broker
GUBBINS_BRIDGE_MQTT_USERNAME=<YOUR_MQTT_USERNAME>    # optional
GUBBINS_BRIDGE_MQTT_PASSWORD=<YOUR_MQTT_PASSWORD>    # optional; .env only
GUBBINS_BRIDGE_MQTT_DISCOVERY=on                     # publish HA discovery configs
```

**2. Restart the bridge.** With the MQTT integration configured in Home Assistant, a
"**Gubbins**" device appears automatically under *Settings → Devices & services → MQTT*, with:

- `sensor.gubbins_items_total`, `sensor.gubbins_low_stock_items`,
  `sensor.gubbins_out_of_stock_items`, `sensor.gubbins_locations_total`;
- `binary_sensor.gubbins_low_stock` (problem class — `on` whenever anything is low);
- one `sensor.gubbins_location_<id>` per user location (its live item count).

All of these track the bridge's retained state topics and go **unavailable** if the bridge
stops (an MQTT Last-Will flips `gubbins/status` to `offline`). The exact topics/payloads and
the `GUBBINS_BRIDGE_MQTT_*` variables are documented in
[`bridge/README.md`](../bridge/README.md#mqtt-publishing-opt-in). Nothing here needs the bridge's
bearer token — MQTT auth is your broker's username/password, kept in the bridge `.env` only.

---

## A dashboard sensor without the integration (REST sensor)

Prefer a plain REST sensor for a dashboard card? This works whether or not the integration
is installed:

```yaml
# configuration.yaml
sensor:
  - platform: rest
    name: Gubbins inventory items
    resource: "http://127.0.0.1:8787/health"
    headers:
      Authorization: !secret gubbins_bridge_token_header
    value_template: "{{ value_json.itemCount }}"
    json_attributes:
      - snapshotGeneratedAt
      - ok
    scan_interval: 300
```

---

## Manual test recipe

Home Assistant integrations aren't unit-tested in this repo (no HA test harness here), so
verify end-to-end against a snapshot of your own:

1. **Mint a token and start the bridge against your synced snapshot** (loopback).

   The bridge identifies callers by API tokens that live in your data, so it needs a snapshot
   containing one. Create a token in the app first (Users → an account → API tokens) and let
   it sync, then point the bridge at that snapshot. The committed synthetic fixture carries no
   tokens, so a bridge serving it answers `401` to everything by design.

   ```bash
   # from the repo root
   GUBBINS_SNAPSHOT_PATH=/path/to/your/gubbins-sync.json \
   node bridge/serve.mjs
   ```

   Export `TOKEN=<the token you created>` in your shell so the commands below can use it.

2. **Sanity-check the API** the integration will call, using an item you know is there:

   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
     "http://127.0.0.1:8787/where?q=<something%20in%20your%20inventory>"
   # → { "query": "…", "matches": [...], "spoken": "Your … is in … — N in stock." }
   ```

3. **Configure the integration** (Option A) with host `127.0.0.1`, port `8787`, and the token
   you created. The form should save without error (this exercises `/health` + auth).

4. **Wire the sentences** (copy `custom_sentences/en/gubbins.yaml`, restart HA).

5. **Ask Assist** *"Where are my …?"* for something in your inventory — you should hear the
   bridge's sentence back, e.g. *"Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock."* Ask
   about an item stocked in two places for the multi-location phrasing.

6. **Failure paths** (should speak a friendly line, never a stack trace):
   - Stop the bridge, ask again → *"Sorry, I couldn't reach the Gubbins inventory bridge
     just now."*
   - Revoke the token in Gubbins (Users → the account → API tokens), let it sync, and ask
     again → *"Sorry, the Gubbins inventory bridge rejected my access token…"*

7. **(Optional) Writes — `gubbins.adjust_quantity` / `gubbins.adjust_gauge`.** Copy the snapshot
   somewhere writable and restart the bridge with writes enabled (so the original stays
   unmodified):

   ```bash
   cp /path/to/your/gubbins-sync.json /tmp/gubbins-sync.json
   GUBBINS_SNAPSHOT_PATH=/tmp/gubbins-sync.json \
   GUBBINS_BRIDGE_ALLOW_WRITES=on \
   node bridge/serve.mjs
   ```

   Then call *Developer Tools → Actions → `gubbins.adjust_quantity`* with the `item_id` of a
   discrete item and `delta: -2`. Its quantity drops by two (re-run the `where` curl to
   confirm), `/tmp/gubbins-sync.json` gains a `QUANTITY_CHANGE` activity-log entry, and that
   entry is attributed to **the account whose token you used**. Repeat with
   `gubbins.adjust_gauge` against a measured consumable — its gauge drops by the amount you
   send, and calling it against a *counted* item is refused with a clear message rather than
   silently doing something else. With writes **off** (the default), both services error with
   *"The Gubbins bridge has writes disabled…"* and nothing changes.

8. **(Optional) Loans — `gubbins.check_out` / `gubbins.check_in`.** With the same
   writes-enabled bridge running, call *Developer Tools → Actions → `gubbins.check_out`* with a
   discrete `item_id`, `contact_name: Test Borrower` and `quantity: 1`. The item's quantity drops
   by one, the **on loan** binary sensor turns on at its next refresh, and the response (tick
   *"Return response data"*) carries the loan with its id. Call `gubbins.check_in` with just the
   same `item_id` — the quantity comes back and the loan closes. Calling `check_in` again is
   refused with *"This item is not currently checked out."*, and a `check_out` with no borrower
   at all is refused with *"A checkout needs a borrower…"* — both the app's own wording, so the
   reason is the same one you would see in Gubbins itself.

9. **(Optional) Moving stock — `gubbins.transfer_stock`.** Pick an item that sits in two places
   (its `placements` in `GET /api/v1/items/<id>` show the split) and call
   *Developer Tools → Actions → `gubbins.transfer_stock`* with both location ids and a quantity
   the source actually holds. The response's `placements` show the units on the other side and the
   item's total unchanged. Ask for more than the source holds and it is refused with *"Not enough
   stock at the source location to transfer…"* — and nothing moves, so a failed transfer never
   leaves stock split in a way you didn't ask for.

> Use only synthetic/test values when following this recipe. The example token above is a
> throwaway for local testing — generate a long random token for real use, and never commit
> it.

### Verifying auto-discovery (optional)

To exercise the mDNS / zeroconf path end-to-end (HA isn't unit-testable here):

1. **Start the bridge LAN-exposed with mDNS on** (Home Assistant must be on the same LAN
   subnet — mDNS is link-local and does not cross routed networks):

   ```bash
   GUBBINS_SNAPSHOT_PATH=bridge/src/fixtures/synthetic-snapshot.json \
   GUBBINS_BRIDGE_HOST=0.0.0.0 \
   GUBBINS_BRIDGE_MDNS=on \
   node bridge/serve.mjs
   # logs: mDNS advertising "Gubbins Bridge" on 224.0.0.251:5353.
   ```

2. *(Optional)* confirm the advertisement from another machine on the LAN — e.g.
   `avahi-browse -r _gubbins._tcp` (Linux) or `dns-sd -B _gubbins._tcp` (macOS). You should
   see the `Gubbins Bridge` instance with a TXT record of `path=/api/v1`, `api=v1`,
   `version=…`, `id=…` (the bridge's
   [stable id](../bridge/README.md#the-bridges-stable-identity)) — and **no token**.

3. In Home Assistant, open **Settings → Devices & services**. Within a minute a **Gubbins
   Inventory** discovered card should appear. Click **Configure**; the host/port are
   pre-filled — enter the token you minted in Gubbins to finish.

> If no card appears, mDNS is likely blocked between the two hosts (VLAN, Wi-Fi client
> isolation, or HA OS without the discovery add-on). Fall back to **Add integration →
> Gubbins Inventory** and type the host/port manually — the result is identical.

---

## Security & privacy

- **Read-only by default; five opt-in writes.** The integration issues `GET` requests for every
  read. The only exceptions are `gubbins.adjust_quantity`, `gubbins.adjust_gauge`,
  `gubbins.transfer_stock`, `gubbins.check_out` and `gubbins.check_in`, which work only when *you*
  start the bridge with `GUBBINS_BRIDGE_ALLOW_WRITES=on`; even then the bridge applies the change
  through the app's own mutation and syncs it back conflict-free — no SQL is string-built. With
  writes off (the default) all five error and change nothing. Nothing can be renamed or deleted through any of them; the
  one thing they can *create* is a contact, when you lend to a name that matches nobody — exactly
  as lending in the app would.
- **Your token stays yours.** With the custom integration the token is stored in Home
  Assistant's config-entry store (entered in the UI), never in YAML or this repository.
  With the YAML recipe it lives in your local `secrets.yaml`, which you must not commit.
- **Local-first.** Everything runs on your own hardware on your own network; there is no
  cloud relay. Keep the bridge bound to `127.0.0.1` unless you deliberately need LAN access.
- **No third-party Python dependencies.** The integration uses only Home Assistant's
  built-ins (`aiohttp` via HA's shared session, `voluptuous`), so there is no extra
  supply-chain surface.

---

## Files

HACS requires the integration and its `hacs.json` at the **repository root**, so they live
there; the voice sentences and this guide stay under `homeassistant/`.

```
(repository root)
  hacs.json                                  # HACS metadata (must be at the repo root)
  custom_components/gubbins/                 # the integration (must be at the repo root)
    manifest.json                            # integration metadata (HACS-compatible)
    const.py                                 # domain + config keys
    api.py                                   # thin HTTP client (reads + the opt-in writes)
    bridge_id.py                             # how a bridge is identified: its stable id, never its address
    __init__.py                              # setup: client, coordinators, intent, gubbins.search + the write services
    coordinator.py                           # /health and /api/v1/status polling coordinators (health drives reauth when the token is rejected)
    config_flow.py                           # UI config flow: manual host/port/token, zeroconf discovery, reauth + reconfigure (all verify /health)
    intent.py                                # GubbinsWhereIs conversation intent handler
    entity.py                                # the shared device descriptor every entity belongs to
    sensor.py                                # optional /health item-count sensor
    binary_sensor.py                         # one attention binary sensor per inventory status
    services.yaml                            # schemas for gubbins.search and the five write services
    strings.json / translations/en.json      # UI text

homeassistant/
  custom_sentences/en/gubbins.yaml           # voice sentences → copy to <config>/custom_sentences/en/
  README.md                                  # this file
```
