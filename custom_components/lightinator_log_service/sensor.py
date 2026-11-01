"""Sensors for Lightinator Log Service."""

from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity, SensorEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import LogServiceCoordinator

SENSORS: tuple[SensorEntityDescription, ...] = (
    SensorEntityDescription(
        key="status",
        name="Service Status",
        icon="mdi:server-check",
    ),
    SensorEntityDescription(
        key="controllers",
        name="Controllers",
        icon="mdi:lightbulb-group",
    ),
    SensorEntityDescription(
        key="sources",
        name="Log Sources",
        icon="mdi:math-log",
    ),
    SensorEntityDescription(
        key="latest_crash",
        name="Latest Crash",
        icon="mdi:alert-circle-outline",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up service sensors."""
    coordinator: LogServiceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        LogServiceSensor(coordinator, entry, description)
        for description in SENSORS
    )


class LogServiceSensor(CoordinatorEntity[LogServiceCoordinator], SensorEntity):
    """Represent one value from the Lightinator Log Service."""

    entity_description: SensorEntityDescription

    def __init__(
        self,
        coordinator: LogServiceCoordinator,
        entry: ConfigEntry,
        description: SensorEntityDescription,
    ) -> None:
        super().__init__(coordinator)
        self.entity_description = description
        self._attr_unique_id = f"{entry.entry_id}_{description.key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="Lightinator Log Service",
            manufacturer="Lightinator",
            model="Log Service",
            configuration_url=entry.data["url"],
        )

    @property
    def native_value(self) -> str | int:
        """Return the current sensor value."""
        if self.entity_description.key == "status":
            return str(self.coordinator.data["health"].get("status", "unknown"))
        if self.entity_description.key == "controllers":
            return len(self.coordinator.data["controllers"])
        if self.entity_description.key == "sources":
            return len(self.coordinator.data["sources"])

        latest_crash = self.coordinator.data["latest_crash"]
        if not latest_crash:
            return "No crashes"
        return str(latest_crash.get("receivedAt") or "Unknown")

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Expose version or latest crash details when available."""
        if self.entity_description.key == "status":
            return {"version": self.coordinator.data["health"].get("version")}
        if self.entity_description.key == "latest_crash":
            crash = self.coordinator.data["latest_crash"]
            if crash:
                return {
                    key: crash.get(key)
                    for key in (
                        "ip",
                        "summary",
                        "message",
                        "pending",
                        "issueUrl",
                        "soc",
                        "gitVersion",
                    )
                }
        return None