"""Shared entity plumbing — the one device every Gubbins entity belongs to.

A config entry is one bridge, so every entity it creates (the ``/health`` sensor, each
attention binary sensor) hangs off a single Home Assistant device. Building that descriptor
in one place is what keeps them together: two platforms composing it separately would drift
the moment one of them changed a field, and Home Assistant would then show two devices for
the same bridge.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo

from .const import CONF_HOST, CONF_PORT, DOMAIN


def gubbins_device_info(entry: ConfigEntry) -> DeviceInfo:
    """The device descriptor for one configured bridge."""
    return DeviceInfo(
        identifiers={(DOMAIN, entry.entry_id)},
        name=f"Gubbins bridge ({entry.data[CONF_HOST]}:{entry.data[CONF_PORT]})",
        manufacturer="Gubbins",
        model="Inventory bridge",
    )
