"""Config flow for Lightinator Log Service."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_URL, DOMAIN


def _normalize_url(value: str) -> str:
    """Validate and normalize a base URL for the service API."""
    parsed = urlsplit(value.strip())
    try:
        parsed.port
    except ValueError as err:
        raise ValueError("Invalid port") from err

    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Enter an HTTP or HTTPS base URL without a path")

    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


class LogServiceConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for the Lightinator Log Service."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Validate the service URL and create the config entry."""
        return await self._async_step_url("user", user_input)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change the URL without replacing the existing entry or entities."""
        return await self._async_step_url("reconfigure", user_input)

    async def _async_step_url(
        self, step_id: str, user_input: dict[str, Any] | None
    ) -> ConfigFlowResult:
        """Validate a URL for initial setup or reconfiguration."""
        entry = self._get_reconfigure_entry() if step_id == "reconfigure" else None
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                base_url = _normalize_url(user_input["url"])
            except (KeyError, ValueError):
                errors["base"] = "invalid_url"
            else:
                try:
                    async with async_get_clientsession(self.hass).get(
                        f"{base_url}/api/v1/health",
                        timeout=aiohttp.ClientTimeout(total=8),
                    ) as response:
                        response.raise_for_status()
                        health = await response.json()
                except (aiohttp.ClientError, TimeoutError, ValueError):
                    errors["base"] = "cannot_connect"
                else:
                    if not isinstance(health, dict) or health.get("status") != "ok":
                        errors["base"] = "invalid_response"
                    else:
                        if entry is not None:
                            if any(
                                other.entry_id != entry.entry_id
                                and (other.data.get("url") == base_url or other.unique_id == base_url)
                                for other in self._async_current_entries()
                            ):
                                return self.async_abort(reason="already_configured")
                            self.hass.config_entries.async_update_entry(
                                entry, unique_id=base_url, title=urlsplit(base_url).netloc
                            )
                            return self.async_update_reload_and_abort(
                                entry,
                                data_updates={"url": base_url},
                            )
                        await self.async_set_unique_id(base_url)
                        self._abort_if_unique_id_configured()
                        return self.async_create_entry(
                            title=urlsplit(base_url).netloc,
                            data={"url": base_url},
                        )

        return self.async_show_form(
            step_id=step_id,
            data_schema=vol.Schema(
                {vol.Required("url", default=entry.data["url"] if entry else DEFAULT_URL): str}
            ),
            errors=errors,
        )