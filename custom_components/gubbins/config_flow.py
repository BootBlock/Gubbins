"""UI config flow for the Gubbins inventory bridge.

Captures the bridge **host, port and token** in the Home Assistant UI. The token is
stored by Home Assistant in its config-entry store — it is never written to YAML or to
this repository. The flow verifies the connection (and the token) by calling
``GET /health`` before creating the entry.

Four entry points share that verification:

* the manual :meth:`async_step_user` flow (host/port/token typed in);
* :meth:`async_step_zeroconf` — when the bridge advertises itself over mDNS (the bridge's
  opt-in ``GUBBINS_BRIDGE_MDNS=on``, only when LAN-exposed), Home Assistant auto-discovers
  it and pre-fills the host/port. The **token is never advertised**, so the user still
  enters it. The manual flow keeps working unchanged as a fallback;
* :meth:`async_step_reauth` — started automatically when the bridge rejects the stored token
  (it was revoked or rotated in the Gubbins app). Asks for a fresh token only, and updates
  the existing entry in place rather than making the user delete and re-add it; and
* :meth:`async_step_reconfigure` — the user-initiated "Reconfigure" action, for when the
  bridge moves to a different host or port. It can change every field, so it supersedes an
  options step: none of this integration's settings live outside the entry data.

An entry is keyed on the **bridge's own stable id**, never on its address (see :mod:`.bridge_id`).
That is what lets every path above recognise a bridge that has moved: a changed address updates the
entry it already belongs to instead of arriving as a second integration with a duplicate set of
entities. A bridge too old to report an id falls back to the address, as before.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import (
    SOURCE_IGNORE,
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
)
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
from homeassistant.helpers.typing import UNDEFINED

from .api import GubbinsAuthError, GubbinsClient, GubbinsConnectionError
from .bridge_id import (
    address_unique_id,
    bridge_id_from_health,
    bridge_id_from_txt,
    entry_title,
)
from .const import CONF_HOST, CONF_PORT, CONF_TOKEN, DEFAULT_PORT, DOMAIN


@dataclass(frozen=True, slots=True)
class _Probe:
    """The outcome of a ``GET /health`` connection test."""

    #: A form error key (``cannot_connect`` / ``invalid_auth``), or ``None`` when it succeeded.
    error: str | None = None
    #: The bridge's stable id, when it reported one — the entry's unique id. ``None`` otherwise.
    bridge_id: str | None = None


def _user_schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    data = defaults or {}
    return vol.Schema(
        {
            vol.Required(CONF_HOST, default=data.get(CONF_HOST, "")): str,
            vol.Required(CONF_PORT, default=data.get(CONF_PORT, DEFAULT_PORT)): int,
            vol.Required(CONF_TOKEN): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
        }
    )


def _token_schema() -> vol.Schema:
    """Just the token — host/port come from the discovered service."""
    return vol.Schema(
        {
            vol.Required(CONF_TOKEN): TextSelector(
                TextSelectorConfig(type=TextSelectorType.PASSWORD)
            ),
        }
    )


class GubbinsConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the user-initiated config flow."""

    VERSION = 1

    def __init__(self) -> None:
        # Host/port carried from a zeroconf discovery into the token-only confirm step.
        self._discovered_host: str | None = None
        self._discovered_port: int = DEFAULT_PORT
        # The advertised stable id, so the confirm step can tell whether the entry it creates is
        # keyed on the bridge's own identity or (older bridge) on its address.
        self._discovered_bridge_id: str | None = None

    async def _async_verify(self, host: str, port: int, token: str) -> _Probe:
        """Probe ``GET /health``: check the connection and the token, and learn who answered.

        The identity comes back with the verdict because both callers need it in the same breath —
        the entry they are about to create or update is keyed on it.
        """
        client = GubbinsClient(async_get_clientsession(self.hass), host, port, token)
        try:
            payload = await client.health()
        except GubbinsAuthError:
            return _Probe(error="invalid_auth")
        except GubbinsConnectionError:
            return _Probe(error="cannot_connect")
        return _Probe(bridge_id=bridge_id_from_health(payload))

    def _async_known_entry(self, unique_id: str, host: str, port: int) -> ConfigEntry | None:
        """The entry that is already this bridge, if any — matched by identity, then by address.

        Identity wins outright: the same id *is* the same bridge, wherever it now answers. Falling
        back to the address covers the other direction — a bridge that has started reporting a
        different id than the entry holds (it was set up before ids existed, or it was moved into a
        container that mints a new one). One address can only ever be one bridge, so that match is
        just as conclusive; an ambiguous one (two entries somehow sharing an address) is left alone
        rather than guessed at.

        Ignored entries are included deliberately: a discovery the user dismissed still holds the
        unique id, and Home Assistant's own index would see the collision.
        """
        at_address: list[ConfigEntry] = []
        for entry in self._async_current_entries(include_ignore=True):
            if entry.unique_id == unique_id:
                return entry
            if (
                entry.source != SOURCE_IGNORE
                and entry.data.get(CONF_HOST) == host
                and entry.data.get(CONF_PORT) == port
            ):
                at_address.append(entry)
        return at_address[0] if len(at_address) == 1 else None

    def _async_abort_known(
        self,
        entry: ConfigEntry,
        unique_id: str,
        host: str,
        port: int,
        token: str | None = None,
    ) -> ConfigFlowResult:
        """Heal the entry this bridge already has, then abort — never add a second one.

        This is the whole point of keying on the bridge's identity: a bridge that moved gets its
        existing entry corrected, so its entities keep their ids and history and every automation
        pointing at them carries on working.

        Two things are deliberate. The entry is only written when something actually *changes* — an
        mDNS advertisement repeats for as long as the bridge is up, and reloading a healthy entry on
        every announcement would be its own bug. And the title is only rewritten when it is still
        the one this integration generated for the old address: the address is no longer the entry's
        identity, so a title carrying it may be stale, but a name the user typed is theirs.
        """
        if entry.source == SOURCE_IGNORE:
            # The user dismissed this bridge. Honour that rather than quietly editing the record.
            return self.async_abort(reason="already_configured")

        # Safe to index past the ignore check above: every entry this integration creates carries
        # both, and only an ignored one has no data at all.
        old_host: str = entry.data[CONF_HOST]
        old_port: int = entry.data[CONF_PORT]
        updates: dict[str, Any] = {}
        if old_host != host:
            updates[CONF_HOST] = host
        if old_port != port:
            updates[CONF_PORT] = port
        if token is not None and entry.data.get(CONF_TOKEN) != token:
            updates[CONF_TOKEN] = token

        if not updates and entry.unique_id == unique_id:
            return self.async_abort(reason="already_configured")

        moved = CONF_HOST in updates or CONF_PORT in updates
        keep_title = not moved or entry.title != entry_title(old_host, old_port)
        return self.async_update_reload_and_abort(
            entry,
            unique_id=unique_id,
            title=UNDEFINED if keep_title else entry_title(host, port),
            data_updates=updates,
            reason="bridge_moved" if moved else "already_configured",
        )

    async def async_step_zeroconf(
        self, discovery_info: ZeroconfServiceInfo
    ) -> ConfigFlowResult:
        """Handle a bridge discovered over mDNS / zeroconf.

        The advertisement carries host/port (and a non-secret TXT record) but **never** the
        token, so this only pre-fills the connection details and then asks for the token.

        The bridge's stable id comes from that TXT record, which matters here more than anywhere:
        this step runs *before* the user has supplied a token, so ``/health`` cannot be asked who
        answered. Without an identity on the wire, a bridge whose address had changed could only be
        offered as something new — the failure this exists to stop.
        """
        host = discovery_info.host
        port = discovery_info.port or DEFAULT_PORT
        bridge_id = bridge_id_from_txt(discovery_info.properties)
        unique_id = bridge_id or address_unique_id(host, port)

        await self.async_set_unique_id(unique_id)
        known = self._async_known_entry(unique_id, host, port)
        if known is not None:
            return self._async_abort_known(known, unique_id, host, port)

        self._discovered_host = host
        self._discovered_port = port
        self._discovered_bridge_id = bridge_id
        # Shown in the discovered-integration card and the confirm dialog title.
        self.context["title_placeholders"] = {"name": entry_title(host, port)}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the (never-advertised) token and verify the discovered bridge."""
        errors: dict[str, str] = {}
        host = self._discovered_host or ""
        port = self._discovered_port

        if user_input is not None:
            probe = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if probe.error:
                errors["base"] = probe.error
            else:
                # The advertisement and `/health` are two views of one running bridge, so these
                # normally agree; where they don't, the authenticated answer is the authoritative
                # one. Either way the entry ends up keyed on the identity setup will reconcile
                # against, so it is never left holding an address it might outlive.
                unique_id = (
                    probe.bridge_id
                    or self._discovered_bridge_id
                    or address_unique_id(host, port)
                )
                if unique_id != self.unique_id:
                    await self.async_set_unique_id(unique_id)
                    known = self._async_known_entry(unique_id, host, port)
                    if known is not None:
                        return self._async_abort_known(
                            known, unique_id, host, port, user_input[CONF_TOKEN]
                        )
                return self.async_create_entry(
                    title=entry_title(host, port),
                    data={
                        CONF_HOST: host,
                        CONF_PORT: port,
                        CONF_TOKEN: user_input[CONF_TOKEN],
                    },
                )

        return self.async_show_form(
            step_id="zeroconf_confirm",
            data_schema=_token_schema(),
            errors=errors,
            description_placeholders={"host": host, "port": str(port)},
        )

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            port = user_input[CONF_PORT]

            # Cheap first pass, before any network call: one address is one bridge, so an entry
            # already pointing there is this bridge whatever it calls itself.
            self._async_abort_entries_match({CONF_HOST: host, CONF_PORT: port})

            probe = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if probe.error:
                errors["base"] = probe.error
            else:
                unique_id = probe.bridge_id or address_unique_id(host, port)
                await self.async_set_unique_id(unique_id)
                # Typing the bridge's new address in is the obvious thing to reach for when its
                # entities have gone unavailable, so it heals the existing entry rather than adding
                # a second one — the duplicate that would leave every automation on the dead set.
                known = self._async_known_entry(unique_id, host, port)
                if known is not None:
                    return self._async_abort_known(
                        known, unique_id, host, port, user_input[CONF_TOKEN]
                    )
                return self.async_create_entry(
                    title=entry_title(host, port),
                    data={
                        CONF_HOST: host,
                        CONF_PORT: port,
                        CONF_TOKEN: user_input[CONF_TOKEN],
                    },
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_user_schema(user_input),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start reauthentication — the bridge rejected the token we had stored."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Take a freshly-minted API token and update the existing entry in place."""
        entry = self._get_reauth_entry()
        host: str = entry.data[CONF_HOST]
        port: int = entry.data[CONF_PORT]
        errors: dict[str, str] = {}

        if user_input is not None:
            probe = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if probe.error:
                errors["base"] = probe.error
            else:
                # Only the token changes; the bridge is the same one at the same address, so its
                # identity — and therefore the unique id — is untouched.
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN]}
                )

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=_token_schema(),
            errors=errors,
            description_placeholders={"host": host, "port": str(port)},
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change the bridge's host, port and/or token without losing the entry."""
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}

        if user_input is not None:
            host = user_input[CONF_HOST].strip()
            port = user_input[CONF_PORT]

            # Verified first, because the identity this entry is keyed on comes *from* the bridge:
            # only it can say whether the address now typed in is the bridge this entry has always
            # been, or a different one.
            probe = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if probe.error:
                errors["base"] = probe.error
            else:
                unique_id = probe.bridge_id or address_unique_id(host, port)

                # Re-keying this entry onto another entry's bridge would leave two entries claiming
                # one bridge, so a clash aborts. Only a **different** entry counts — this entry's
                # own id is exactly what is being kept. Ignored entries count too: an mDNS discovery
                # the user dismissed still holds the id, and Home Assistant's index would see it.
                if any(
                    other.entry_id != entry.entry_id and other.unique_id == unique_id
                    for other in self._async_current_entries(include_ignore=True)
                ):
                    return self.async_abort(reason="already_configured")

                # A title the user typed is theirs; only the one this integration generated for the
                # old address is refreshed to the new one.
                renamed = entry.title != entry_title(
                    entry.data[CONF_HOST], entry.data[CONF_PORT]
                )
                return self.async_update_reload_and_abort(
                    entry,
                    unique_id=unique_id,
                    title=UNDEFINED if renamed else entry_title(host, port),
                    data_updates={
                        CONF_HOST: host,
                        CONF_PORT: port,
                        CONF_TOKEN: user_input[CONF_TOKEN],
                    },
                )

        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_user_schema(user_input or dict(entry.data)),
            errors=errors,
        )
