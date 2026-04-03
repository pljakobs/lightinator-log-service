# Lightinator Log Service

Local-first UDP log collector for Lightinator controllers.

## One-Command User Setup (No make required)

```bash
git clone https://github.com/pljakobs/lightinator-log-service.git
cd lightinator-log-service
./scripts/run-container.sh
```

Stop service:

```bash
./scripts/stop-container.sh
```

## Build and Run via Makefile

```bash
make help
```

Most common targets:

```bash
make deps
make docker-compose-up
make podman-compose-up
```

Multi-arch publish targets:

```bash
make docker-buildx-push IMAGE=ghcr.io/<owner>/lightinator-log-service TAG=latest
make podman-manifest-push IMAGE=ghcr.io/<owner>/lightinator-log-service TAG=latest
```

## Runtime Ports

- HTTP API: `4821/tcp`
- Syslog ingest: `5514/udp`

## Quick Start (Docker)

```bash
docker compose up -d --build
```

## Quick Start (Podman)

```bash
podman-compose up -d --build
```

If `podman-compose` is not installed, use:

```bash
podman build -t lightinator-log-service:dev -f Containerfile .
podman run -d --name lightinator-log-service \
  --network host \
  -v ./data:/app/data \
  lightinator-log-service:dev
```

## Multi-Arch Image Build (amd64 + arm64)

### Docker Buildx

```bash
docker buildx create --use --name lls-builder || docker buildx use lls-builder
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/your-org/lightinator-log-service:latest \
  -f Dockerfile \
  --push .
```

### Podman Manifest Build

```bash
podman manifest create lightinator-log-service:latest
podman build --platform linux/amd64 --manifest lightinator-log-service:latest -f Containerfile .
podman build --platform linux/arm64 --manifest lightinator-log-service:latest -f Containerfile .
podman manifest push --all lightinator-log-service:latest docker://ghcr.io/your-org/lightinator-log-service:latest
```

## GitHub Actions CI

Workflow file: `.github/workflows/container-image.yml`

Behavior:
- On pull requests: build multi-arch image (`linux/amd64`, `linux/arm64`) without push.
- On pushes to `main`, `master`, or `develop`: build and publish to GHCR.
- On tags matching `v*`: build and publish to GHCR.

Published image name:
- `ghcr.io/<owner>/<repo>`

## API (MVP)

- `GET /health`
- `GET /api/v1/health`
- `GET /api/v1/service-info`
- `GET /api/v1/sources`
- `GET /api/v1/logs?ip=<controller-ip>&limit=200&before=0`
- `DELETE /api/v1/logs?ip=<controller-ip>`
- `DELETE /api/v1/logs?all=true`

`before` is paging offset from newest backwards.

## Environment Variables

- `LLS_HTTP_HOST` (default `0.0.0.0`)
- `LLS_HTTP_PORT` (default `4821`)
- `LLS_UDP_HOST` (default `0.0.0.0`)
- `LLS_UDP_PORT` (default `5514`)
- `LLS_DATA_DIR` (default `/app/data/logs` in container)
- `LLS_MAX_BYTES_PER_IP` (default `20971520`)
- `LLS_RETENTION_DAYS` (default `7`)
- `LLS_CORS_ORIGIN` (default `*`)
- `LLS_SERVICE_NAME` (default `LightinatorLogService`)
- `LLS_MDNS_HOST` (default `lightinator-logservice.local`)
