# Lightinator Log Service - Design Document

## 1. Purpose

`lightinator-log-service` is a local-first support component for Lightinator controllers.

Goals:
- Receive high-volume controller logs via UDP syslog without increasing device memory pressure.
- Expose a simple HTTP API for the webapp to fetch logs per controller IP.
- Advertise itself on LAN via mDNS for near zero-config discovery.
- Keep user data sovereign by default: local retention, explicit export/upload only.

Non-goals (v1):
- Public cloud syslog ingress.
- Browser-native UDP ingestion.
- End-to-end account management.

## 2. Context and Constraints

- ESP8266-class nodes have very limited free heap (~27 kB in favorable moments).
- Continuous websocket log streaming from firmware is too memory-intensive.
- Browsers cannot directly listen on UDP sockets.
- Many users will not operate a dedicated rsyslog host manually.

Implication:
- Keep device path lightweight: UDP fire-and-forget to LAN target.
- Move parsing, retention, filtering, export, and optional upload into this service.

## 3. High-Level Architecture

Components:
- UDP Ingest Server: listens for syslog datagrams.
- Log Router: identifies source controller by IP and app metadata in message.
- In-Memory Store: bounded ring buffers per controller IP.
    - I would rather have on disk storage as hat would mean people can leave the controller logging for days
    - one file per controller (by ip address)
- HTTP API Server: queried by webapp for health, logs, sessions, export/upload.
- mDNS Announcer: advertises API endpoint and syslog endpoint.


Data flow:
1. Controller sends UDP syslog to service host:port.
2. Ingest parser normalizes line into structured record.
3. Record is appended to per-IP bounded buffer.
4. Webapp requests logs for current controller IP via HTTP.
5. User can export local file or trigger optional upload.

## 4. Network and Discovery

### 4.1 Endpoints

Default ports:
- HTTP API: `4821/tcp`
- Syslog ingest: `5514/udp` (non-privileged default)

Reason:
- Avoid privileged port requirements (`514/udp`) in common desktop/container setups.

### 4.2 mDNS Advertisement

Advertise these services:
- `_lightinator-log._tcp.local` -> HTTP API
- `_lightinator-syslog._udp.local` -> UDP ingest

Host label:
- `lightinator-logservice.local`

TXT records (example):
- `api_version=1`
- `syslog_port=5514`
- `http_port=4821`
- `service=LightinatorLogService`

### 4.3 Webapp Discovery Strategy

Browser-friendly strategy:
1. Try fixed local hostname `http://lightinator-logservice.local:4821/health`.
2. Fallback to user-specified host:port in settings.
3. Optional future native discovery via companion script/plugin.

## 5. Data Model

## 5.1 LogRecord

```json
{
  "id": "uuid-or-monotonic-id",
  "receivedAt": "2026-04-03T21:39:40.979572Z",
  "sourceIp": "192.168.29.125",
  "priority": 191,
  "tag": "LED_Be",
  "app": "Lightinator",
  "deviceTime": 3330072694,
  "message": "Not enough heap free, rejecting request. Free heap: 5104",
  "raw": "<191>LED_Be Lightinator: 3330072694 Not enough heap free, rejecting request. Free heap: 5104"
}
```

## 5.2 Storage Policy

Per-source bounded ring buffer:
- `maxEntriesPerIp`: default 20000
- `maxBytesPerIp`: default 20 MiB
- global cap optional, e.g. 2 GiB

Retention:
- time-based cleanup, default 7d
- configurable by user

## 6. API Design (v1)

Base path: `/api/v1`

### 6.1 Health
- `GET /health`
- Returns uptime, version, and listener status.

### 6.2 Service Info
- `GET /service-info`
- Returns API port, syslog port, hostname, and capabilities.

### 6.3 Source Inventory
- `GET /sources`
- Returns known source IPs with counters and lastSeen.

### 6.4 Query Logs
the Lighitnator ui should be used to display those logs, it should used paged requests to the log service 
- `GET /logs?ip=192.168.29.31&limit=500&since=2026-04-03T21:30:00Z`
- Returns records for one controller IP.

### 6.5 Start/Stop Session (optional v1.1)
- `POST /sessions/start` body: `{ "ip": "...", "durationSec": 300 }`
- `POST /sessions/stop` body: `{ "sessionId": "..." }`

### 6.6 Export
- `GET /export?ip=...&format=txt|json`
- Returns downloadable file.
not necessary, the browser can save a file locally


## 7. Privacy and Sovereignty

Defaults:
- Local-only operation.
- No outbound upload unless explicitly enabled.
- No telemetry from this service itself.

Redaction pipeline (pre-export/upload): (optional)
- Mask IPv4/IPv6 (`192.168.29.125` -> `192.168.x.x` or hash).
- Mask MAC addresses.
- Mask SSID names.
- Mask hostnames/device names if configured.
- Keep firmware/build/soc and error signatures.

Retention controls: (through the controller frontend ui)
- configurable max age
- one-click purge all data
- per-IP purge endpoint

## 8. Security Model

Threat model focus:
- Prevent unauthorized read access on LAN.
- Prevent accidental outbound data flow.

Controls:
- Bind HTTP API to LAN interface by default.
- Read-only endpoints open by default on LAN (configurable).
- Mutating endpoints require local API token.
- Optional CORS allowlist to webapp origin(s).

Optional hardening:
- Pairing code flow from webapp for first-time trust.
- mTLS between webapp and service only if deployment supports it.

## 9. Operational Model

Run modes:
- Docker container (primary)
- native binary/script (secondary) 

Container requirements:
- host networking recommended for mDNS and UDP simplicity
- persistent volume for retained logs/config
- mimimal OS (alpine?)

Suggested docker compose shape:
- service `lightinator-log-service`
- ports `4821:4821/tcp`, `5514:5514/udp`
- volume `./data:/app/data`

## 10. Implementation Plan

### Phase 1 - Local Collector MVP
- UDP syslog listener.
- Parse and store per-IP logs in memory.
- `GET /health`, `GET /sources`, `GET /logs`, `GET /export`.
- mDNS advertisement.

### Phase 2 - Webapp Integration
- Detect service via `lightinator-logservice.local` fallback path.
- Fetch logs for current controller IP.
- Add "Configure rsyslog target" helper in webapp.

### Phase 3 - Privacy and Upload
- Redaction profiles.
- Explicit upload workflow.
- retention/purge controls.

### Phase 4 - Packaging and UX
- Docker images, docs, and quick-start script.
- Better session controls and filtering presets.

## 11. Open Questions

1. Should source identity primarily be controller IP, controller ID, or both?
2. Is retention default 24h acceptable, or should it be shorter (e.g. 4h)?
3. Which redaction profile should be default for export?
4. Should upload ever be enabled by default in non-debug builds? (recommended: no)
5. Is host networking acceptable for all target user environments?

## 12. Success Criteria

- A user can run one container and receive controller logs within 2 minutes.
- Webapp can fetch logs for selected controller IP with no manual copy/paste.
- No increase in firmware memory pressure beyond existing UDP logging.
- User can export diagnostics locally without any cloud dependency.
- Optional upload path is explicit, redacted, and auditable.
