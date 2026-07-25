"""Constants for the Gubbins inventory bridge integration."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "gubbins"

# Config-entry keys. The token is stored by Home Assistant (in its config entry
# store) — it is entered in the UI config flow and never written to YAML or this repo.
CONF_HOST = "host"
CONF_PORT = "port"
CONF_TOKEN = "token"

DEFAULT_PORT = 8787

# The conversation intent the bridge answers. Sentences that trigger it live in
# custom_sentences/en/gubbins.yaml (copied into the user's HA config directory).
INTENT_WHERE_IS = "GubbinsWhereIs"

# Fired on the Home Assistant event bus whenever a voice lookup resolves to at least one
# item, so an automation can react with a plain event trigger (flash the bin's light, …).
# It is never fired for a lookup that matched nothing. See homeassistant/README.md.
EVENT_ITEM_LOCATED = "gubbins_item_located"

# Service that exposes a raw search to automations/dashboards.
SERVICE_SEARCH = "search"

# Optional write service (check-in / check-out). It only works when the bridge itself is
# started with GUBBINS_BRIDGE_ALLOW_WRITES=on; otherwise the bridge returns 404 and this
# surfaces a friendly error. Off at the bridge by default — see bridge/README.md.
SERVICE_ADJUST_QUANTITY = "adjust_quantity"

# The same opt-in write, for the other tracking mode: a signed change to a consumable's
# gauge (its measured contents — grams of filament, millilitres of resin) rather than to a
# discrete count. Gated on exactly the same GUBBINS_BRIDGE_ALLOW_WRITES=on opt-in.
SERVICE_ADJUST_GAUGE = "adjust_gauge"

# How often the optional /health sensor polls the bridge.
HEALTH_SCAN_INTERVAL = timedelta(minutes=5)

# How often the attention binary sensors poll the bridge. Slower than /health: these counts
# come from a scan of the inventory rather than a liveness check, and "something is low"
# does not need minute-level freshness — a stock change reaches the bridge on the next sync
# anyway, so polling faster than that would only re-read the same snapshot.
STATUS_SCAN_INTERVAL = timedelta(minutes=15)
