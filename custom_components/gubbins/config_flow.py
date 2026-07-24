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
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo

from .api import GubbinsAuthError, GubbinsClient, GubbinsConnectionError
from .const import CONF_HOST, CONF_PORT, CONF_TOKEN, DEFAULT_PORT, DOMAIN


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

    async def _async_verify(self, host: str, port: int, token: str) -> str | None:
        """Probe ``GET /health``; return a form error key, or ``None`` when it succeeded."""
        client = GubbinsClient(async_get_clientsession(self.hass), host, port, token)
        try:
            await client.health()
        except GubbinsAuthError:
            return "invalid_auth"
        except GubbinsConnectionError:
            return "cannot_connect"
        return None

    async def async_step_zeroconf(
        self, discovery_info: ZeroconfServiceInfo
    ) -> ConfigFlowResult:
        """Handle a bridge discovered over mDNS / zeroconf.

        The advertisement carries host/port (and a non-secret TXT record) but **never** the
        token, so this only pre-fills the connection details and then asks for the token.
        """
        host = discovery_info.host
        port = discovery_info.port or DEFAULT_PORT

        await self.async_set_unique_id(f"{host}:{port}")
        self._abort_if_unique_id_configured(
            updates={CONF_HOST: host, CONF_PORT: port}
        )

        self._discovered_host = host
        self._discovered_port = port
        # Shown in the discovered-integration card and the confirm dialog title.
        self.context["title_placeholders"] = {"name": f"Gubbins ({host}:{port})"}
        return await self.async_step_zeroconf_confirm()

    async def async_step_zeroconf_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the (never-advertised) token and verify the discovered bridge."""
        errors: dict[str, str] = {}
        host = self._discovered_host or ""
        port = self._discovered_port

        if user_input is not None:
            error = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=f"Gubbins ({host}:{port})",
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

            await self.async_set_unique_id(f"{host}:{port}")
            self._abort_if_unique_id_configured()

            error = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if error:
                errors["base"] = error
            else:
                return self.async_create_entry(
                    title=f"Gubbins ({host}:{port})",
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
            error = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if error:
                errors["base"] = error
            else:
                # Only the token changes; host/port (and so the unique id) are untouched.
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
            unique_id = f"{host}:{port}"

            # The unique id is the bridge's *address*, so moving the bridge legitimately
            # changes it and only a **different** entry already sitting there is a clash.
            # Hence the explicit scan rather than `_abort_if_unique_id_configured`, which
            # would abort a token-only reconfigure against this entry's own address.
            if any(
                other.entry_id != entry.entry_id and other.unique_id == unique_id
                for other in self._async_current_entries(include_ignore=False)
            ):
                return self.async_abort(reason="already_configured")

            error = await self._async_verify(host, port, user_input[CONF_TOKEN])
            if error:
                errors["base"] = error
            else:
                return self.async_update_reload_and_abort(
                    entry,
                    unique_id=unique_id,
                    title=f"Gubbins ({host}:{port})",
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
