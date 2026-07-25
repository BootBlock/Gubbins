"""Polling coordinators for the bridge's ``/health`` and ``/api/v1/status`` endpoints.

Two of them, one per config entry, because the two reads answer different questions at
different costs: ``/health`` is a cheap liveness probe (and the one the entry's own health
hangs off), while the attention counts come from a scan of the inventory and change no faster
than the snapshot they are read from. Splitting them keeps the fast poll fast.

The health coordinator is created during :func:`.async_setup_entry` (i.e. *before*
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
from dataclasses import dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import GubbinsAuthError, GubbinsClient, GubbinsError, GubbinsUnsupportedError
from .const import HEALTH_SCAN_INTERVAL, STATUS_SCAN_INTERVAL

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


class GubbinsStatusCoordinator(DataUpdateCoordinator[dict[str, int]]):
    """Polls ``GET /api/v1/status`` and shares the per-status attention counts."""

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
            name="Gubbins inventory status",
            update_interval=STATUS_SCAN_INTERVAL,
        )
        self.client = client

    async def _async_update_data(self) -> dict[str, int]:
        try:
            payload = await self.client.statuses()
        except GubbinsAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except GubbinsUnsupportedError as err:
            # The bridge is older than this integration. Say so plainly rather than as a bare
            # "404": the fix is to update the bridge, and the attention sensors simply stay
            # unavailable until it is. Everything else about the entry keeps working.
            raise UpdateFailed(
                "This bridge does not report inventory status yet — update the bridge to "
                "enable the attention sensors."
            ) from err
        except GubbinsError as err:
            raise UpdateFailed(str(err)) from err

        statuses = payload.get("statuses") if isinstance(payload, dict) else None
        if not isinstance(statuses, dict):
            raise UpdateFailed("The bridge returned an unexpected status response.")
        # Keep only the counts that really are counts, so one malformed key cannot make an
        # entity claim something is wrong (or fine) on the strength of a non-numeric value.
        # `bool` is excluded explicitly — in Python it *is* an `int`, so a stray `true` would
        # otherwise sail through as the count 1.
        return {
            key: value
            for key, value in statuses.items()
            if isinstance(value, int) and not isinstance(value, bool)
        }


@dataclass(slots=True)
class GubbinsRuntimeData:
    """The per-entry coordinators, stored on ``entry.runtime_data`` for the platforms."""

    health: GubbinsHealthCoordinator
    status: GubbinsStatusCoordinator
