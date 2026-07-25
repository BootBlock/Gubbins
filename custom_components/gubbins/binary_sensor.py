"""Attention binary sensors — "is anything in the inventory asking for attention?".

One entity per attention status the bridge reports (low stock, out of stock, on order,
expiring, warranty expiring, on loan, overdue, maintenance due), each simply on when at least
one item matches it. The exact figure rides along as a ``count`` attribute, so an automation
can say "notify me when more than five things are low" without a second entity per status.

These are the *same* counts the app's own inventory filter chips show — the bridge derives
them from the app's own predicates — so a dashboard and the app can never disagree about how
many items are low.

The statuses that describe a problem carry ``BinarySensorDeviceClass.PROBLEM``, so Home
Assistant renders them as OK/Problem rather than Off/On. *On order* and *on loan* deliberately
do not: something being on its way, or out with someone, is a normal state of affairs.

Read-only and cheap: the entities ride the shared :class:`.GubbinsStatusCoordinator`, which
polls ``GET /api/v1/status`` on a slow interval. A bridge that predates that endpoint leaves
them unavailable rather than failing the config entry — see :meth:`.GubbinsClient.statuses`.
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .coordinator import GubbinsRuntimeData, GubbinsStatusCoordinator
from .entity import gubbins_device_info

# The `key` of each description is the bridge's own status key, verbatim — the response is
# keyed by exactly these, so there is no mapping table to keep in step.
STATUS_DESCRIPTIONS: tuple[BinarySensorEntityDescription, ...] = (
    BinarySensorEntityDescription(
        key="low-stock",
        name="Low stock",
        icon="mdi:package-down",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
    BinarySensorEntityDescription(
        key="out-of-stock",
        name="Out of stock",
        icon="mdi:package-variant-remove",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
    BinarySensorEntityDescription(
        key="on-order",
        name="On order",
        icon="mdi:truck-delivery-outline",
    ),
    BinarySensorEntityDescription(
        key="expiring",
        name="Expiring soon",
        icon="mdi:calendar-clock",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
    BinarySensorEntityDescription(
        key="warranty",
        name="Warranty expiring",
        icon="mdi:shield-alert-outline",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
    BinarySensorEntityDescription(
        key="on-loan",
        name="On loan",
        icon="mdi:account-arrow-right-outline",
    ),
    BinarySensorEntityDescription(
        key="overdue",
        name="Overdue loans",
        icon="mdi:calendar-alert",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
    BinarySensorEntityDescription(
        key="maintenance-due",
        name="Maintenance due",
        icon="mdi:wrench-clock",
        device_class=BinarySensorDeviceClass.PROBLEM,
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up one attention binary sensor per status for a config entry."""
    runtime: GubbinsRuntimeData = entry.runtime_data
    async_add_entities(
        GubbinsStatusBinarySensor(runtime.status, entry, description)
        for description in STATUS_DESCRIPTIONS
    )


class GubbinsStatusBinarySensor(CoordinatorEntity[GubbinsStatusCoordinator], BinarySensorEntity):
    """On whenever at least one active item matches this attention status."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: GubbinsStatusCoordinator,
        entry: ConfigEntry,
        description: BinarySensorEntityDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        # The status key, not the display name, so renaming an entity later cannot orphan the
        # entity registry entry (and with it any automation or history pointing at it).
        self._attr_unique_id = f"{entry.entry_id}_status_{description.key}"
        self._attr_device_info = gubbins_device_info(entry)

    @property
    def _count(self) -> int | None:
        """This status's count, or None when the bridge did not report it."""
        return (self.coordinator.data or {}).get(self.entity_description.key)

    @property
    def available(self) -> bool:
        # A status the bridge omits has no truthful on/off answer — reporting it as "off"
        # would assert that nothing is overdue when in fact nothing was said about it.
        return super().available and self._count is not None

    @property
    def is_on(self) -> bool | None:
        count = self._count
        return None if count is None else count > 0

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"count": self._count}
