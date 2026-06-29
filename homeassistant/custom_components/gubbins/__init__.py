"""The Gubbins inventory bridge integration.

A read-only Home Assistant integration that talks to the local Gubbins **bridge** — a
companion service that exposes a bearer-token-protected HTTP API over an exported Gubbins
inventory snapshot. This integration never writes; the bridge is the only data path.

Setup wires three things:
  * a per-entry :class:`GubbinsClient` (read-only HTTP client) into ``hass.data``;
  * the conversation intent handler (registered once, see :mod:`.intent`);
  * the ``gubbins.search`` service (registered once, see below);
and forwards the optional ``/health`` sensor platform.
"""

from __future__ import annotations

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
    SERVICE_ADJUST_QUANTITY,
    SERVICE_SEARCH,
)
from .intent import async_register_intent

PLATFORMS: list[Platform] = [Platform.SENSOR]

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


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up a Gubbins bridge from a config entry."""
    client = GubbinsClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_TOKEN],
    )
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = client

    # Intent and services are global (one handler per type / one service per domain);
    # register them once, on the first entry to load.
    async_register_intent(hass)
    _async_register_search_service(hass)
    _async_register_adjust_quantity_service(hass)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry and tidy up its client."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        clients: dict = hass.data.get(DOMAIN, {})
        clients.pop(entry.entry_id, None)
        if not clients:
            # Last entry gone — drop the shared services so they don't dangle.
            hass.services.async_remove(DOMAIN, SERVICE_SEARCH)
            hass.services.async_remove(DOMAIN, SERVICE_ADJUST_QUANTITY)
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
            return await client.search(call.data["query"], call.data.get("limit"))
        except GubbinsConnectionError as err:
            raise HomeAssistantError(f"Could not reach the Gubbins bridge: {err}") from err
        except GubbinsError as err:
            raise HomeAssistantError(str(err)) from err

    hass.services.async_register(
        DOMAIN,
        SERVICE_SEARCH,
        _handle_search,
        schema=_SEARCH_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )


def _async_register_adjust_quantity_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.adjust_quantity`` write service, once.

    This is the integration's only write. It works only when the bridge is started with
    ``GUBBINS_BRIDGE_ALLOW_WRITES=on`` (otherwise the bridge 404s and a clear error is raised);
    the change round-trips through the app's sync merge, so the PWA picks it up conflict-free.
    """
    if hass.services.has_service(DOMAIN, SERVICE_ADJUST_QUANTITY):
        return

    async def _handle_adjust_quantity(call: ServiceCall) -> ServiceResponse:
        client = _first_client(hass)
        if client is None:
            raise HomeAssistantError("No Gubbins bridge is configured")
        try:
            return await client.adjust_quantity(
                call.data["item_id"],
                call.data["delta"],
                call.data.get("note"),
            )
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
        SERVICE_ADJUST_QUANTITY,
        _handle_adjust_quantity,
        schema=_ADJUST_QUANTITY_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
