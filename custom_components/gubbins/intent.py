"""The Gubbins conversation intent.

Registers a single :class:`GubbinsWhereIsIntent` handler for the ``GubbinsWhereIs``
intent type. The sentences that trigger it ("where are my {item}", "find my {item}",
"how many {item} do I have"…) live in ``custom_sentences/en/gubbins.yaml``, which the
user copies into their Home Assistant config directory — Home Assistant's built-in
conversation agent matches the spoken text and fires this intent with the ``item`` slot.

The handler simply asks the bridge for its ready-made spoken sentence and reads it back
verbatim, so the voice wording is single-sourced in the bridge.
"""

from __future__ import annotations

import voluptuous as vol
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, intent

from .api import GubbinsClient
from .const import DOMAIN, INTENT_WHERE_IS

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

        # where_spoken never raises — it returns a friendly fallback on any error.
        response.async_set_speech(await client.where_spoken(item))
        return response


def async_register_intent(hass: HomeAssistant) -> None:
    """Register the conversation intent handler exactly once."""
    if hass.data.get(_REGISTERED_KEY):
        return
    intent.async_register(hass, GubbinsWhereIsIntent())
    hass.data[_REGISTERED_KEY] = True
