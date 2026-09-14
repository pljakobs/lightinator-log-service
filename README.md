# Lightinator Log Service

Local-first UDP log collector and diagnostic viewer for Lightinator controllers.

## Web Interface & Key Features

The browser UI is accessible at `http://<host>:4821/` in a browser[cite: 18]. No build step or CDN dependency required — the UI is a single self-contained HTML file served directly from the container[cite: 18].

### Log Viewer

The primary log interface provides real-time log stream inspection per controller with configurable layout options and instant filtering.

![Log Viewer Interface](logView.jpg)

* **Paginated Log Stream:** Paginated, newest-first log list with time / tag / application / message columns[cite: 18].
* **Real-time Auto-Refresh:** Auto-refresh every 5 s (toggle off to pause)[cite: 18].
* **Free-Text Search & Filtering:** Instant free-text filter for matching log text[cite: 18].
* **Severity Bolding & Highlighting:** Severity colouring (error = red, warning = yellow)[cite: 18].
* **Source Selection & Maintenance:** Sidebar for source navigation, load-older pagination, and per-controller log purge functionality[cite: 18].

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

* **Network Discovery Grid:** Card grid of all discovered Lightinator controllers showing name, IP, hostname, device ID, and group memberships[cite: 18].
* **Online/Offline Telemetry:** Green online indicator or last-seen timestamp when unreachable[cite: 18].
* **Per-Device Logging Toggles:** Per-controller Logging ON/OFF toggle[cite: 18].
* **Global Overrides & Refresh:** Global control buttons (`Log All ON` / `Log All OFF`) and manual Refresh button[cite: 18].

---

### Service Configuration & Loki Settings

Configure Loki forwarding and service integrations without restarting the container[cite: 18].

![Service & Loki Settings Panel](config.jpg)

* **Loki Forwarding Settings:** Connection URL, username, and password (masked)[cite: 18].
* **Dynamic Tagging Hierarchy:** Set global labels applied to every log entry, group label overrides (matched by group name from controller discovery), and per-controller extra labels[cite: 18].
* **Connection Testing & Advanced Settings:** Features connection testing alongside advanced batch size and flush interval configuration[cite: 18].
* **Persistent Storage:** Settings are persisted to `data/loki.json` (the already-mounted data volume)[cite: 18].

---

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

- HTTP API: `4821/tcp`[cite: 18]
- Syslog ingest: `5514/udp`[cite: 18]

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



