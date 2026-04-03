#!/usr/bin/env sh
set -eu

CONTAINER_NAME="${LIGHTINATOR_LOG_CONTAINER_NAME:-lightinator-log-service}"

if command -v podman >/dev/null 2>&1; then
  podman rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  echo "Stopped (if running): $CONTAINER_NAME via podman"
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  echo "Stopped (if running): $CONTAINER_NAME via docker"
  exit 0
fi

echo "No docker/podman runtime found." >&2
exit 1
