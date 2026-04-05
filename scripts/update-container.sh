#!/usr/bin/env sh
# update-container.sh
# Pull the latest Lightinator Log Service image and restart the container.
# All settings are read from the same environment variables as run-container.sh.
set -eu

IMAGE="${LIGHTINATOR_LOG_IMAGE:-ghcr.io/pljakobs/lightinator-log-service:latest}"
CONTAINER_NAME="${LIGHTINATOR_LOG_CONTAINER_NAME:-lightinator-log-service}"
HTTP_PORT="${LIGHTINATOR_LOG_HTTP_PORT:-4821}"
UDP_PORT="${LIGHTINATOR_LOG_UDP_PORT:-5514}"
DATA_DIR="${LIGHTINATOR_LOG_DATA_DIR:-$PWD/data}"

if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "Error: neither podman nor docker was found." >&2
  exit 1
fi

echo "Runtime : $RUNTIME"
echo "Image   : $IMAGE"

# ── Pull latest image ────────────────────────────────────────────────────────
echo "Pulling latest image…"
$RUNTIME pull "$IMAGE"

# ── Stop and remove existing container (if running) ─────────────────────────
if [ "$RUNTIME" = "podman" ]; then
  if podman container exists "$CONTAINER_NAME"; then
    echo "Stopping $CONTAINER_NAME…"
    podman rm -f "$CONTAINER_NAME" >/dev/null
  fi
else
  if docker ps -a --format '{{.Names}}' | grep -Fx "$CONTAINER_NAME" >/dev/null 2>&1; then
    echo "Stopping $CONTAINER_NAME…"
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
fi

# ── Start new container ──────────────────────────────────────────────────────
mkdir -p "$DATA_DIR"

if [ "$RUNTIME" = "podman" ]; then
  podman run -d \
    --name "$CONTAINER_NAME" \
    --network host \
    -v "$DATA_DIR:/app/data:Z" \
    -e LLS_HTTP_PORT="$HTTP_PORT" \
    -e LLS_UDP_PORT="$UDP_PORT" \
    "$IMAGE" >/dev/null
else
  docker run -d \
    --name "$CONTAINER_NAME" \
    --network host \
    -v "$DATA_DIR:/app/data" \
    -e LLS_HTTP_PORT="$HTTP_PORT" \
    -e LLS_UDP_PORT="$UDP_PORT" \
    "$IMAGE" >/dev/null
fi

echo "Updated and started $CONTAINER_NAME"
echo "Health: http://127.0.0.1:${HTTP_PORT}/health"
