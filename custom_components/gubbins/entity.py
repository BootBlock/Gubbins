"""Shared entity plumbing — the one device every Gubbins entity belongs to.

A config entry is one bridge, so every entity it creates (the ``/health`` sensor, each
attention binary sensor) hangs off a single Home Assistant device. Building that descriptor
in one place is what keeps them together: two platforms composing it separately would drift
the moment one of them changed a field, and Home Assistant would then show two devices for
the same bridge.

The device name deliberately carries **no address**. With ``_attr_has_entity_name`` the entity id is
minted from the device name when the entity is first created, so an address in the name would be
baked into ``sensor.gubbins_bridge_192_0_2_5_8787_inventory_items`` for good — still there long after
the bridge moved to a different address, and misleading from the moment it did. Names of existing
entities are Home Assistant's to keep; this only decides what a newly created one is called.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo

from .const import DOMAIN


def gubbins_device_info(entry: ConfigEntry) -> DeviceInfo:
    """The device descriptor for one configured bridge."""
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name="Gubbins bridge",
        manufacturer="Gubbins",
        model="Inventory bridge",
    )
