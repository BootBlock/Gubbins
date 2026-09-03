"""How a bridge is identified — one reading of its stable id, shared by the flow and by setup.

A config entry used to be keyed on the bridge's ``host:port``, which is where it answers rather
than what it *is*. So the moment its host picked up a different DHCP lease, Home Assistant stopped
recognising it: the existing entry retried a dead address indefinitely while mDNS offered the very
same bridge as a brand-new discovery, and accepting that gave a second device with a second set of
entities — leaving every dashboard card and automation pointed at the dead first set.

The bridge now reports an identity of its own, and reports it in the two places the two paths can
read it:

* ``GET /health`` carries ``bridgeId`` — read by the manual flow (which has a token by the time it
  probes), and by ``async_setup_entry`` in :mod:`custom_components.gubbins` to re-key an entry that
  predates this; and
* the mDNS advertisement carries an ``id`` TXT entry — read by the discovery flow, which has no
  token yet and so cannot ask ``/health`` anything.

Both are validated here rather than at each call site, and a bridge that reports neither simply
falls back to :func:`address_unique_id` — exactly the old behaviour, so an older bridge keeps
working (it just cannot be followed across a move until it is updated).

The id is **not a credential**: it says which bridge you are talking to, authorises nothing, and
travels in an unauthenticated mDNS advertisement by design.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

# Mirrors the bridge's own bounds (see `bridge/src/bridge-id.ts`). Nothing here trusts the value to
# be well-formed: it arrives either over the LAN in an mDNS TXT record or in a JSON body, and an id
# is used as a Home Assistant unique id, so it is checked rather than assumed.
BRIDGE_ID_MAX_LENGTH = 64
_BRIDGE_ID_PATTERN = re.compile(r"\A[A-Za-z0-9._:-]+\Z")


def valid_bridge_id(raw: Any) -> str | None:
    """Return ``raw`` as a usable bridge id, or ``None`` when it is missing or malformed."""
    if isinstance(raw, bytes):
        # A TXT value may still arrive undecoded depending on the Home Assistant version.
        raw = raw.decode("utf-8", "replace")
    if not isinstance(raw, str):
        return None
    candidate = raw.strip()
    if not candidate or len(candidate) > BRIDGE_ID_MAX_LENGTH:
        return None
    return candidate if _BRIDGE_ID_PATTERN.match(candidate) else None


def bridge_id_from_health(payload: Any) -> str | None:
    """Pull the stable id out of a ``GET /health`` body, or ``None`` from a bridge without one."""
    if not isinstance(payload, dict):
        return None
    return valid_bridge_id(payload.get("bridgeId"))


def bridge_id_from_txt(properties: Any) -> str | None:
    """Pull the stable id out of an mDNS advertisement's TXT records, or ``None``.

    Held to a stricter rule than :func:`bridge_id_from_health`, because this value is
    **unauthenticated**: an mDNS advertisement is a datagram anyone on the LAN can send, whereas
    ``/health`` answered with a bridge id only because a valid token was presented to get it.

    The stricter rule is that an advertised id may not contain a colon, which keeps it out of the
    :func:`address_unique_id` namespace. The two must stay disjoint. An address key is minted from
    a host and a port — facts any LAN peer can learn by scanning, or guess from the default port —
    so if an advertisement could carry ``id=<a configured bridge's host>:<port>``, it would match
    that entry's unique id outright. Matching is what lets a discovery *relocate* an entry, and a
    relocated entry sends its stored bearer token to the new address on its very next poll. Keeping
    the namespaces apart restores the property the relocation rule assumes: that claiming to be an
    existing entry requires knowing that bridge's own identifier, not merely where it listens.

    Nothing legitimate is refused. The bridge mints a UUID (``randomUUID``) or derives
    ``<host label>-<port>``, and neither uses a colon; an operator who pins ``GUBBINS_BRIDGE_ID``
    to one is simply not followed across a move over discovery, which is the pre-identity
    behaviour rather than a failure.
    """
    if not isinstance(properties, dict):
        return None
    candidate = valid_bridge_id(properties.get("id"))
    return None if candidate is None or ":" in candidate else candidate


def address_unique_id(host: str, port: int) -> str:
    """The fallback key for a bridge that reports no identity — its address, as before.

    Kept as a named function because it is a *fallback*, not the scheme: everything that reads it
    should be visible from one place if it ever needs removing.

    The ``:`` is load-bearing, not cosmetic: it is what keeps this namespace disjoint from the ids
    :func:`bridge_id_from_txt` will accept. See that function for why the two must not meet.
    """
    return f"{host}:{port}"


def entry_display_name(hass: HomeAssistant, entry_id: str) -> str:
    """Name a set-up bridge the way its owner sees it, falling back to its entry id.

    Sits beside :func:`entry_title` deliberately, because the two are easy to confuse and do
    different jobs: that one *mints* the title Home Assistant gives an entry it named itself,
    while this one *reads back* whatever title the entry ended up with — which may be one the
    user typed. Anything that has to name a bridge in a message to the user wants this one.

    The fallback covers an id that no longer resolves to an entry, which is not worth a failure
    of its own: the caller is already explaining something else, and an id is still an answer to
    "which bridge".
    """
    entry = hass.config_entries.async_get_entry(entry_id)
    return entry.title if entry is not None else entry_id


def entry_title(host: str, port: int) -> str:
    """The title Home Assistant shows for an entry it named itself.

    Also used to tell an auto-generated title from one the user typed: the address is no longer the
    entry's identity, so a title carrying it may need updating when the bridge moves — but a name
    the user chose must never be overwritten to do that.
    """
    return f"Gubbins ({host}:{port})"
