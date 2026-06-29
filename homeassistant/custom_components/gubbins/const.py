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

# Service that exposes a raw search to automations/dashboards.
SERVICE_SEARCH = "search"

# Optional write service (check-in / check-out). It only works when the bridge itself is
# started with GUBBINS_BRIDGE_ALLOW_WRITES=on; otherwise the bridge returns 404 and this
# surfaces a friendly error. Off at the bridge by default — see bridge/README.md.
SERVICE_ADJUST_QUANTITY = "adjust_quantity"

# How often the optional /health sensor polls the bridge.
HEALTH_SCAN_INTERVAL = timedelta(minutes=5)
