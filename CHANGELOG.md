# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [Unreleased]

### Added

- **Browser UI** — self-contained single-file log viewer served at `/`. No build step or CDN dependency. Works offline on a LAN.
  - Paginated log list (newest-first) with severity colouring, free-text filter, auto-refresh, load-older pagination, per-controller purge.
  - **Controllers tab**: card grid showing name, IP, hostname, device ID, group memberships, reachability indicator, and per-controller Logging ON/OFF toggle.
  - **⚙ Loki settings panel**: configure forwarding URL, credentials, global/group/per-controller labels, and advanced options (batch size, flush interval). Settings persisted to `data/loki.json`.

- **Loki log forwarding** (`src/loki.js`) — batched push to any Loki-compatible endpoint.
  - Basic auth support; password masked (`••••••••`) in all API responses.
  - Configurable batch size and flush interval.
  - `POST /api/v1/loki/test` endpoint to verify connectivity.
  - Label resolution precedence: global → group → per-controller.

- **Controller discovery** (`src/discovery.js`) — automatic inventory of Lightinator controllers on the local network.
  - Queries `/hosts` + `/data` from a seed controller and cross-joins to build a full controller map including group memberships.
  - Triggers on first UDP packet from an unknown IP, and refreshes every 5 minutes.
  - Discovered group names injected into the Loki label pipeline automatically.
  - Configurable via `LLS_DISCOVERY_SEEDS`, `LLS_DISCOVERY_PORT`, `LLS_DISCOVERY_REFRESH_MS`.

- **Controller API endpoints**:
  - `GET /api/v1/controllers` — list all discovered controllers.
  - `POST /api/v1/controllers/refresh` — trigger immediate re-discovery.
  - `PATCH /api/v1/controllers/:ip/logging` — enable or disable log forwarding per controller.

- **Loki API endpoints**:
  - `GET /api/v1/loki/config`
  - `PUT /api/v1/loki/config`
  - `POST /api/v1/loki/test`

- **Monitoring compose profile** — `docker compose --profile monitoring up -d` starts Loki and Grafana with an auto-provisioned datasource.

- Environment variables: `LLS_LOKI_CONFIG`, `LLS_DISCOVERY_SEEDS`, `LLS_DISCOVERY_PORT`, `LLS_DISCOVERY_REFRESH_MS`.

---

## [0.1.0] — Initial release

- UDP syslog ingest on port 5514.
- Per-controller NDJSON log storage with configurable size cap and retention.
- REST API: sources, logs (paginated), purge.
- Health and service-info endpoints.
- Docker / Podman / docker-compose / podman-compose support.
- Multi-arch container image (amd64 + arm64) published to GHCR via GitHub Actions.
- mDNS advertisement via `LLS_MDNS_HOST`.
