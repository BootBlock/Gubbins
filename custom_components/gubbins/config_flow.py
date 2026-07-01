"""UI config flow for the Gubbins inventory bridge.

Captures the bridge **host, port and token** in the Home Assistant UI. The token is
stored by Home Assistant in its config-entry store — it is never written to YAML or to
this repository. The flow verifies the connection (and the token) by calling
``GET /health`` before creating the entry.

Two entry points share that verification:

* the manual :meth:`async_step_user` flow (host/port/token typed in), and
* :meth:`async_step_zeroconf` — when the bridge advertises itself over mDNS (the bridge's
  opt-in ``GUBBINS_BRIDGE_MDNS=on``, only when LAN-exposed), Home Assistant auto-discovers
  it and pre-fills the host/port. The **token is never advertised**, so the user still
  enters it. The manual flow keeps working unchanged as a fallback.
"""

from __future__ import annotations

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
            client = GubbinsClient(
                async_get_clientsession(self.hass),
                host,
                port,
                user_input[CONF_TOKEN],
            )
            try:
                await client.health()
            except GubbinsAuthError:
                errors["base"] = "invalid_auth"
            except GubbinsConnectionError:
                errors["base"] = "cannot_connect"
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

            client = GubbinsClient(
                async_get_clientsession(self.hass),
                host,
                port,
                user_input[CONF_TOKEN],
            )
            try:
                await client.health()
            except GubbinsAuthError:
                errors["base"] = "invalid_auth"
            except GubbinsConnectionError:
                errors["base"] = "cannot_connect"
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
