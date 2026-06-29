"""Optional /health sensor for dashboards.

Exposes the bridge's item count as a sensor, with the snapshot timestamp and liveness as
attributes — handy for a dashboard card or an automation that reacts to the bridge going
away. Read-only and cheap: it polls ``GET /health`` on a slow interval.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import (
    CoordinatorEntity,
    DataUpdateCoordinator,
    UpdateFailed,
)

from .api import GubbinsClient, GubbinsError
from .const import CONF_HOST, CONF_PORT, DOMAIN, HEALTH_SCAN_INTERVAL

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the bridge health sensor for a config entry."""
    client: GubbinsClient = hass.data[DOMAIN][entry.entry_id]

    async def _fetch() -> dict[str, Any]:
        try:
            return await client.health()
        except GubbinsError as err:
            raise UpdateFailed(str(err)) from err

    coordinator: DataUpdateCoordinator[dict[str, Any]] = DataUpdateCoordinator(
        hass,
        logger=_LOGGER,
        name="Gubbins bridge health",
        update_method=_fetch,
        update_interval=HEALTH_SCAN_INTERVAL,
    )
    await coordinator.async_config_entry_first_refresh()
    async_add_entities([GubbinsItemCountSensor(coordinator, entry)])


class GubbinsItemCountSensor(CoordinatorEntity, SensorEntity):
    """Number of active items the bridge currently sees."""

    _attr_has_entity_name = True
    _attr_name = "Inventory items"
    _attr_icon = "mdi:package-variant-closed"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        coordinator: DataUpdateCoordinator[dict[str, Any]],
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_item_count"
        host = entry.data[CONF_HOST]
        port = entry.data[CONF_PORT]
        self._attr_device_info = {
            "identifiers": {(DOMAIN, entry.entry_id)},
            "name": f"Gubbins bridge ({host}:{port})",
            "manufacturer": "Gubbins",
            "model": "Inventory bridge",
        }

    @property
    def native_value(self) -> int | None:
        data = self.coordinator.data or {}
        value = data.get("itemCount")
        return value if isinstance(value, int) else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self.coordinator.data or {}
        return {
            "ok": data.get("ok"),
            "snapshot_generated_at": data.get("snapshotGeneratedAt"),
        }
