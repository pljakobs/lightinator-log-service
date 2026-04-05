# Lightinator Log Service

Local-first UDP log collector for Lightinator controllers.

## One-Command User Setup (No make required)

```bash
git clone https://github.com/pljakobs/lightinator-log-service.git
cd lightinator-log-service
./scripts/run-container.sh
```

Update to the latest image without losing logs:

```bash
./scripts/update-container.sh
```

Stop service:

```bash
./scripts/stop-container.sh
```

## Podman Quadlet (systemd auto-start + auto-update)

Quadlet is the recommended install method on systems running Podman ≥ 4.4.
It creates a systemd service that starts on login and automatically updates
whenever a new `:prod` image is published to GHCR.

```bash
mkdir -p ~/.config/containers/systemd
cp quadlet/lightinator-log-service.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now lightinator-log-service
# Enable daily auto-update pulls:
systemctl --user enable --now podman-auto-update.timer
```

Check status and follow logs:

```bash
systemctl --user status lightinator-log-service
journalctl --user -u lightinator-log-service -f
```

Data is stored in `~/lightinator-log-service/data/` (created automatically).
Edit the `Volume=` line in the `.container` file to change the location.

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

## Browser UI

Open `http://<host>:4821/` in a browser. No build step or CDN dependency required — the UI is a single self-contained HTML file served directly from the container.

### Logs tab

- Paginated, newest-first log list with time / tag / application / message columns
- Severity colouring (error = red, warning = yellow)
- Free-text filter
- Auto-refresh every 5 s (toggle off to pause)
- Load-older pagination
- Per-controller log purge

### Controllers tab

- Card grid of all discovered Lightinator controllers
- Shows: name, IP, hostname, device ID, group memberships
- Green online indicator or last-seen timestamp when unreachable
- Per-controller **Logging ON/OFF** toggle
- Manual **Refresh** button

### Loki settings panel (⚙ button)

Configure Loki forwarding without restarting the container:

- Connection URL, username, password (masked)
- Global labels applied to every log entry
- Group label overrides (matched by group name from controller discovery)
- Per-controller extra labels
- Advanced: batch size and flush interval

Settings are persisted to `data/loki.json` (the already-mounted data volume).

## Controller Discovery

When the service receives a UDP log packet from an unknown IP, or on its 5-minute refresh cycle, it:

1. Queries `/hosts` on a seed controller to enumerate all known hostnames + IPs.
2. Queries `/data` to retrieve the groups and controller list.
3. Cross-joins the two responses to build a full controller inventory including group memberships.
4. Feeds discovered group names into the Loki label pipeline automatically.

Configure seeds via the `LLS_DISCOVERY_SEEDS` environment variable (comma-separated hostnames or IPs). The service attempts `lightinator.local` by default.

## Loki Forwarding

Log entries are buffered and pushed to a Loki-compatible endpoint in batches. Label resolution order is:

1. Global labels
2. Group-level label overrides (for the controller's group)
3. Per-controller label overrides

To enable the bundled Loki + Grafana stack (for local development):

```bash
docker compose --profile monitoring up -d
```

The Grafana datasource for Loki is provisioned automatically. Visit `http://localhost:3000` (admin/admin).

## API

### Core

- `GET /health`
- `GET /api/v1/health`
- `GET /api/v1/service-info`
- `GET /api/v1/sources`
- `GET /api/v1/logs?ip=<controller-ip>&limit=200&before=0`
- `DELETE /api/v1/logs?ip=<controller-ip>`
- `DELETE /api/v1/logs?all=true`

`before` is a paging offset from newest backwards.

### Controllers

- `GET /api/v1/controllers` — list all discovered controllers with group memberships and logging state
- `POST /api/v1/controllers/refresh` — trigger immediate re-discovery
- `PATCH /api/v1/controllers/:ip/logging` — `{ "enabled": true|false }`

### Loki

- `GET /api/v1/loki/config` — current Loki configuration (password masked)
- `PUT /api/v1/loki/config` — update Loki configuration
- `POST /api/v1/loki/test` — push a test log entry to verify connectivity

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LLS_HTTP_HOST` | `0.0.0.0` | HTTP bind address |
| `LLS_HTTP_PORT` | `4821` | HTTP port |
| `LLS_UDP_HOST` | `0.0.0.0` | UDP syslog bind address |
| `LLS_UDP_PORT` | `5514` | UDP syslog port |
| `LLS_DATA_DIR` | `/app/data/logs` | Log storage directory |
| `LLS_MAX_BYTES_PER_IP` | `20971520` (20 MB) | Per-controller storage cap |
| `LLS_RETENTION_DAYS` | `7` | Log retention period |
| `LLS_CORS_ORIGIN` | `*` | CORS allowed origin |
| `LLS_SERVICE_NAME` | `LightinatorLogService` | Service name in logs |
| `LLS_MDNS_HOST` | `lightinator-logservice.local` | mDNS hostname |
| `LLS_LOKI_CONFIG` | `data/loki.json` | Path to Loki config file |
| `LLS_DISCOVERY_SEEDS` | `lightinator.local` | Comma-separated seed hosts for controller discovery |
| `LLS_DISCOVERY_PORT` | `80` | HTTP port used to query controllers |
| `LLS_DISCOVERY_REFRESH_MS` | `300000` (5 min) | Controller discovery refresh interval |
