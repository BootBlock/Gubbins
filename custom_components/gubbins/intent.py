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

**Every configured bridge is asked, not just one.** A spoken question carries no target — there
is no field to put one in, and "where are my drill bits, on the workshop bridge" is not a
sentence anyone says — so the handler asks all of them at once and answers from whichever
actually holds the thing. With a single bridge, the common setup, that is one lookup and the
bridge's own sentence read back unchanged. With two, an item found in one vault is answered from
that vault, and an item found in both is answered from both, each part named by the bridge it
came from. The event is fired once per bridge that matched, and carries ``config_entry_id`` so an
automation can tell them apart. The services take an explicit bridge instead, because a call
written in YAML has somewhere to put one: their optional ``config_entry_id`` field.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import voluptuous as vol
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, intent

from .api import GubbinsClient
from .bridge_id import entry_display_name
from .const import ATTR_CONFIG_ENTRY_ID, DOMAIN, EVENT_ITEM_LOCATED, INTENT_WHERE_IS
from .events import build_located_event, normalise_matches

_LOGGER = logging.getLogger(__name__)

# A module-level flag so the global handler is registered only once, even with
# multiple config entries.
_REGISTERED_KEY = f"{DOMAIN}_intent_registered"


# What a bridge is reported as saying when it answered with something unreadable. `where_answer`
# already speaks for a bridge that is down or that rejects the token; this covers only what it
# cannot — a reply that arrives and then fails to parse.
_UNREADABLE = "Sorry, one of your Gubbins bridges didn't answer properly."


async def _ask(client: GubbinsClient, item: str) -> tuple[str, Any]:
    """Ask one bridge, turning an unexpected failure into a sentence rather than an exception.

    Without this, one bridge answering with a malformed body would take the *other* bridge's
    perfectly good answer down with it, because a single raise out of :func:`asyncio.gather`
    abandons the whole lookup. A cancellation still propagates — it is not the bridge failing.
    """
    try:
        return await client.where_answer(item)
    except Exception:  # noqa: BLE001 - one bridge's failure must not lose another's answer
        _LOGGER.exception("A Gubbins bridge could not answer the lookup")
        return _UNREADABLE, None


def _clients(hass: HomeAssistant) -> list[tuple[str, GubbinsClient]]:
    """Snapshot every loaded bridge as ``(entry_id, client)`` pairs.

    A list rather than a live view of ``hass.data``: the lookups below await, and an entry
    unloading in between would otherwise change the mapping underneath the answers.
    """
    return list(hass.data.get(DOMAIN, {}).items())


class GubbinsWhereIsIntent(intent.IntentHandler):
    """Answer "where is / how many <item>" by speaking the bridge's sentence."""

    intent_type = INTENT_WHERE_IS
    description = "Find where an inventory item is stored, and how many there are"
    slot_schema = {vol.Required("item"): cv.string}

    async def async_handle(self, intent_obj: intent.Intent) -> intent.IntentResponse:
        slots = self.async_validate_slots(intent_obj.slots)
        item = slots["item"]["value"]
        hass = intent_obj.hass

        response = intent_obj.create_response()
        bridges = _clients(hass)
        if not bridges:
            response.async_set_speech(
                "Sorry, the Gubbins inventory bridge isn't set up yet."
            )
            return response

        # Every bridge is asked at once, and a bridge that fails costs this lookup one sentence
        # rather than the answer another bridge has — see :func:`_ask`.
        answers = await asyncio.gather(
            *(_ask(client, item) for _entry_id, client in bridges)
        )
        results = [
            (entry_id, spoken, payload)
            for (entry_id, _client), (spoken, payload) in zip(bridges, answers)
        ]

        response.async_set_speech(_speech(hass, results))
        for entry_id, _spoken, payload in results:
            _async_fire_located_event(hass, entry_id, item, payload)
        return response


def _speech(hass: HomeAssistant, results: list[tuple[str, str, Any]]) -> str:
    """Choose what to say from what each bridge answered.

    One bridge is read back verbatim, whatever it said, so the single-bridge wording stays
    exactly the bridge's own. Beyond that the rule is "answer from wherever the thing actually
    is": one match speaks that bridge's sentence unqualified, and several speak each in turn
    behind the bridge's name, because "three, in the drawer" and "none" are different answers and
    merging them would drop the half the speaker asked for.

    When nothing matched anywhere, every sentence says so and any one of them will do — except
    that a bridge which failed outright answers with an apology rather than a lookup, and its
    ``None`` payload is what marks it. Preferring a bridge that genuinely answered keeps "you
    have no drill bits" from being reported as "I couldn't reach the bridge" whenever an
    unrelated second bridge happens to be offline.
    """
    if len(results) == 1:
        return results[0][1]

    # `normalise_matches` is the same test the event firing below applies — an event is built
    # from exactly the payloads that yield matches — so speech and events never disagree about
    # which bridges found the thing.
    matched = [
        (entry_id, spoken)
        for entry_id, spoken, payload in results
        if normalise_matches(payload)
    ]
    if len(matched) == 1:
        return matched[0][1]
    if matched:
        return " ".join(
            f"{entry_display_name(hass, entry_id)}: {spoken}"
            for entry_id, spoken in matched
        )

    answered = next(
        (spoken for _entry_id, spoken, payload in results if payload is not None), None
    )
    return answered if answered is not None else results[0][1]


def _async_fire_located_event(
    hass: HomeAssistant, entry_id: str, item: str, payload: object
) -> None:
    """Fire ``gubbins_item_located`` for a lookup that resolved to at least one item.

    Nothing is fired when the lookup failed or matched nothing — an automation triggered on
    this event only makes sense when there is a location to point at. Any failure here is
    logged and swallowed: the spoken answer has already been set and must not be lost.

    One event per *bridge* that matched, each naming its ``config_entry_id``. An automation that
    flashes the light on a bin has to know whose bin it is, and with two vaults set up the query
    alone no longer says. The key is :data:`~.const.ATTR_CONFIG_ENTRY_ID`, the same constant the
    services take as a field, so the two surfaces an automation sees carry one name by
    construction rather than by agreement.
    """
    try:
        event_data = build_located_event(item, payload)
        if event_data is None:
            return
        hass.bus.async_fire(
            EVENT_ITEM_LOCATED, {**event_data, ATTR_CONFIG_ENTRY_ID: entry_id}
        )
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
