"""Constants for the Lightinator Log Service integration."""

from datetime import timedelta

DOMAIN = "lightinator_log_service"
PLATFORMS = ["sensor"]
DEFAULT_URL = "http://lightinator-logservice.local:4821"
UPDATE_INTERVAL = timedelta(seconds=60)