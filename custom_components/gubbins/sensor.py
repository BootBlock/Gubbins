"""Optional /health sensor for dashboards.

Exposes the bridge's item count as a sensor, with the snapshot timestamp and liveness as
attributes — handy for a dashboard card or an automation that reacts to the bridge going
away. Read-only and cheap: it rides the shared :class:`.GubbinsHealthCoordinator`, which
polls ``GET /health`` on a slow interval. For "does anything need attention?" rather than
"how much is there?", see the attention binary sensors in :mod:`.binary_sensor`.

The coordinator is built and first-refreshed by the integration's own ``async_setup_entry``,
not here — a forwarded platform must not raise ``ConfigEntryNotReady`` /
``ConfigEntryAuthFailed``, so the "bridge is down" and "token was revoked" outcomes have to
be decided before the platforms are forwarded.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import GubbinsHealthCoordinator, GubbinsRuntimeData
from .entity import gubbins_device_info


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the bridge health sensor for a config entry."""
    runtime: GubbinsRuntimeData = entry.runtime_data
    async_add_entities([GubbinsItemCountSensor(runtime.health, entry)])


class GubbinsItemCountSensor(CoordinatorEntity, SensorEntity):
    """Number of active items the bridge currently sees."""

    _attr_has_entity_name = True
    _attr_name = "Inventory items"
    _attr_icon = "mdi:package-variant-closed"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(
        self,
        coordinator: GubbinsHealthCoordinator,
        entry: ConfigEntry,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_item_count"
        self._attr_device_info = gubbins_device_info(entry)

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
