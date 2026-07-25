"""The Gubbins inventory bridge integration.

A Home Assistant integration that talks to the local Gubbins **bridge** — a companion service
that exposes a bearer-token-protected HTTP API over an exported Gubbins inventory snapshot.
The bridge is the only data path. Everything here reads, apart from the two opt-in stock-write
services below, which do nothing unless the bridge itself was started with writes enabled.

Setup wires six things:
  * a per-entry :class:`GubbinsClient` (read-only HTTP client) into ``hass.data``;
  * a per-entry :class:`GubbinsRuntimeData` into ``entry.runtime_data``, holding the health
    coordinator — first-refreshed here so an unreachable bridge or a revoked token fails (or
    reauthenticates) the *entry* — and the slower inventory-status coordinator;
  * the conversation intent handler (registered once, see :mod:`.intent`);
  * the read-only ``gubbins.search`` service (registered once, see below);
  * the opt-in ``gubbins.adjust_quantity`` and ``gubbins.adjust_gauge`` write services
    (registered once, see below) — themselves no-ops unless the bridge runs with
    ``GUBBINS_BRIDGE_ALLOW_WRITES=on``;
and forwards the optional ``/health`` sensor and attention binary-sensor platforms.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
)
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import (
    GubbinsClient,
    GubbinsConnectionError,
    GubbinsError,
    GubbinsRejectedError,
    GubbinsWritesDisabledError,
)
from .const import (
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DOMAIN,
    SERVICE_ADJUST_GAUGE,
    SERVICE_ADJUST_QUANTITY,
    SERVICE_SEARCH,
)
from .coordinator import GubbinsHealthCoordinator, GubbinsRuntimeData, GubbinsStatusCoordinator
from .events import collect_location_ids, normalise_matches
from .intent import async_register_intent, async_unregister_intent

PLATFORMS: list[Platform] = [Platform.BINARY_SENSOR, Platform.SENSOR]

_SEARCH_SCHEMA = vol.Schema(
    {
        vol.Required("query"): cv.string,
        vol.Optional("limit"): vol.All(vol.Coerce(int), vol.Range(min=1, max=25)),
    }
)

_ADJUST_QUANTITY_SCHEMA = vol.Schema(
    {
        vol.Required("item_id"): cv.string,
        vol.Required("delta"): vol.All(vol.Coerce(int), vol.Range(min=-1_000_000, max=1_000_000)),
        vol.Optional("note"): cv.string,
    }
)

# The gauge counterpart. `delta` is coerced to a float, not an int: a gauge measures contents
# (grams of filament, millilitres of resin), so a fractional draw is entirely ordinary — where
# a discrete count can only ever move in whole units.
_ADJUST_GAUGE_SCHEMA = vol.Schema(
    {
        vol.Required("item_id"): cv.string,
        vol.Required("delta"): vol.All(vol.Coerce(float), vol.Range(min=-1_000_000, max=1_000_000)),
        vol.Optional("note"): cv.string,
    }
)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a Gubbins bridge from a config entry."""
    client = GubbinsClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_TOKEN],
    )

    # Probe the bridge before anything else is wired up. A first refresh here raises
    # ConfigEntryNotReady (bridge down → retried with backoff) or ConfigEntryAuthFailed
    # (token revoked → reauth flow), neither of which a forwarded platform may raise.
    coordinator = GubbinsHealthCoordinator(hass, entry, client)
    await coordinator.async_config_entry_first_refresh()

    # The attention counts are deliberately refreshed *without* the config-entry variant: a
    # bridge older than the status endpoint must leave those entities unavailable, not stop
    # the entry (and with it the voice lookups, the services and the health sensor) loading.
    status = GubbinsStatusCoordinator(hass, entry, client)
    await status.async_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = client
    entry.runtime_data = GubbinsRuntimeData(health=coordinator, status=status)

    # Intent and services are global (one handler per type / one service per domain);
    # register them once, on the first entry to load.
    async_register_intent(hass)
    _async_register_search_service(hass)
    _async_register_adjust_quantity_service(hass)
    _async_register_adjust_gauge_service(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry and tidy up its client."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        clients: dict = hass.data.get(DOMAIN, {})
        clients.pop(entry.entry_id, None)
        if not clients:
            # Last entry gone — drop everything registered once, for the domain as a whole,
            # so nothing dangles: a left-behind intent handler would keep matching voice
            # sentences and answer "the bridge isn't set up yet" after the user removed it.
            hass.services.async_remove(DOMAIN, SERVICE_SEARCH)
            hass.services.async_remove(DOMAIN, SERVICE_ADJUST_QUANTITY)
            hass.services.async_remove(DOMAIN, SERVICE_ADJUST_GAUGE)
            async_unregister_intent(hass)
    return unloaded


def _first_client(hass: HomeAssistant) -> GubbinsClient | None:
    """Return any configured client (single-bridge is the common case)."""
    for client in hass.data.get(DOMAIN, {}).values():
        return client
    return None


def _async_register_search_service(hass: HomeAssistant) -> None:
    """Register the response-returning ``gubbins.search`` service, once."""
    if hass.services.has_service(DOMAIN, SERVICE_SEARCH):
        return

    async def _handle_search(call: ServiceCall) -> ServiceResponse:
        client = _first_client(hass)
        if client is None:
            raise HomeAssistantError("No Gubbins bridge is configured")
        try:
            payload = await client.search(call.data["query"], call.data.get("limit"))
        except GubbinsConnectionError as err:
            raise HomeAssistantError(f"Could not reach the Gubbins bridge: {err}") from err
        except GubbinsError as err:
            raise HomeAssistantError(str(err)) from err

        # Additive enrichment: the bridge's own keys are passed through untouched, and the
        # resolved location ids are added alongside them so a script or dashboard can map a
        # match to a place without going through the voice intent. `located_matches` mirrors
        # the `gubbins_item_located` event payload exactly, so the same template works for
        # both. Older bridges that don't report location ids simply yield empty lists.
        located_matches = normalise_matches(payload)
        return {
            **(payload if isinstance(payload, dict) else {}),
            "location_ids": collect_location_ids(located_matches),
            "located_matches": located_matches,
        }

    hass.services.async_register(
        DOMAIN,
        SERVICE_SEARCH,
        _handle_search,
        schema=_SEARCH_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )


def _async_register_adjust_quantity_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.adjust_quantity`` write service, once.

    Checks a discrete item in or out by a whole number.
    """
    _async_register_adjust_service(
        hass,
        SERVICE_ADJUST_QUANTITY,
        _ADJUST_QUANTITY_SCHEMA,
        lambda client, call: client.adjust_quantity(
            call.data["item_id"], call.data["delta"], call.data.get("note")
        ),
    )


def _async_register_adjust_gauge_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.adjust_gauge`` write service, once.

    The gauge counterpart of ``adjust_quantity``: it changes how much is *in* a consumable
    (grams of filament, millilitres of resin) rather than how many there are of something.
    That is the item class where automating from Home Assistant is most natural — a
    consumable sitting on a smart scale — which it could previously only read, never update.
    """
    _async_register_adjust_service(
        hass,
        SERVICE_ADJUST_GAUGE,
        _ADJUST_GAUGE_SCHEMA,
        lambda client, call: client.adjust_gauge(
            call.data["item_id"], call.data["delta"], call.data.get("note")
        ),
    )


def _async_register_adjust_service(
    hass: HomeAssistant,
    service: str,
    schema: vol.Schema,
    adjust: Callable[[GubbinsClient, ServiceCall], Awaitable[dict[str, Any]]],
) -> None:
    """Register one of the opt-in stock-write services, once.

    These are the integration's only writes. They work only when the bridge is started with
    ``GUBBINS_BRIDGE_ALLOW_WRITES=on`` (otherwise the bridge 404s and a clear error is raised);
    the change round-trips through the app's sync merge, so the PWA picks it up conflict-free.
    Both share this registration so the two report a refusal in exactly the same words — an
    operator who has not opted in must not get a different explanation depending on which they
    happened to call.
    """
    if hass.services.has_service(DOMAIN, service):
        return

    async def _handle_adjust(call: ServiceCall) -> ServiceResponse:
        client = _first_client(hass)
        if client is None:
            raise HomeAssistantError("No Gubbins bridge is configured")
        try:
            return await adjust(client, call)
        except GubbinsWritesDisabledError as err:
            raise HomeAssistantError(
                "The Gubbins bridge has writes disabled, or the item id was not found. "
                "Start the bridge with GUBBINS_BRIDGE_ALLOW_WRITES=on to enable writes."
            ) from err
        except GubbinsConnectionError as err:
            raise HomeAssistantError(f"Could not reach the Gubbins bridge: {err}") from err
        except GubbinsRejectedError as err:
            raise HomeAssistantError(str(err)) from err
        except GubbinsError as err:
            raise HomeAssistantError(str(err)) from err

    hass.services.async_register(
        DOMAIN,
        service,
        _handle_adjust,
        schema=schema,
        supports_response=SupportsResponse.OPTIONAL,
    )
