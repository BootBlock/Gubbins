"""Polling coordinator for the bridge's ``/health`` endpoint.

One coordinator per config entry, created during :func:`.async_setup_entry` (i.e. *before*
the platforms are forwarded) so that a bridge which is down or a token which has been
revoked fails the entry itself rather than a single platform:

* an unreachable bridge raises :class:`ConfigEntryNotReady`, so Home Assistant retries with
  backoff instead of leaving a permanently-unavailable entity behind;
* a rejected token raises :class:`ConfigEntryAuthFailed`, which starts the reauthentication
  flow (see :mod:`.config_flow`) so the user can paste a freshly-minted API token without
  deleting and re-adding the entry.

The coordinator is constructed with an explicit ``config_entry``. Home Assistant deprecated
the implicit context-variable lookup — without it the coordinator cannot link a failure back
to its entry, so it could neither start reauthentication nor be cleaned up with the entry.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import GubbinsAuthError, GubbinsClient, GubbinsError
from .const import HEALTH_SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


class GubbinsHealthCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Polls ``GET /health`` on a slow interval and shares the result."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        client: GubbinsClient,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name="Gubbins bridge health",
            update_interval=HEALTH_SCAN_INTERVAL,
        )
        self.client = client

    async def _async_update_data(self) -> dict[str, Any]:
        try:
            return await self.client.health()
        except GubbinsAuthError as err:
            # Raising this (rather than UpdateFailed) is what starts the reauth flow — both
            # on the first refresh and on any later poll, once the token has been revoked.
            raise ConfigEntryAuthFailed(str(err)) from err
        except GubbinsError as err:
            raise UpdateFailed(str(err)) from err
