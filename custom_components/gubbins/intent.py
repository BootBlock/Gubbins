"""The Gubbins conversation intent.

Registers a single :class:`GubbinsWhereIsIntent` handler for the ``GubbinsWhereIs``
intent type. The sentences that trigger it ("where are my {item}", "find my {item}",
"how many {item} do I have"…) live in ``custom_sentences/en/gubbins.yaml``, which the
user copies into their Home Assistant config directory — Home Assistant's built-in
conversation agent matches the spoken text and fires this intent with the ``item`` slot.

The handler asks the bridge for its ready-made spoken sentence and reads it back verbatim,
so the voice wording is single-sourced in the bridge. In addition, a successful lookup fires
the ``gubbins_item_located`` event on the Home Assistant bus, carrying the matched items and
their location ids, so an automation can react to a lookup with a plain event trigger — see
``homeassistant/README.md``. Speech always takes priority: an event-bus failure is logged and
swallowed, never surfaced to the speaker.
"""

from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, intent

from .api import GubbinsClient
from .const import DOMAIN, EVENT_ITEM_LOCATED, INTENT_WHERE_IS
from .events import build_located_event

_LOGGER = logging.getLogger(__name__)

# A module-level flag so the global handler is registered only once, even with
# multiple config entries.
_REGISTERED_KEY = f"{DOMAIN}_intent_registered"


def _first_client(hass: HomeAssistant) -> GubbinsClient | None:
    for client in hass.data.get(DOMAIN, {}).values():
        return client
    return None


class GubbinsWhereIsIntent(intent.IntentHandler):
    """Answer "where is / how many <item>" by speaking the bridge's sentence."""

    intent_type = INTENT_WHERE_IS
    description = "Find where an inventory item is stored, and how many there are"
    slot_schema = {vol.Required("item"): cv.string}

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        slots = self.async_validate_slots(intent_obj.slots)
        item = slots["item"]["value"]

        response = intent_obj.create_response()
        client = _first_client(intent_obj.hass)
        if client is None:
            response.async_set_speech(
                "Sorry, the Gubbins inventory bridge isn't set up yet."
            )
            return response

        # where_answer never raises — it returns a friendly fallback on any error.
        spoken, payload = await client.where_answer(item)
        response.async_set_speech(spoken)
        _async_fire_located_event(intent_obj.hass, item, payload)
        return response


def _async_fire_located_event(hass: HomeAssistant, item: str, payload: object) -> None:
    """Fire ``gubbins_item_located`` for a lookup that resolved to at least one item.

    Nothing is fired when the lookup failed or matched nothing — an automation triggered on
    this event only makes sense when there is a location to point at. Any failure here is
    logged and swallowed: the spoken answer has already been set and must not be lost.
    """
    try:
        event_data = build_located_event(item, payload)
        if event_data is None:
            return
        hass.bus.async_fire(EVENT_ITEM_LOCATED, event_data)
    except Exception:  # noqa: BLE001 - the spoken response must never fail because of this
        _LOGGER.exception("Could not fire the %s event", EVENT_ITEM_LOCATED)


def async_register_intent(hass: HomeAssistant) -> None:
    """Register the conversation intent handler exactly once."""
    if hass.data.get(_REGISTERED_KEY):
        return
    intent.async_register(hass, GubbinsWhereIsIntent())
    hass.data[_REGISTERED_KEY] = True


def async_unregister_intent(hass: HomeAssistant) -> None:
    """Remove the conversation intent handler, once the last entry has unloaded.

    Symmetrical with :func:`async_register_intent`: clearing the flag alongside the handler
    is what lets a later entry register it again. Without this the handler outlives the
    integration and keeps answering voice queries with its "not set up yet" fallback.
    """
    if not hass.data.pop(_REGISTERED_KEY, False):
        return
    intent.async_remove(hass, INTENT_WHERE_IS)
