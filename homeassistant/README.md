# Gubbins for Home Assistant

Ask your Home Assistant voice assistant **"Where are my M3 screws?"** and hear the answer
from your Gubbins inventory.

This folder contains a small, **read-only** Home Assistant custom integration
(`custom_components/gubbins/`) plus a no-code YAML fallback. Both talk to the **Gubbins
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
> server"). You will need the **host**, **port** and **`GUBBINS_BRIDGE_TOKEN`** you
> configured there. If Home Assistant runs on a *different* machine from the bridge, start
> the bridge with `GUBBINS_BRIDGE_HOST=0.0.0.0` so HA can reach it over the LAN.

---

## What you get

| Piece | Purpose |
| --- | --- |
| **Conversation intent** `GubbinsWhereIs` | The voice experience — "where are my {item}", "find my {item}", "how many {item} do I have". Speaks the bridge's ready-made sentence back. |
| **Config flow** (UI setup) | Enter host, port and token in the UI. The token is stored by Home Assistant, never in YAML or this repo. |
| **`gubbins.search` service** | A read-only search you can call from scripts/automations; returns the matched items as response data. |
| **`gubbins.adjust_quantity` service** | **Opt-in** check-in / check-out (negative delta = check out). Only works when the bridge runs with `GUBBINS_BRIDGE_ALLOW_WRITES=on`; the change syncs back to the app conflict-free. |
| **Inventory-items sensor** | Optional `/health` sensor (item count + snapshot timestamp) for dashboards and "bridge offline" automations. |

Two ways to install: the **custom integration** (recommended — gives you the config flow,
the service and the sensor) or the **no-code YAML recipe** (no `custom_components/`, just
the voice intent). Both are documented below.

---

## Option A — the custom integration (recommended)

### 1. Install the files

**Manual copy (simplest, always works).** Copy the integration into your Home Assistant
configuration directory so you end up with:

```
<config>/custom_components/gubbins/      ← copy of homeassistant/custom_components/gubbins/
```

Then restart Home Assistant.

**Via HACS (optional).** This integration lives in a sub-folder of the main Gubbins repo
rather than at its root, so the simplest path is the manual copy above. If you prefer HACS,
add this repository as a **Custom repository** (category: *Integration*) and install from
there; the integration's `manifest.json` and `hacs.json` meet HACS's requirements.

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
   - **Access token** — your `GUBBINS_BRIDGE_TOKEN`.
4. The integration calls `GET /health` to verify the connection and token before saving.
   - *"Could not reach the bridge"* → check host/port and that the bridge is running (and
     that it binds `0.0.0.0` if HA is on another machine).
   - *"The bridge rejected the token"* → the token doesn't match `GUBBINS_BRIDGE_TOKEN`.

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
# result.matches → [{ id, name, quantity, locationName, mpn, manufacturer }, ...]
```

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

---

## Option B — no-code YAML recipe (no custom_components)

If you'd rather not install a custom integration, you can get the **voice intent** alone
with a `rest_command` + `intent_script`. This has no config-flow UI, so the token lives in
your (private, never-committed) `secrets.yaml`.

**1. `secrets.yaml`** (this file is local to your HA install — never commit it). Store the
whole header value so the word `Bearer` stays out of `configuration.yaml`:

```yaml
gubbins_bridge_token_header: "Bearer replace-with-your-GUBBINS_BRIDGE_TOKEN"
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
verify end-to-end against the **synthetic fixture** that ships with the bridge:

1. **Start the bridge against the fixture** (loopback, with a throwaway token):

   ```bash
   # from the repo root; the fixture has only made-up parts
   GUBBINS_BRIDGE_TOKEN=test-token-123 \
   GUBBINS_SNAPSHOT_PATH=bridge/src/fixtures/synthetic-snapshot.json \
   node bridge/serve.mjs
   ```

2. **Sanity-check the API** the integration will call (the fixture has made-up parts —
   `M3 x 10 Hex Bolt`, `M3 Nylon Washer`, a multi-location `ESP32 Dev Board`):

   ```bash
   curl -H "Authorization: Bearer test-token-123" \
     "http://127.0.0.1:8787/where?q=M3%20bolt"
   # → { "query": "M3 bolt", "matches": [...], "spoken": "Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock." }
   ```

3. **Configure the integration** (Option A) with host `127.0.0.1`, port `8787`, token
   `test-token-123`. The form should save without error (this exercises `/health` + auth).

4. **Wire the sentences** (copy `custom_sentences/en/gubbins.yaml`, restart HA).

5. **Ask Assist** *"Where are my M3 bolt?"* (or *"Where is my M3 bolt?"*) — you should hear
   *"Your M3 x 10 Hex Bolt is in Drawer A — 42 in stock."* Try *"Where is my ESP32 dev
   board?"* for the multi-location phrasing.

6. **Failure paths** (should speak a friendly line, never a stack trace):
   - Stop the bridge, ask again → *"Sorry, I couldn't reach the Gubbins inventory bridge
     just now."*
   - Restart the bridge with a different `GUBBINS_BRIDGE_TOKEN` (don't update HA) and ask
     again → *"Sorry, the Gubbins inventory bridge rejected my access token…"*

7. **(Optional) Writes — `gubbins.adjust_quantity`.** Copy the fixture somewhere writable and
   restart the bridge with writes enabled (the fixture in the repo should stay unmodified):

   ```bash
   cp bridge/src/fixtures/synthetic-snapshot.json /tmp/gubbins-sync.json
   GUBBINS_BRIDGE_TOKEN=test-token-123 \
   GUBBINS_SNAPSHOT_PATH=/tmp/gubbins-sync.json \
   GUBBINS_BRIDGE_ALLOW_WRITES=on \
   node bridge/serve.mjs
   ```

   Then call *Developer Tools → Actions → `gubbins.adjust_quantity`* with `item_id: item-m3-bolt`,
   `delta: -2`. The quantity drops from 42 to 40 (re-run the `where` curl to confirm), and
   `/tmp/gubbins-sync.json` gains a `QUANTITY_CHANGE` activity-log entry. With writes **off** (the
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
   GUBBINS_BRIDGE_TOKEN=test-token-123 \
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
   pre-filled — enter the token (`test-token-123` for this fixture) to finish.

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

```
homeassistant/
  hacs.json                                  # HACS metadata (custom-repository install)
  custom_sentences/en/gubbins.yaml           # voice sentences → copy to <config>/custom_sentences/en/
  custom_components/gubbins/
    manifest.json                            # integration metadata (HACS-compatible)
    const.py                                 # domain + config keys
    api.py                                   # thin HTTP client (read-only + the opt-in adjust_quantity write)
    __init__.py                              # setup: client, intent, gubbins.search + gubbins.adjust_quantity services
    config_flow.py                           # UI config flow: manual host/port/token + zeroconf auto-discovery (verifies /health)
    intent.py                                # GubbinsWhereIs conversation intent handler
    sensor.py                                # optional /health item-count sensor
    services.yaml                            # gubbins.search + gubbins.adjust_quantity schemas
    strings.json / translations/en.json      # UI text
  README.md                                  # this file
```
