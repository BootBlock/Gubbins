"""Pure helpers that turn a bridge lookup payload into Home Assistant event data.

The bridge answers ``/where`` (and ``/search``) with camelCase JSON, and older bridge
builds omit ``locationId`` entirely — they only ever carried ``locationName``. Home
Assistant event data, by contrast, is snake_case by convention and is consumed by user
automations, so it must be stable and never raise.

Everything here is therefore **defensive and pure**: it accepts an arbitrary parsed JSON
value, ignores anything of an unexpected shape, and returns plain dictionaries and lists.
A bridge that predates location ids simply yields empty ``location_ids`` rather than an
error — the spoken answer is unaffected either way.
"""

from __future__ import annotations

from typing import Any


def _text(value: Any) -> str | None:
    """Return a non-empty trimmed string, or ``None`` for anything else."""
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed
    return None


def _placements(raw: Any) -> list[dict[str, Any]]:
    """Normalise a match's ``placements`` array into snake_case event placements."""
    if not isinstance(raw, list):
        return []
    placements: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        quantity = entry.get("quantity")
        placements.append(
            {
                # Absent on bridges that predate per-placement location ids.
                "location_id": _text(entry.get("locationId")),
                "location_name": _text(entry.get("locationName")),
                "quantity": quantity if isinstance(quantity, (int, float)) else None,
            }
        )
    return placements


def normalise_matches(payload: Any) -> list[dict[str, Any]]:
    """Return the payload's ``matches`` as snake_case event matches.

    Each match is ``{item_id, item_name, placements: [{location_id, location_name,
    quantity}]}``. Matches without a usable id are dropped — an automation keyed on
    ``item_id`` can do nothing with them.
    """
    if not isinstance(payload, dict):
        return []
    raw_matches = payload.get("matches")
    if not isinstance(raw_matches, list):
        return []

    matches: list[dict[str, Any]] = []
    for raw in raw_matches:
        if not isinstance(raw, dict):
            continue
        item_id = _text(raw.get("itemId")) or _text(raw.get("id"))
        if item_id is None:
            continue
        match: dict[str, Any] = {
            "item_id": item_id,
            "item_name": _text(raw.get("name")),
            "placements": _placements(raw.get("placements")),
        }
        if not match["placements"]:
            # No per-location breakdown (a plain /search match, or an item with no stock
            # rows): fall back to the item's primary location so the event still carries
            # something an automation can map.
            primary_id = _text(raw.get("locationId"))
            primary_name = _text(raw.get("locationName"))
            if primary_id is not None or primary_name is not None:
                match["placements"] = [
                    {
                        "location_id": primary_id,
                        "location_name": primary_name,
                        "quantity": None,
                    }
                ]
        matches.append(match)
    return matches


def collect_location_ids(matches: list[dict[str, Any]]) -> list[str]:
    """Flatten every placement's location id into a deduped, order-preserving list."""
    seen: dict[str, None] = {}
    for match in matches:
        for placement in match["placements"]:
            location_id = placement["location_id"]
            if location_id is not None:
                seen.setdefault(location_id, None)
    return list(seen)


def build_located_event(query: str, payload: Any) -> dict[str, Any] | None:
    """Build the ``gubbins_item_located`` event data, or ``None`` when nothing matched.

    Returning ``None`` for a zero-match lookup is deliberate: an automation triggered on
    this event should only ever fire when there is somewhere to point at, so the event is
    not fired at all when the query resolved to nothing.
    """
    matches = normalise_matches(payload)
    if not matches:
        return None
    return {
        "query": query,
        "item_ids": [match["item_id"] for match in matches],
        "location_ids": collect_location_ids(matches),
        "matches": matches,
    }
