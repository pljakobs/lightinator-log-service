# Lightinator Log Service

Local-first UDP log collector and viewer for Lightinator controllers.

## Overview

`lightinator-log-service` is a lightweight Node.js service that runs on any
LAN host (or in a container) and acts as a **syslog sink** for Lightinator
ESP8266/ESP32 firmware devices.  Because browsers cannot receive UDP packets
directly, and because the ESP8266 has very little free heap (~27 kB), the
firmware simply fire-and-forgets UDP syslog datagrams.  This service receives,
parses, stores, and displays those logs — all without any cloud dependency.

Key capabilities:

| Capability | Details |
|---|---|
| **UDP syslog ingest** | Listens on `5514/udp` (configurable); parses the Lightinator syslog dialect |
| **Per-controller file storage** | One NDJSON file per source IP; bounded by size and age |
| **Browser UI** | Self-contained single-file SPA at `/`; no build step needed |
| **Controller discovery** | Auto-discovers all controllers via seed REST APIs and group memberships |
| **Logging toggle** | Remotely enable/disable rsyslog on individual controllers |
| **Loki forwarding** | Batched push to any Loki-compatible endpoint with per-group label overrides |
| **Crash decoder** | Detects ESP crash dumps, downloads ELF, runs `decode-stacktrace.py`, and appends human-readable output |
| **mDNS advertisement** | Announces itself on LAN so the firmware and webapp can find it with zero config |

---

## Table of Contents

1. [Architecture](#architecture)
2. [Source Code Structure](#source-code-structure)
3. [Data Flow](#data-flow)
4. [Key Technologies](#key-technologies)
5. [Installation](#installation)
6. [Configuration Reference](#configuration-reference)
7. [REST API Reference](#rest-api-reference)
8. [Browser UI](#browser-ui)
9. [Loki Forwarding](#loki-forwarding)
10. [Controller Discovery](#controller-discovery)
11. [Crash Decoder](#crash-decoder)
12. [Development](#development)
13. [Container Build & CI](#container-build--ci)
14. [Deployment Options](#deployment-options)

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│              Lightinator firmware (ESP)         │
│   UDP syslog fire-and-forget  →  5514/udp       │
└───────────────────────┬─────────────────────────┘
                        │ UDP datagrams
                        ▼
┌─────────────────────────────────────────────────┐
│         lightinator-log-service (Node.js)       │
│                                                 │
│  ┌──────────────┐    ┌────────────────────────┐ │
│  │  UDP Server  │───▶│   syslogParser.js      │ │
│  └──────────────┘    └──────────┬─────────────┘ │
│                                 │ LogRecord      │
│           ┌─────────────────────┼──────────┐    │
│           │                     │          │    │
│           ▼                     ▼          ▼    │
│  ┌──────────────┐  ┌──────────────┐  ┌────────┐│
│  │  storage.js  │  │   loki.js    │  │crash   ││
│  │  (NDJSON /IP)│  │  (forwarder) │  │Decoder ││
│  └──────────────┘  └──────────────┘  └────────┘│
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │         Express HTTP API  (4821/tcp)     │   │
│  │  /api/v1/logs  /api/v1/controllers  …   │   │
│  │  Static SPA: src/ui/index.html          │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌──────────────┐  ┌────────────────────────┐   │
│  │  mdns.js     │  │  discovery.js          │   │
│  │  (Bonjour)   │  │  (controller REST poll)│   │
│  └──────────────┘  └────────────────────────┘   │
└─────────────────────────────────────────────────┘
                        │ HTTP
                        ▼
┌─────────────────────────────────────────────────┐
│            Browser / Lightinator webapp         │
│   SPA at http://lightinator-logservice.local    │
└─────────────────────────────────────────────────┘
```

---

## Source Code Structure

```
lightinator-log-service/
├── src/
│   ├── index.js           # Entry point: wires all modules, starts HTTP + UDP servers
│   ├── config.js          # Reads LLS_* env vars with defaults
│   ├── syslogParser.js    # Parses Lightinator syslog dialect into LogRecord objects
│   ├── storage.js         # Per-IP NDJSON file storage with size-capped rotation
│   ├── loki.js            # Batched Loki push forwarder with label resolution
│   ├── discovery.js       # Controller discovery via /hosts + /data REST cross-join
│   ├── mdns.js            # Bonjour/mDNS advertisement of HTTP and UDP services
│   ├── crashDecoder.js    # Detects crash dumps, fetches ELF, runs decode script
│   ├── serviceConfig.js   # Read/write data/service.env via UI
│   └── ui/
│       └── index.html     # Self-contained SPA (no build step, no CDN)
├── config/
│   ├── service.env.example             # Annotated env config template
│   └── grafana/provisioning/
│       └── datasources/loki.yaml       # Auto-provisioned Grafana→Loki datasource
├── quadlet/
│   └── lightinator-log-service.container  # Podman Quadlet systemd unit
├── scripts/
│   ├── run-container.sh        # One-command container start
│   ├── stop-container.sh       # Stop + remove container
│   └── update-container.sh     # Pull latest image, restart container
├── .github/workflows/
│   └── container-image.yml     # CI: build multi-arch image, push to GHCR
├── Dockerfile                  # Multi-stage: sming-tools → Node 22 production image
├── Containerfile               # Podman equivalent of Dockerfile
├── compose.yml                 # Docker/Podman Compose with optional monitoring profile
├── Makefile                    # Dev/build/run convenience targets
├── loki-local.yaml             # Loki config for local monitoring stack
├── install.sh                  # Convenience installer script
├── package.json                # Node.js project manifest (express, cors, bonjour-service)
├── DESIGN.md                   # Original design document and architecture decisions
└── CHANGELOG.md                # Release history
```

### Module descriptions

#### `src/index.js` — Entry point

Orchestrates startup:
1. Ensures data directories exist.
2. Initialises `LogStorage`, `LokiForwarder`, `CrashDecoder`, `ControllerDiscovery`.
3. Resolves the syslog advertise IP (the address controllers should send UDP to).
4. Registers all Express routes.
5. Starts the UDP syslog socket.
6. Starts mDNS advertisement.
7. Handles `SIGINT`/`SIGTERM` for graceful shutdown.

#### `src/config.js` — Configuration

Reads `LLS_*` environment variables with sensible defaults.  All settings are
centralised here; no other module reads `process.env` directly.

#### `src/syslogParser.js` — Syslog parser

Parses the Lightinator syslog dialect:

```
<priority> <tag> <app>: [nonce:<nonce>] [<deviceTime>] <message>
```

Returns a `LogRecord`:

```json
{
  "id": "1712174380123-a3f8c2",
  "receivedAt": "2026-04-03T21:39:40.979Z",
  "sourceIp": "192.168.29.125",
  "priority": 191,
  "tag": "LED_Be",
  "app": "Lightinator",
  "deviceTime": 3330072694,
  "bootNonce": 7,
  "message": "Not enough heap free, rejecting request. Free heap: 5104",
  "raw": "<191>LED_Be Lightinator: nonce:7 3330072694 Not enough heap ..."
}
```

Lines that do not match the regex are stored as-is with all structured fields
set to `null`.

#### `src/storage.js` — Log storage

Stores log records as newline-delimited JSON (NDJSON), one file per source IP
at `<dataDir>/<ip>.ndjson`.  When a file exceeds `maxBytesPerIp`, the oldest
bytes are truncated (the partial first line is also discarded to keep every
line valid JSON).  An in-memory `sourceMeta` map tracks the last-seen time and
byte size for each IP, loaded from file stats on startup.

Key methods:

| Method | Description |
|---|---|
| `init()` | Scans dataDir, populates sourceMeta from existing files |
| `append(ip, record)` | Appends one JSON line, then trims if over the size cap |
| `getLogs({ ip, limit, before })` | Returns a page of records (newest-first) |
| `listSources()` | Returns all known IPs sorted by last-seen |
| `purgeIp(ip)` | Deletes the file for one IP |
| `purgeAll()` | Deletes all NDJSON files |

#### `src/loki.js` — Loki forwarder

Buffers log records and flushes them to a Loki-compatible `POST /loki/api/v1/push`
endpoint in batches.  Configuration is persisted to `data/loki.json` and loaded
on startup.

Label resolution priority (lower overrides higher):

1. **Global labels** — apply to every log entry
2. **Group labels** — matched by the controller's group name
3. **Per-controller labels** — matched by source IP

Additional automatic stream labels: `host` (= tag field), `source_ip`, `tag`.

The password field is masked (`••••••••`) in all API responses.

#### `src/discovery.js` — Controller discovery

Queries the Lightinator controller REST API to build a full inventory:

1. `GET /hosts?all=true` → all known hostnames + IPs on the controller mesh
2. `GET /data` → group definitions and controller-to-group membership
3. Cross-joins these two responses to attach group names to each IP.
4. Queries `GET /config` and `GET /info?v=2` on every reachable controller to
   read the live `rsyslog.enabled` state, SOC type, build type, and git version.
5. Detects **split-brain** conditions: controllers not visible from all peers.
6. Persists the inventory to `data/controllers.json` so it survives restarts.

Refreshes automatically every 5 minutes (configurable) and also triggers
immediately when a UDP packet arrives from a previously unseen IP.

#### `src/mdns.js` — mDNS advertisement

Uses the `bonjour-service` package to advertise two mDNS/DNS-SD records:

| Service type | Protocol | Purpose |
|---|---|---|
| `_lightinator-log._tcp.local` | TCP | HTTP API and web UI |
| `_lightinator-syslog._udp.local` | UDP | Syslog ingest port |

TXT records include `api_version`, `http_port`, `syslog_port`, and `service`.

#### `src/crashDecoder.js` — Crash decoder

Watches the syslog stream for ESP crash dump sequences:

1. Detects the trigger line: `pc=0x... sp=0x... excvaddr=0x...`
2. Collects all lines until a blank line after `Stack dump:`.
3. Fetches `/info?v=2` from the controller to get `git_version`, `soc`, and
   `build_type`.
4. Downloads the matching ELF binary from `http://lightinator.de/download`
   (cached in `data/elfs/`).
5. Runs the Sming `decode-stacktrace.py` script via `python3` with the
   architecture-specific `addr2line` binary.
6. Emits the decoded output as a synthetic `LogRecord` which is stored and
   optionally forwarded to Loki with a `:crash-decode` tag suffix.

Supports ESP8266, ESP32, and ESP32-C3 SOCs.

#### `src/serviceConfig.js` — Runtime config file

Reads and writes `data/service.env` — a shell-env-syntax file that the Podman
Quadlet unit passes as `EnvironmentFile=`.  Editable directly through the web
UI Settings panel; changes take effect after a service restart.

#### `src/ui/index.html` — Browser UI

A fully self-contained single-page application (~2000 lines of vanilla HTML +
CSS + JavaScript).  Served statically by Express; no build step, no external
CDN calls, works offline on a LAN.

---

## Data Flow

```
1. Controller firmware  ──UDP syslog──▶  UDP socket (5514)
                                              │
2.                              parseSyslogLine()
                                              │ LogRecord
                           ┌──────────────────┤
                           │                  │
3.              storage.append()    discovery.addSeenIp()
                    │                         │
4.   (if loggingEnabled)            (trigger re-discovery if new IP)
         loki.forward()
                    │
5.   (crash dump detected)
         crashDecoder.feed()
              │
6.   fetch /info?v=2 from controller
   download ELF → run decode-stacktrace.py
              │
7.   storage.append(decoded record)
     loki.forward(decoded record)

Browser ──HTTP GET /api/v1/logs?ip=x──▶ Express ──▶ storage.getLogs()
                                                           │
                                              ◀── paginated LogRecord[]
```

---

## Key Technologies

| Technology | Role |
|---|---|
| **Node.js ≥ 20** | Runtime; uses native `dgram`, `fs/promises`, `http/https` |
| **Express 4** | HTTP API server and static file serving |
| **bonjour-service** | mDNS/DNS-SD advertisement (Bonjour protocol) |
| **cors** | CORS middleware for cross-origin browser access |
| **NDJSON** | Per-controller log file format (newline-delimited JSON) |
| **Loki push API** | Optional log aggregation backend (Grafana Loki) |
| **Sming decode-stacktrace.py** | ESP crash stack decoder (Python 3 + addr2line) |
| **Docker / Podman** | Container packaging (multi-arch: amd64 + arm64) |
| **Podman Quadlet** | systemd-native container service for auto-start + auto-update |
| **GitHub Actions** | CI: build and publish multi-arch image to GHCR |

---

## Installation

### Option 1 — One-command container start (no `make` required)

```bash
git clone https://github.com/pljakobs/lightinator-log-service.git
cd lightinator-log-service
./scripts/run-container.sh
```

Update to the latest image without losing logs:

```bash
./scripts/update-container.sh
```

Stop the service:

```bash
./scripts/stop-container.sh
```

### Option 2 — Docker Compose

```bash
docker compose up -d --build
```

### Option 3 — Podman Compose

```bash
podman-compose up -d --build
```

Or without `podman-compose`:

```bash
podman build -t lightinator-log-service:dev -f Containerfile .
podman run -d --name lightinator-log-service \
  --network host \
  -v ./data:/app/data \
  lightinator-log-service:dev
```

### Option 4 — Podman Quadlet (recommended on systemd systems, Podman ≥ 4.4)

Quadlet generates a systemd service automatically and supports auto-update
when a new `:prod` image is published to GHCR.

**Per-user install:**

```bash
mkdir -p ~/.config/containers/systemd
cp quadlet/lightinator-log-service.container ~/.config/containers/systemd/

# Optional: copy and edit the runtime config
mkdir -p ~/lightinator-log-service/data
cp config/service.env.example ~/lightinator-log-service/data/service.env

systemctl --user daemon-reload
systemctl --user enable --now lightinator-log-service
# Enable daily auto-update pulls:
systemctl --user enable --now podman-auto-update.timer
```

**System-wide install (root):**

```bash
sudo mkdir -p /var/lib/lightinator-log-service/data
sudo cp quadlet/lightinator-log-service.container /etc/containers/systemd/
sudo cp config/service.env.example /var/lib/lightinator-log-service/data/service.env
sudo systemctl daemon-reload
sudo systemctl enable --now lightinator-log-service
sudo systemctl enable --now podman-auto-update.timer
```

Check status and follow logs:

```bash
systemctl --user status lightinator-log-service
journalctl --user -u lightinator-log-service -f
```

### Option 5 — Makefile targets

```bash
make help          # list all targets
make deps          # npm install
make docker-compose-up
make podman-compose-up
```

Multi-arch publish:

```bash
make docker-buildx-push IMAGE=ghcr.io/<owner>/lightinator-log-service TAG=latest
make podman-manifest-push IMAGE=ghcr.io/<owner>/lightinator-log-service TAG=latest
```

---

## Configuration Reference

All settings are read from environment variables on startup.  When using the
Podman Quadlet install, set them in `data/service.env` (editable via the web
UI Settings panel) and restart the service for changes to take effect.

| Variable | Default | Description |
|---|---|---|
| `LLS_HTTP_HOST` | `0.0.0.0` | HTTP bind address. Restrict to a specific IP to limit LAN access. |
| `LLS_HTTP_PORT` | `4821` | TCP port for the web UI and REST API. |
| `LLS_UDP_HOST` | `0.0.0.0` | UDP bind address for syslog ingest. |
| `LLS_UDP_PORT` | `5514` | UDP port that firmware sends syslog messages to. Must match `network.rsyslog.port` on the firmware. |
| `LLS_DATA_DIR` | `/app/data/logs` | Directory where per-controller NDJSON files are written. |
| `LLS_MAX_BYTES_PER_IP` | `20971520` (20 MB) | Maximum raw bytes stored per controller before old entries are rotated out. |
| `LLS_RETENTION_DAYS` | `7` | How many days of logs to retain before pruning. |
| `LLS_CORS_ORIGIN` | `*` | CORS allowed origin. Set to the webapp origin to restrict cross-origin access. |
| `LLS_SERVICE_NAME` | `LightinatorLogService` | Name reported in health responses and mDNS advertisements. |
| `LLS_MDNS_HOST` | `lightinator-logservice.local` | mDNS hostname; clients can reach the UI at `http://<name>:<port>`. |
| `LLS_LOKI_CONFIG` | `data/loki.json` | Path to the Loki JSON config file; managed via the UI. |
| `LLS_DISCOVERY_SEEDS` | `lightinator.local` | Comma-separated controller IPs or hostnames used to bootstrap discovery. One reachable seed is enough. |
| `LLS_DISCOVERY_PORT` | `80` | HTTP port the controllers listen on. |
| `LLS_DISCOVERY_REFRESH_MS` | `300000` (5 min) | How often (ms) to re-query the controller network. |
| `LLS_CONTROLLER_STATE` | `data/controllers.json` | Path where the discovered controller list is persisted across restarts. |
| `LLS_SYSLOG_ADVERTISE_HOST` | _(auto-detect)_ | IP of this host as reachable by the controllers. Used when the UI logging toggle pushes `network.rsyslog.host` to firmware. Set explicitly when the host is multi-homed or behind NAT. |
| `LLS_ELF_CACHE_DIR` | `data/elfs` | Directory where downloaded ELF binaries are cached for crash decoding. |
| `LLS_ELF_BASE_URL` | `http://lightinator.de/download` | Base URL where firmware ELF files are published by CI. |

A fully annotated example is in [`config/service.env.example`](config/service.env.example).

---

## REST API Reference

Base path: `/api/v1`

### Health and info

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health, version, uptime (legacy path) |
| `GET` | `/api/v1/health` | Service health, version |
| `GET` | `/api/v1/service-info` | Ports, capabilities, network interfaces, mDNS records |

### Log storage

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/sources` | List all known source IPs with byte size and last-seen |
| `GET` | `/api/v1/logs?ip=<ip>&limit=200&before=0` | Paginated log records for one controller (newest-first). `before` is an offset from the end. |
| `DELETE` | `/api/v1/logs?ip=<ip>` | Delete all logs for one controller |
| `DELETE` | `/api/v1/logs?all=true` | Delete all logs for all controllers |

### Controller discovery

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/controllers` | List all discovered controllers (name, IP, groups, logging state, reachability) |
| `POST` | `/api/v1/controllers/refresh` | Trigger an immediate re-discovery cycle |
| `PATCH` | `/api/v1/controllers/:ip/logging` | `{ "enabled": true\|false }` — toggle logging and push rsyslog config to firmware |

### Loki forwarding

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/loki/status` | Current forwarder state (ok / error / disabled), last push time, total pushed |
| `GET` | `/api/v1/loki/config` | Full Loki config (password masked) |
| `PUT` | `/api/v1/loki/config` | Update Loki config (persists to `data/loki.json`) |
| `POST` | `/api/v1/loki/test` | Push a test entry to verify connectivity |

### Service configuration

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/service-config` | Read `data/service.env`, returns schema + current values + live runtime values |
| `POST` | `/api/v1/service-config` | Write `data/service.env` (restart required) |
| `POST` | `/api/v1/service-config/restart` | Gracefully exit (systemd Restart=always brings it back) |

---

## Browser UI

Open `http://<host>:4821/` in a browser.  No build step or CDN dependency — the
UI is a single self-contained HTML file (`src/ui/index.html`) served by Express.

### Logs tab

- Paginated, newest-first log list with time / tag / application / message columns
- Severity colour coding (error = red, warning = yellow)
- Free-text filter
- Auto-refresh every 5 s (toggle off to pause)
- Load-older pagination
- Per-controller log purge

### Controllers tab

- Card grid of all discovered Lightinator controllers
- Shows: name, IP, hostname, device ID, group memberships, SOC, build type, git version
- Green online indicator or last-seen timestamp when unreachable
- Split-brain warning badge when a controller is not visible from all peers
- Per-controller **Logging ON/OFF** toggle (pushes rsyslog config directly to firmware)
- Manual **Refresh** button

### ⚙ Settings panel (Loki + service config)

Configure Loki forwarding and service settings without restarting:

- Loki connection URL, username, password (masked in storage and API)
- Global labels applied to every log entry
- Group label overrides (matched by controller group name)
- Per-controller extra labels
- Advanced: batch size and flush interval
- Service settings: discovery seeds, ports, retention, mDNS hostname

---

## Loki Forwarding

Log entries are buffered in memory and flushed to a Loki-compatible
`POST /loki/api/v1/push` endpoint in configurable batches.

Configuration is persisted to `data/loki.json` and loaded on startup.
The UI Settings panel edits this file in-place with no restart required.

**Label resolution order** (lower item overrides higher):

1. Global labels — applied to every stream
2. Group-level labels — matched by the controller's group name
3. Per-controller labels — matched by source IP

**Automatic stream labels** (always present): `host` (= syslog tag), `source_ip`, `tag`.

To run a local Loki + Grafana stack for development:

```bash
docker compose --profile monitoring up -d
```

Grafana is pre-configured with a Loki datasource.  Visit `http://localhost:3000`
(anonymous admin access enabled by default in the dev compose profile).

---

## Controller Discovery

When the service starts, and every 5 minutes (configurable), it:

1. Queries `GET /hosts?all=true` on a seed controller → all known IPs + hostnames.
2. Queries `GET /data` → group definitions and controller-to-group membership.
3. Cross-joins the two responses by the `ip-address` field to map each IP to its group.
4. Queries `GET /config` and `GET /info?v=2` on every reachable controller to
   read the live rsyslog state, SOC type, build type, and git version.
5. Performs split-brain detection: cross-checks each controller's `/hosts?all=true`
   view against its peers; flags any IP missing from a peer's view.
6. Persists the inventory to `data/controllers.json`.

Discovery also triggers immediately when a UDP packet arrives from a previously
unseen IP.

Configure seeds via `LLS_DISCOVERY_SEEDS` (comma-separated).  Only one
reachable seed is needed; all peers are found transitively via `/hosts?all=true`.

---

## Crash Decoder

When ESP firmware crashes it emits a sequence of syslog lines:

```
pc=0x40201234 sp=0x3ffff350 excvaddr=0x00000000
epc2=0x... epc3=0x... exccause=3 depc=0x...
Stack dump:
3ffff350:  40201234 3ffef888 00000001 3ffef8c0
...
<blank line>
```

`crashDecoder.js` detects this sequence and:

1. Fetches `GET /info?v=2` from the controller to get `git_version`, `soc`,
   `build_type`.
2. Constructs the ELF URL:
   `<elfBaseUrl>/<branch>/<git_version>/<soc>/<type>/app_0.out`
3. Downloads and caches the ELF in `data/elfs/`.
4. Runs the Sming `decode-stacktrace.py` script (bundled in the Docker image
   from the `pjakobs/sming` build stage) via `python3`, feeding crash lines on
   stdin.
5. Emits the decoded human-readable stack trace as a synthetic `LogRecord`
   (stored normally and forwarded to Loki with a `:crash-decode` tag).

Supported SOCs: **ESP8266**, **ESP32**, **ESP32-C3**.

---

## Development

### Prerequisites

- Node.js ≥ 20
- npm

### Run locally

```bash
npm install
npm start           # production mode
npm run dev         # --watch mode (auto-restarts on file change)
```

The service will listen on `http://localhost:4821` and `udp://0.0.0.0:5514`.

### Sending a test syslog packet

```bash
echo '<191>LED_Be Lightinator: 12345 Hello from dev' | nc -u -w1 127.0.0.1 5514
```

### Project scripts

| Script | Command |
|---|---|
| `npm start` | `node src/index.js` |
| `npm run dev` | `node --watch src/index.js` |

There is no test runner or linter configured in this project.

---

## Container Build & CI

### Dockerfile (multi-stage)

**Stage 1 (`sming-tools`, `linux/amd64`)** — pulls `pjakobs/sming:latest` and
extracts:
- `xtensa-lx106-elf-addr2line`, `xtensa-esp32-elf-addr2line`, `riscv32-esp-elf-addr2line`
- `decode-stacktrace.py` for ESP8266 and ESP32

**Stage 2 (`base`, Node 22 Debian)** — copies the toolchain binaries, installs
`python3`, runs `npm install --omit=dev`, and copies `src/`.

The final image is typically ~200 MB (arm64) / ~250 MB (amd64).

### GitHub Actions CI

Workflow: `.github/workflows/container-image.yml`

| Trigger | Action |
|---|---|
| Pull request to `main`/`master`/`develop`/`prod` | Build multi-arch image (amd64 + arm64), **no push** |
| Push to `main`, `master`, `develop` | Build and push to GHCR; tag = branch name + SHA |
| Push to `prod` branch | Build and push; extra tag `:prod` (used by Quadlet `AutoUpdate=registry`) |
| Tag `v*` | Build and push; tag = git tag |

Published image: `ghcr.io/<owner>/lightinator-log-service`

The `APP_VERSION` build arg is set to `<branch>-<short-sha>` and exposed via
`GET /health` and `GET /api/v1/health`.

### Multi-arch build (manual)

**Docker Buildx:**

```bash
docker buildx create --use --name lls-builder || docker buildx use lls-builder
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/your-org/lightinator-log-service:latest \
  -f Dockerfile \
  --push .
```

**Podman manifest:**

```bash
podman manifest create lightinator-log-service:latest
podman build --platform linux/amd64 --manifest lightinator-log-service:latest -f Containerfile .
podman build --platform linux/arm64 --manifest lightinator-log-service:latest -f Containerfile .
podman manifest push --all lightinator-log-service:latest docker://ghcr.io/your-org/lightinator-log-service:latest
```

---

## Deployment Options

| Method | Best for |
|---|---|
| `scripts/run-container.sh` | Quick eval, no Compose needed |
| `docker compose up` | Docker users, optional Loki+Grafana monitoring stack |
| `podman-compose up` | Podman users on non-systemd environments |
| **Podman Quadlet** | Systemd hosts (Fedora, RHEL, Arch, etc.) — auto-start on login + auto-update |
| `node src/index.js` | Development / bare-metal install |

All container deployments require **host networking** (`--network host`) for:
- mDNS advertisement (Bonjour uses multicast)
- UDP syslog reception (port binding on the host interface)

The persistent data volume (`/app/data`) holds logs, `loki.json`,
`controllers.json`, and `service.env`.  Mount it to a host path to survive
container recreation.
