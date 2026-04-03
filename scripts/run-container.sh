#!/usr/bin/env sh
set -eu

IMAGE="${LIGHTINATOR_LOG_IMAGE:-ghcr.io/pljakobs/lightinator-log-service:latest}"
CONTAINER_NAME="${LIGHTINATOR_LOG_CONTAINER_NAME:-lightinator-log-service}"
HTTP_PORT="${LIGHTINATOR_LOG_HTTP_PORT:-4821}"
UDP_PORT="${LIGHTINATOR_LOG_UDP_PORT:-5514}"
DATA_DIR="${LIGHTINATOR_LOG_DATA_DIR:-$PWD/data}"

mkdir -p "$DATA_DIR"

if command -v podman >/dev/null 2>&1; then
  RUNTIME="podman"
elif command -v docker >/dev/null 2>&1; then
  RUNTIME="docker"
else
  echo "Error: neither podman nor docker was found." >&2
  exit 1
fi

echo "Using container runtime: $RUNTIME"
echo "Image: $IMAGE"

if [ "$RUNTIME" = "podman" ]; then
  if ! podman image exists "$IMAGE"; then
    podman pull "$IMAGE"
  fi
  if podman container exists "$CONTAINER_NAME"; then
    podman rm -f "$CONTAINER_NAME" >/dev/null
  fi
  podman run -d \
    --name "$CONTAINER_NAME" \
    --network host \
    -v "$DATA_DIR:/app/data:Z" \
    -e LLS_HTTP_PORT="$HTTP_PORT" \
    -e LLS_UDP_PORT="$UDP_PORT" \
    "$IMAGE" >/dev/null
else
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker pull "$IMAGE"
  fi
  if docker ps -a --format '{{.Names}}' | grep -Fx "$CONTAINER_NAME" >/dev/null; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi
  docker run -d \
    --name "$CONTAINER_NAME" \
    --network host \
    -v "$DATA_DIR:/app/data" \
    -e LLS_HTTP_PORT="$HTTP_PORT" \
    -e LLS_UDP_PORT="$UDP_PORT" \
    "$IMAGE" >/dev/null
fi

echo "Started $CONTAINER_NAME"
echo "Health check: http://127.0.0.1:${HTTP_PORT}/health"
