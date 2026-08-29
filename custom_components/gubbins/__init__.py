"""The Gubbins inventory bridge integration.

A Home Assistant integration that talks to the local Gubbins **bridge** — a companion service
that exposes a bearer-token-protected HTTP API over an exported Gubbins inventory snapshot.
The bridge is the only data path. Everything here reads, apart from the five opt-in write
services below, which do nothing unless the bridge itself was started with writes enabled.

Setup wires six things:
  * a per-entry :class:`GubbinsClient` (HTTP client — reads, plus the opt-in writes) into
    ``hass.data``;
  * a per-entry :class:`GubbinsRuntimeData` into ``entry.runtime_data``, holding the health
    coordinator — first-refreshed here so an unreachable bridge or a revoked token fails (or
    reauthenticates) the *entry* — and the slower inventory-status coordinator;
  * the conversation intent handler (registered once, see :mod:`.intent`);
  * the read-only ``gubbins.search`` service (registered once, see below);
  * the opt-in write services (registered once, see below) — ``gubbins.adjust_quantity`` and
    ``gubbins.adjust_gauge`` for how much there is, ``gubbins.transfer_stock`` for where it is,
    ``gubbins.check_out`` and ``gubbins.check_in`` for who has it — themselves no-ops unless
    the bridge runs with ``GUBBINS_BRIDGE_ALLOW_WRITES=on``;
and forwards the optional ``/health`` sensor and attention binary-sensor platforms.

Every service is registered once for the domain as a whole, not once per entry, so a call needs a
way to say *which* bridge it means once more than one is set up. That is the optional
``config_entry_id`` field on all six, resolved by :func:`_async_resolve_client`: empty keeps
working while there is exactly one bridge, and is refused rather than guessed at when there are
two. The voice intent has no such field to offer, so it asks every bridge instead — see
:mod:`.intent`.

The loan pair is what makes the ``on loan`` / ``overdue`` binary sensors actionable rather than
merely informative: an automation could previously be told a loan was overdue but had no way to
close it, and no way to lend anything out in the first place.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import date, datetime
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
    GubbinsWriteTimeoutError,
    GubbinsWritesDisabledError,
)
from .bridge_id import bridge_id_from_health
from .const import (
    ATTR_CONFIG_ENTRY_ID,
    CONF_HOST,
    CONF_PORT,
    CONF_TOKEN,
    DOMAIN,
    SERVICE_ADJUST_GAUGE,
    SERVICE_ADJUST_QUANTITY,
    SERVICE_CHECK_IN,
    SERVICE_CHECK_OUT,
    SERVICE_SEARCH,
    SERVICE_TRANSFER_STOCK,
)
from .coordinator import GubbinsHealthCoordinator, GubbinsRuntimeData, GubbinsStatusCoordinator
from .events import collect_location_ids, normalise_matches
from .intent import async_register_intent, async_unregister_intent

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.BINARY_SENSOR, Platform.SENSOR]

# The one field every service shares: which configured bridge to send the call to.
#
# It is optional, and stays empty in the ordinary single-bridge setup — see the resolution rules
# in :func:`_async_resolve_client`, which is where "empty" acquires its meaning. Merged into each
# schema below rather than repeated in all six, so there is one definition of the field and no
# chance of a service quietly not accepting it.
_TARGET_FIELDS = {vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string}

_SEARCH_SCHEMA = vol.Schema(
    {
        **_TARGET_FIELDS,
        vol.Required("query"): cv.string,
        vol.Optional("limit"): vol.All(vol.Coerce(int), vol.Range(min=1, max=25)),
    }
)

_ADJUST_QUANTITY_SCHEMA = vol.Schema(
    {
        **_TARGET_FIELDS,
        vol.Required("item_id"): cv.string,
        vol.Required("delta"): vol.All(vol.Coerce(int), vol.Range(min=-1_000_000, max=1_000_000)),
        vol.Optional("note"): cv.string,
        vol.Optional("idempotency_key"): cv.string,
    }
)

# The gauge counterpart. `delta` is coerced to a float, not an int: a gauge measures contents
# (grams of filament, millilitres of resin), so a fractional draw is entirely ordinary — where
# a discrete count can only ever move in whole units.
_ADJUST_GAUGE_SCHEMA = vol.Schema(
    {
        **_TARGET_FIELDS,
        vol.Required("item_id"): cv.string,
        vol.Required("delta"): vol.All(vol.Coerce(float), vol.Range(min=-1_000_000, max=1_000_000)),
        vol.Optional("note"): cv.string,
        vol.Optional("idempotency_key"): cv.string,
    }
)

# Lend an item out. Only the *shape* is checked here — which borrower fields may be combined,
# whether there is enough stock, and whether the item can be lent at all are the app's rules,
# and the bridge answers with the app's own wording. Restating them here would put the same
# rule in two places, where only one of them gets updated.
#
# `due_date` is a calendar day rather than a timestamp: a loan due "the 20th" is a deadline in
# the borrower's own day, and the app anchors it at the end of that day. `cv.date` accepts both
# a `yyyy-MM-dd` string typed into YAML and the date object the UI's date selector produces.
_CHECK_OUT_SCHEMA = vol.Schema(
    {
        **_TARGET_FIELDS,
        vol.Required("item_id"): cv.string,
        vol.Optional("contact_name"): cv.string,
        vol.Optional("contact_id"): cv.string,
        vol.Optional("project_id"): cv.string,
        vol.Optional("location_id"): cv.string,
        vol.Optional("quantity"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1_000_000)),
        vol.Optional("due_date"): cv.date,
        vol.Optional("from_location_id"): cv.string,
        vol.Optional("note"): cv.string,
        vol.Optional("idempotency_key"): cv.string,
    }
)

# Take a lent item back. `checkout_id` is optional because the common case — one thing, out with
# one person — needs only the item: the app resolves the single open loan itself, and asks for
# an id only once there is more than one to choose between.
_CHECK_IN_SCHEMA = vol.Schema(
    {
        **_TARGET_FIELDS,
        vol.Required("item_id"): cv.string,
        vol.Optional("checkout_id"): cv.string,
        vol.Optional("note"): cv.string,
        vol.Optional("idempotency_key"): cv.string,
    }
)

# Move stock between two locations. Every field is required: there is no sensible default for
# "somewhere else", and a transfer with a guessed destination is worse than one that asks. The
# app writes its own ledger note describing the move, so there is no `note` to add here.
_TRANSFER_STOCK_SCHEMA = vol.Schema(
    {
        **_TARGET_FIELDS,
        vol.Required("item_id"): cv.string,
        vol.Required("from_location_id"): cv.string,
        vol.Required("to_location_id"): cv.string,
        vol.Required("quantity"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1_000_000)),
        vol.Optional("idempotency_key"): cv.string,
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

    # The bridge has just told us who it is, so this is the moment to make sure the entry is keyed
    # on that rather than on where it answered.
    _async_reconcile_unique_id(hass, entry, coordinator.data)

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
    _async_register_check_out_service(hass)
    _async_register_check_in_service(hass)
    _async_register_transfer_stock_service(hass)

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
            hass.services.async_remove(DOMAIN, SERVICE_CHECK_OUT)
            hass.services.async_remove(DOMAIN, SERVICE_CHECK_IN)
            hass.services.async_remove(DOMAIN, SERVICE_TRANSFER_STOCK)
            async_unregister_intent(hass)
    return unloaded


def _async_reconcile_unique_id(
    hass: HomeAssistant, entry: ConfigEntry, health: dict[str, Any] | None
) -> None:
    """Re-key an entry onto the bridge's own id once the bridge has reported one.

    Entries created before the bridge had an identity are keyed on its ``host:port``, and so cannot
    survive the address changing: the entry retries a dead address while the same bridge is offered
    as a new discovery. The first setup that reaches an updated bridge fixes that, with no user
    action needed — the id is a property of the bridge, not something to be configured.

    It runs on every setup rather than once as a migration, because the id can legitimately change
    at the *bridge's* end too: one recreated in a fresh container without a mounted id file mints
    itself a new one. Adopting it keeps the entry, its entities and its history intact. A *later*
    poll is deliberately not a second chance — an entry whose bridge was unreachable at setup is
    retried by Home Assistant from the start, which comes back through here.

    Two entries claiming one id is the only case left alone: Home Assistant's registry treats a
    unique id as exclusive, so the duplicate is reported for the user to resolve rather than one
    entry silently taking the other's identity.
    """
    bridge_id = bridge_id_from_health(health)
    if bridge_id is None or entry.unique_id == bridge_id:
        return

    duplicate = next(
        (
            other
            for other in hass.config_entries.async_entries(DOMAIN)
            if other.entry_id != entry.entry_id and other.unique_id == bridge_id
        ),
        None,
    )
    if duplicate is not None:
        _LOGGER.warning(
            "The Gubbins bridge at %s:%s is set up twice — the entries %r and %r both point at it, "
            "so its entities are duplicated. Remove whichever of the two you no longer use",
            entry.data[CONF_HOST],
            entry.data[CONF_PORT],
            entry.title,
            duplicate.title,
        )
        return

    hass.config_entries.async_update_entry(entry, unique_id=bridge_id)


def _iso_day(value: date | None) -> str | None:
    """Render a picked due date as the plain calendar day the bridge documents (``yyyy-MM-dd``).

    ``cv.date`` hands back a :class:`datetime.date` whichever way the value arrived — a string
    typed into YAML or the UI's date selector — so one conversion covers both. A ``datetime`` is
    narrowed to its date first: it *is* a ``date`` as far as the validator is concerned, but its
    ``isoformat()`` carries a time the bridge would reject, and an unquoted YAML value with a
    time in it is an easy way to end up holding one.
    """
    if value is None:
        return None
    return (value.date() if isinstance(value, datetime) else value).isoformat()


def _entry_title(hass: HomeAssistant, entry_id: str) -> str:
    """Name a loaded entry the way the user sees it, falling back to its id."""
    entry = hass.config_entries.async_get_entry(entry_id)
    return entry.title if entry is not None else entry_id


def _async_resolve_client(hass: HomeAssistant, call: ServiceCall) -> GubbinsClient:
    """Return the bridge client this service call is aimed at, or explain why there is none.

    Two bridges — a home vault and a workshop one — are a supported setup rather than a misuse:
    each config entry is keyed on the bridge's own identity and brings its own device and its own
    sensors. The services, though, are registered once for the domain, so a call carries no target
    of its own. ``config_entry_id`` is that target.

    The rules, in order:

    * **Named** — the call names an entry, and that entry's client is used. An id that is not a
      loaded Gubbins bridge is an error naming what went wrong, never a fallback to another one:
      the write services move stock, and applying a workshop change to the home vault is exactly
      the failure this field exists to prevent.
    * **Empty, one bridge** — the single loaded bridge is used. This is the common setup, and
      every automation written before the field existed keeps working unchanged.
    * **Empty, several bridges** — the call is refused, listing the bridges by name. There is no
      right answer to guess at, and guessing wrong writes to the wrong inventory silently: the
      bridge accepts the change and returns a perfectly valid item, just the wrong one's.
    """
    clients: dict[str, GubbinsClient] = hass.data.get(DOMAIN, {})
    entry_id = call.data.get(ATTR_CONFIG_ENTRY_ID)

    if entry_id is not None:
        client = clients.get(entry_id)
        if client is not None:
            return client
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != DOMAIN:
            raise HomeAssistantError(
                f"'{entry_id}' is not a Gubbins bridge. Pick one in the Bridge field, or leave "
                "it empty when only one bridge is set up."
            )
        raise HomeAssistantError(
            f"The Gubbins bridge '{entry.title}' is not loaded, so nothing was sent to it. "
            "Check it under Settings, Devices & services."
        )

    if not clients:
        raise HomeAssistantError("No Gubbins bridge is configured")
    if len(clients) > 1:
        names = ", ".join(sorted(_entry_title(hass, known) for known in clients))
        raise HomeAssistantError(
            f"More than one Gubbins bridge is set up ({names}), so this call has nowhere "
            "unambiguous to go. Name the one you mean in the Bridge field."
        )
    return next(iter(clients.values()))


def _async_register_search_service(hass: HomeAssistant) -> None:
    """Register the response-returning ``gubbins.search`` service, once."""
    if hass.services.has_service(DOMAIN, SERVICE_SEARCH):
        return

    async def _handle_search(call: ServiceCall) -> ServiceResponse:
        client = _async_resolve_client(hass, call)
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

    A signed whole-number change to a discrete item's count. It moves a number and nothing
    else — ``check_out`` is what records that a particular borrower has the item.
    """
    _async_register_write_service(
        hass,
        SERVICE_ADJUST_QUANTITY,
        _ADJUST_QUANTITY_SCHEMA,
        lambda client, call: client.adjust_quantity(
            call.data["item_id"],
            call.data["delta"],
            call.data.get("note"),
            call.data.get("idempotency_key"),
        ),
    )


def _async_register_adjust_gauge_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.adjust_gauge`` write service, once.

    The gauge counterpart of ``adjust_quantity``: it changes how much is *in* a consumable
    (grams of filament, millilitres of resin) rather than how many there are of something.
    That is the item class where automating from Home Assistant is most natural — a
    consumable sitting on a smart scale — which it could previously only read, never update.
    """
    _async_register_write_service(
        hass,
        SERVICE_ADJUST_GAUGE,
        _ADJUST_GAUGE_SCHEMA,
        lambda client, call: client.adjust_gauge(
            call.data["item_id"],
            call.data["delta"],
            call.data.get("note"),
            call.data.get("idempotency_key"),
        ),
    )


def _async_register_check_out_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.check_out`` write service, once.

    Lends an item to a person, a project, or a place such as a van — which is a different
    statement from ``adjust_quantity``: a loan records *who* has it and when it is due, so it
    is what the "on loan" and "overdue" sensors, and the app's calendar feed, are about. The
    response carries the loan, whose id ``check_in`` can name later.
    """
    _async_register_write_service(
        hass,
        SERVICE_CHECK_OUT,
        _CHECK_OUT_SCHEMA,
        lambda client, call: client.check_out(
            call.data["item_id"],
            contact_name=call.data.get("contact_name"),
            contact_id=call.data.get("contact_id"),
            project_id=call.data.get("project_id"),
            location_id=call.data.get("location_id"),
            quantity=call.data.get("quantity"),
            due_date=_iso_day(call.data.get("due_date")),
            from_location_id=call.data.get("from_location_id"),
            note=call.data.get("note"),
            idempotency_key=call.data.get("idempotency_key"),
        ),
        not_found="the item was not found (or this bridge predates loan writes)",
    )


def _async_register_check_in_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.check_in`` write service, once.

    The return leg of :func:`_async_register_check_out_service`: it restores the stock to the
    place (and lot) it was lent from and closes the loan. Naming a loan is optional while the
    item has only one open, so "that's back now" needs nothing but the item id.
    """
    _async_register_write_service(
        hass,
        SERVICE_CHECK_IN,
        _CHECK_IN_SCHEMA,
        lambda client, call: client.check_in(
            call.data["item_id"],
            call.data.get("checkout_id"),
            call.data.get("note"),
            call.data.get("idempotency_key"),
        ),
        not_found="the item or loan was not found (or this bridge predates loan writes)",
    )


def _async_register_transfer_stock_service(hass: HomeAssistant) -> None:
    """Register the opt-in ``gubbins.transfer_stock`` write service, once.

    Moves units between two locations, leaving the item's total untouched — the *where*, not
    the *how much*. Two ``adjust_quantity`` calls cannot stand in for it: that service only
    ever touches the item's home location, so it has no way to name the two ends of a move.
    DISCRETE items only; a gauge measures one body of material and has nothing to split.

    All of it moves or none does; too little at the source is a rejection rather than a
    partial transfer, so an automation is never left having moved some of what it asked for.
    """
    _async_register_write_service(
        hass,
        SERVICE_TRANSFER_STOCK,
        _TRANSFER_STOCK_SCHEMA,
        lambda client, call: client.transfer_stock(
            call.data["item_id"],
            call.data["from_location_id"],
            call.data["to_location_id"],
            call.data["quantity"],
            call.data.get("idempotency_key"),
        ),
    )


def _async_register_write_service(
    hass: HomeAssistant,
    service: str,
    schema: vol.Schema,
    write: Callable[[GubbinsClient, ServiceCall], Awaitable[dict[str, Any]]],
    not_found: str = "the item id was not found",
) -> None:
    """Register one of the opt-in write services, once.

    These are the integration's only writes. They work only when the bridge is started with
    ``GUBBINS_BRIDGE_ALLOW_WRITES=on`` (otherwise the bridge 404s and a clear error is raised);
    the change round-trips through the app's sync merge, so the PWA picks it up conflict-free.
    They all share this registration so every one of them reports a refusal in exactly the same
    words — an operator who has not opted in must not get a different explanation depending on
    which they happened to call. ``not_found`` varies only the *other* thing a 404 can mean,
    which genuinely differs (a loan id is a second way to miss); the opt-in sentence itself is
    identical everywhere.
    """
    if hass.services.has_service(DOMAIN, service):
        return

    async def _handle_write(call: ServiceCall) -> ServiceResponse:
        client = _async_resolve_client(hass, call)
        try:
            return await write(client, call)
        except GubbinsWritesDisabledError as err:
            raise HomeAssistantError(
                f"The Gubbins bridge has writes disabled, or {not_found}. "
                "Start the bridge with GUBBINS_BRIDGE_ALLOW_WRITES=on to enable writes."
            ) from err
        except GubbinsWriteTimeoutError as err:
            # Reported separately from a connection failure, and worded carefully: the change
            # was very likely applied, so "it failed, run it again" is the one conclusion an
            # operator must not draw from this. Every write here is a relative change, and a
            # second application moves the number again.
            raise HomeAssistantError(
                f"The Gubbins bridge accepted the change but {err}, so it may already have "
                "been applied. Check the item before repeating this — and if you retry, pass "
                "the same idempotency_key so the bridge answers with the first attempt's "
                "result instead of applying the change twice."
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
        _handle_write,
        schema=schema,
        supports_response=SupportsResponse.OPTIONAL,
    )
