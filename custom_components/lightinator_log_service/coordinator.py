"""Data update coordinator for Lightinator Log Service."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import UPDATE_INTERVAL

_LOGGER = logging.getLogger(__name__)


class LogServiceCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Poll service health, controller inventory, sources, and recent crashes."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        session: aiohttp.ClientSession,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name="Lightinator Log Service",
            update_interval=UPDATE_INTERVAL,
        )
        self._base_url: str = entry.data["url"]
        self._session = session

    async def _get_json(self, path: str) -> Any:
        async with self._session.get(
            f"{self._base_url}{path}",
            timeout=aiohttp.ClientTimeout(total=10),
        ) as response:
            response.raise_for_status()
            return await response.json()

    async def _async_update_data(self) -> dict[str, Any]:
        """Fetch all data used by the integration's sensors."""
        try:
            health, controllers, sources, crashes = await asyncio.gather(
                self._get_json("/api/v1/health"),
                self._get_json("/api/v1/controllers"),
                self._get_json("/api/v1/sources"),
                self._get_json("/api/v1/crashes?limit=1"),
            )
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise UpdateFailed(f"Could not fetch Lightinator Log Service data: {err}") from err

        if not all(isinstance(value, dict) for value in (health, controllers, sources, crashes)):
            raise UpdateFailed("Lightinator Log Service returned an invalid response")

        controller_items = controllers.get("items")
        source_items = sources.get("items")
        crash_items = crashes.get("items")
        if not all(isinstance(items, list) for items in (controller_items, source_items, crash_items)):
            raise UpdateFailed("Lightinator Log Service returned invalid item lists")

        return {
            "health": health,
            "controllers": controller_items,
            "sources": source_items,
            "latest_crash": crash_items[0] if crash_items else None,
        }