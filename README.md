# Lightinator Log Service

Local-first UDP log collector and diagnostic viewer for Lightinator controllers.

## Web Interface & Key Features

The browser UI is accessible at `http://<host>:4821/`. No frontend build step is
required; ANSI and Markdown rendering helpers currently load from a CDN.

On phones and tablets, controller selection opens in a slide-out drawer. Log
metadata stacks above each message, controller cards and crash rows wrap, and
decoded crashes use a fullscreen modal with independently scrollable code blocks.
The desktop sidebar and resizable log columns remain available on wider screens.

### Log Viewer

The primary log interface provides real-time log stream inspection per controller with configurable layout options and instant filtering.

![Log Viewer Interface](logView.jpg)

* **Paginated Log Stream:** Paginated, newest-first log list with time / tag / application / message columns.
* **Real-time Auto-Refresh:** Auto-refresh every 5 s (toggle off to pause).
* **Free-Text Search & Filtering:** Instant free-text filter for matching log text.
* **Severity Bolding & Highlighting:** Severity colouring (error = red, warning = yellow).
* **Source Selection & Maintenance:** Sidebar for source navigation, load-older pagination, and per-controller log purge functionality.

---

### Automated Crash Decoding

When a controller experiences a hardware panic or exception, the log service captures the crash payload and displays an interactive modal for diagnostic evaluation.

![Decoded Crash Dump View](crashDecode.jpg)

* **Automatic Panic Detection:** Ingests raw stack dumps and presents decoded register details and call stacks.
* **Symbolicated Stack Traces:** Displays calculated stack traces with function names, line numbers, and file paths.
* **Raw & Decoded Toggles:** Action buttons to easily switch between raw log output and symbolicated stack traces.
* **One-Click Export:** Features action buttons to copy formatted backtraces or raw crash payloads directly to your clipboard.

---

### Controller Management

The controllers interface maintains a live view of discovered devices across your network deployment.

![Controller Management Interface](controllerView.jpg)

* **Network Discovery Grid:** Card grid of all discovered Lightinator controllers showing name, IP, hostname, device ID, and group memberships.
* **Online/Offline Telemetry:** Green online indicator or last-seen timestamp when unreachable.
* **Per-Device Logging Toggles:** Per-controller Logging ON/OFF toggle.
* **Global Overrides & Refresh:** Global control buttons (`Log All ON` / `Log All OFF`) and manual Refresh button.

---

### Service Configuration & Loki Settings

Configure Loki forwarding and service integrations without restarting the container.

![Service & Loki Settings Panel](config.jpg)

* **Loki Forwarding Settings:** Connection URL, username, and password (masked).
* **Dynamic Tagging Hierarchy:** Set global labels applied to every log entry, group label overrides (matched by group name from controller discovery), and per-controller extra labels.
* **Connection Testing & Advanced Settings:** Features connection testing alongside advanced batch size and flush interval configuration.
* **Persistent Storage:** Settings are persisted to `data/loki.json` (the already-mounted data volume).

---

## Credentials and API Security

GitHub tokens, Gemini API keys, and Loki passwords are write-only through the
HTTP API. Settings reads return `credentialsConfigured` flags for service keys
and `passwordConfigured` for Loki, not existing secret values. The UI displays
empty password inputs and configured-state indicators.

Omit a secret or send an empty string to keep it unchanged. Send a new value to
replace it, or JSON `null` to clear it explicitly. Service keys take effect after
a service restart; Loki changes apply immediately. Changing the Loki URL or
username requires replacing or clearing its password.

Backend integrations obtain credentials directly from private configuration and
the persisted settings, never through HTTP. No caller-locality exception is
needed. Saved configuration files use owner-only permissions but still contain
plaintext credentials; protect the host, data volume, and backups accordingly.

Authentication and authorization for configuration writes and destructive APIs
are not implemented. Restrict network access using a firewall or authenticated
reverse proxy before exposing the service beyond a trusted network. Write-only
credentials do not prevent unauthorized changes, deletion, or restart.

Storage, cache, migration-source, and bootstrap file paths are deployment-only
environment settings. They are not returned by the public settings/service-info
APIs and cannot be changed through the UI. Existing deployment paths are retained
when user-facing settings are saved.

## Configuration Upgrades

Existing GitHub tokens, Gemini key aliases, selected Gemini models, provider
ladders, and Loki credentials remain usable when the new image starts. Legacy
quoted environment-file values are normalized in memory; the file is not
rewritten just to adapt the default Gemini backend. Keep the same mounted data
volume and deployment environment when replacing a container.

The installer does not need to run again for data/configuration migration.
Once the new image is published for the installed tag, restarting a current
template Quadlet service pulls and recreates the container. A plain
`podman restart` or `docker restart` keeps using the old image: pull and recreate
instead. Older non-template units also require an explicit image update. Reuse
the same image tag, data mount, and environment-file configuration.

Legacy Loki credentials embedded in the URL are moved to the private username
and password fields for the same destination. That migration writes atomically
and retains `loki.json.pre-write-only.bak` with owner-only permissions. Treat the
backup as sensitive. If the data volume is read-only, the credentials remain
usable in memory and the service reports that persistence was unavailable.

## AI Providers and Context

Settings open on Service, followed by Loki, AI, and GitHub tabs. The AI tab
controls automatic analysis, provider order, model fallback lists, endpoints,
write-only tokens, maximum context rounds, and the aggregate source-byte budget.
Changes take effect after restarting the service.

`LLS_AI_BACKENDS` is a JSON array tried in order. Each entry has `id`, `type`
(`gemini`, `openai`, or `ollama`), `baseUrl`, `models`, and an optional `token`.
OpenAI-compatible endpoints include local Ollama, vLLM, and LM Studio servers;
the `ollama` type uses Ollama's native API. Models must already be available on
the selected backend. With host networking, a local backend can use loopback.

```dotenv
LLS_AI_BACKENDS=[{"id":"local","type":"ollama","baseUrl":"http://127.0.0.1:11434","models":["qwen3:8b"]}]
LLS_AI_CONTEXT_ROUNDS=3
LLS_AI_CONTEXT_BYTES=120000
LLS_AI_ENABLED=true
```

The legacy Gemini key/model settings provide the default backend when no
provider list is configured. Keeping that default in the UI retains a reference
to the legacy key rather than duplicating it. Explicit backend tokens are
independent. Reads expose only `tokenConfigured`, and changing a credential's
provider type or destination requires replacing or explicitly clearing it.

Intermediate passes request prioritized source ranges, optionally expanding to
full files within the byte budget. Only the final report is displayed and stored;
unresolved requests and budget limits are supplied to the final pass. These
controls improve grounding but do not guarantee hallucination-free results.
Disabling automatic analysis does not disable an explicitly requested manual
analysis.

## Storage and Decoder Validation

`LLS_RETENTION_DAYS` prunes expired log rows. `LLS_MAX_BYTES_PER_IP` limits stored
UTF-8 log/crash text per controller, excluding SQLite indexes and page overhead.
Zero disables either limit. Pruning runs on startup, inserts, crash updates, and
every five minutes; row-count limits continue to apply. Associated crash-report
records are deleted through SQLite foreign-key cascades.

Row and byte usage totals are maintained by SQLite triggers so normal ingestion
does not rescan retained log text. Startup migrations, imports, initial pruning,
and boot/controller-state restoration run in a worker before listeners become
ready. Independent Loki loading and repository setup overlap; complete crash
analysis jobs remain serialized. Ordinary runtime SQLite calls remain synchronous.

Collected crash dumps and original firmware metadata are persisted separately
from the received syslog record. Manual analysis uses that original build, not
the controller's current firmware. Historical crashes without original metadata
cannot be reliably re-analyzed and report that limitation.

Both container recipes install native AMD64/ARM64 host binutils, including
addr2line, nm, and objdump. Espressif archives are version-pinned and verified
against SHA256 checksums. Each build stage assembles fixture ELFs and checks
source context and disassembly for ESP8266, ESP32, and ESP32-C3. Repeat the smoke
check in a built image with:

```bash
podman run --rm --entrypoint node lightinator-log-service:dev /app/scripts/test-decoder-tools.js
```

## One-Command User Setup (No make required)

```bash
git clone [https://github.com/pljakobs/lightinator-log-service.git](https://github.com/pljakobs/lightinator-log-service.git)
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

Jobs use pinned Ubuntu 24.04 runners and Node 24 action runtimes. Application
tests still run on Node 22 and 24. `npm run test:ci` emits console output and
JUnit results; each job publishes a summary with individual pass/fail/skip
results. Same-repository runs also publish detailed test checks. Fork PRs retain
summaries and downloadable reports without a write-enabled reporting token.
Playwright publishes JUnit and HTML reports plus failure screenshots/traces.
Reports are retained for 14 days and uploaded even when tests fail. Test failures
still block image builds.

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


