# Gubbins for Home Assistant

Ask your Home Assistant voice assistant **"Where are my M3 screws?"** and hear the answer
from your Gubbins inventory.

This folder documents a small, **read-only** Home Assistant custom integration plus a
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

Nothing here ever writes to your inventory, and nothing leaves your network. The bridge is
the only data path; this integration only issues `GET` requests.

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
| **Config flow** (UI setup) | Enter host, port and token in the UI. The token is stored by Home Assistant, never in YAML or this repo. |
| **`gubbins.search` service** | A read-only search you can call from scripts/automations; returns the matched items as response data. |
| **`gubbins.adjust_quantity` service** | **Opt-in** check-in / check-out (negative delta = check out). Only works when the bridge runs with `GUBBINS_BRIDGE_ALLOW_WRITES=on`; the change syncs back to the app conflict-free. |
| **Inventory-items sensor** | Optional `/health` sensor (item count + snapshot timestamp) for dashboards and "bridge offline" automations. |

Three ways to install: the **custom integration** (Option A, recommended — gives you the config
flow, the voice intent, the service and the sensor); the **no-code YAML recipe** (Option B — no
`custom_components/`, just the voice intent); or **MQTT discovery** (Option C — no
`custom_components/`, auto-created dashboard sensors via your MQTT broker). All three are documented
below; pick the one that fits your setup.

---

## Option A — the custom integration (recommended)

### 1. Install the files

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
uses (see step 7), so one template works for both the voice path and a script/dashboard
path. A bridge that predates location ids still answers — those fields just come back
empty.

**Sensor** — the integration adds `sensor.gubbins_bridge_<host>_<port>_inventory_items`
(item count), with `ok` and `snapshot_generated_at` attributes. Use it on a dashboard, or
to alert when the bridge stops responding.

### 6. (Optional) Check stock in / out — `gubbins.adjust_quantity`

This is the **only** service that *changes* inventory, and it is **off unless you enable writes
on the bridge**. Start the bridge with `GUBBINS_BRIDGE_ALLOW_WRITES=on` (see
[`../bridge/README.md`](../bridge/README.md#limited-writes-opt-in)); otherwise this service
returns a clear "writes disabled" error and changes nothing.

```yaml
action: gubbins.adjust_quantity
data:
  item_id: "item-esp32"     # the Gubbins record id (find it via gubbins.search)
  delta: -1                 # negative = check out, positive = check in
  note: "Taken to the workshop"
```

The bridge applies the change through the app's own mutation and writes it back into the synced
`gubbins-sync.json`, so the PWA merges it conflict-free on its next sync — no bespoke database
write, no drift. (Writes are deliberately **not** wired into the voice intent or MCP; a voice
"check out" automation can call this service explicitly.)

### 7. (Optional) React to a lookup — the `gubbins_item_located` event

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

7. **(Optional) Writes — `gubbins.adjust_quantity`.** Copy the snapshot somewhere writable and
   restart the bridge with writes enabled (so the original stays unmodified):

   ```bash
   cp /path/to/your/gubbins-sync.json /tmp/gubbins-sync.json
   GUBBINS_SNAPSHOT_PATH=/tmp/gubbins-sync.json \
   GUBBINS_BRIDGE_ALLOW_WRITES=on \
   node bridge/serve.mjs
   ```

   Then call *Developer Tools → Actions → `gubbins.adjust_quantity`* with the `item_id` of a
   discrete item and `delta: -2`. Its quantity drops by two (re-run the `where` curl to
   confirm), `/tmp/gubbins-sync.json` gains a `QUANTITY_CHANGE` activity-log entry, and that
   entry is attributed to **the account whose token you used**. With writes **off** (the
   default), the service errors with *"The Gubbins bridge has writes disabled…"* and nothing
   changes.

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
   `version=…` — and **no token**.

3. In Home Assistant, open **Settings → Devices & services**. Within a minute a **Gubbins
   Inventory** discovered card should appear. Click **Configure**; the host/port are
   pre-filled — enter the token you minted in Gubbins to finish.

> If no card appears, mDNS is likely blocked between the two hosts (VLAN, Wi-Fi client
> isolation, or HA OS without the discovery add-on). Fall back to **Add integration →
> Gubbins Inventory** and type the host/port manually — the result is identical.

---

## Security & privacy

- **Read-only by default; one opt-in write.** The integration issues `GET` requests for every
  read. The single exception is `gubbins.adjust_quantity`, which only works when *you* start the
  bridge with `GUBBINS_BRIDGE_ALLOW_WRITES=on`; even then the bridge applies the change through
  the app's own mutation and syncs it back conflict-free — no SQL is string-built. With writes
  off (the default) the service errors and changes nothing.
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
    api.py                                   # thin HTTP client (read-only + the opt-in adjust_quantity write)
    __init__.py                              # setup: client, intent, gubbins.search + gubbins.adjust_quantity services
    config_flow.py                           # UI config flow: manual host/port/token + zeroconf auto-discovery (verifies /health)
    intent.py                                # GubbinsWhereIs conversation intent handler
    sensor.py                                # optional /health item-count sensor
    services.yaml                            # gubbins.search + gubbins.adjust_quantity schemas
    strings.json / translations/en.json      # UI text

homeassistant/
  custom_sentences/en/gubbins.yaml           # voice sentences → copy to <config>/custom_sentences/en/
  README.md                                  # this file
```
