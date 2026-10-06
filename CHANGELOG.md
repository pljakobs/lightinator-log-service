# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
No versioned releases have been cut since 0.1.0. Every published CI build is
tagged `build/<run-number>` (currently up to `build/183`), and the UI's
**What's new** dialog lists the commits in each build.

---

## [Unreleased]

### Added

- **Crash decoding**
  - Detection of ESP8266 exceptions, ESP32 Guru Meditation panics and the
    firmware crash-dump report in the syslog stream. The register and stack lines
    are collected and symbolicated against the matching firmware ELF.
  - ELF and map files are downloaded from `LLS_ELF_BASE_URL`
    (`<branch>/<version>/<soc>/<debug|release>/`) and cached per firmware, SoC
    and build type.
  - Vendored, map-aware decoders for ESP8266 and ESP32/ESP32-C3
    (`tools/decode-esp8266.py`, `tools/decode-esp32.py`). They classify code and
    data addresses and add disassembly around the faulting address.
  - Source context from firmware and Sming checkouts at the crash's version tags,
    including submodules.
  - **Crashes** tab listing decoded crashes, with jump-to-log and issue links.
    The crash modal toggles between raw and decoded output and has copy actions.
  - Decoder-only rerun (`POST /api/v1/crashes/:id/decode`) that uses the stored
    raw dump and the original build metadata.
- **AI crash analysis**
  - Context-aware root-cause analysis after decoding, plus a manual **Analyze**
    action (`POST /api/v1/crashes/:id/analyze`).
  - Ordered provider list (`LLS_AI_BACKENDS`) for Gemini, OpenAI-compatible
    endpoints (Ollama, vLLM, LM Studio) and native Ollama, with model fallback
    lists for 503/overload errors.
  - Bounded multi-round source-context gathering (`LLS_AI_CONTEXT_ROUNDS`,
    `LLS_AI_CONTEXT_BYTES`) using prioritized ranges and full-file expansion.
  - `LLS_AI_ENABLED` switch for automatic analysis.
- **GitHub issue reporting**: optional automatic issue creation for decoded
  crashes, de-duplicated by crash fingerprint (`LLS_GITHUB_TOKEN`,
  `LLS_GITHUB_REPO`, `LLS_AUTO_CREATE_ISSUES`).
- **Boot tracking**
  - Per-boot nonce from the firmware syslog prefix and per-source boot counter.
    One reboot marker per boot; repeated restart sentinels are de-duplicated.
  - Boot picker (`GET /api/v1/boots`) and previous/next boot navigation
    (`GET /api/v1/logs/boot-jump`), including boots outside the loaded window.
  - Firmware version, Sming version, SoC and build type are recorded per boot
    generation, so crashes are decoded against the build that was running.
- **Log viewer**
  - Resizable and hideable columns, raw display mode, sort by device time, and
    search context lines with dimmed non-matches and gap dividers.
  - Infinite scroll for older entries, jump-to-end, gap-free live refresh that
    keeps the viewport while scrolled away from the tail, and `Ctrl+A` selecting
    only log content.
  - ANSI colour rendering.
- **Global search** across all controllers (`GET /api/v1/search`) with context
  lines.
- **Controllers**
  - Firmware version and build type on controller cards, and a "last log
    received" relative time.
  - Remove single, selected or stale controllers, optionally with their logs
    (`DELETE /api/v1/controllers/:ip`, `POST /api/v1/controllers/remove`,
    `POST /api/v1/controllers/remove-stale`). Hourly auto-removal after
    `LLS_CONTROLLER_STALE_DAYS`.
  - The logging toggle pushes the rsyslog host/port to the controller via
    `POST /config`. The advertise host is auto-detected, with
    `LLS_SYSLOG_ADVERTISE_HOST` as an override.
  - Controller list persisted across restarts; wall panels discovered and
    classified via mDNS.
  - `/info?v=2` polling for boot nonce and firmware metadata, with retries for
    throttled polls.
- **Firmware updates**: opt-in single-controller ROM updates from the lightinator.de
  catalogue (`LLS_FIRMWARE_UPDATES_ENABLED`, `LLS_FIRMWARE_API_URL`). They need
  explicit confirmation, use the OTA password once without storing it, and are
  only marked installed after the controller reports the selected version, SoC
  and build type.
- **Settings**: unified dialog with Service, Loki, AI and GitHub tabs. Settings
  are stored in a central `data/service.env`
  (`GET/POST /api/v1/service-config`) and the service can be restarted from the
  UI (`POST /api/v1/service-config/restart`).
- **What's new**: per-build changelog generated from commit messages
  (`GET /api/v1/changelog`), opened from the build badge.
- **Mobile layouts**: slide-out source drawer, stacked log metadata, wrapping
  cards and crash rows, and a fullscreen crash modal.
- **Deployment**
  - Interactive `install.sh` for Podman Quadlet, systemd and OpenRC.
  - Quadlet template unit `lightinator-log-service@.container` with `prod` and
    `develop` instances and pull-on-restart.
  - `:prod` image published from the `prod` branch.
  - Native AMD64/ARM64 decoder toolchains, version-pinned and SHA256-verified,
    checked during the image build (`scripts/test-decoder-tools.js`).
- **Loki**: `host` label (syslog tag / controller name), status dot in the
  header, verbose connection test showing the target and response.
- **Testing and CI**: integration tests (UDP → API), Playwright UI tests and
  database/API completeness tests. CI runs on Node 22 and 24 with JUnit and HTML
  reports, test summaries and checks. Test failures block image builds.
- Browser UI, Loki forwarding and controller discovery (initial versions):
  - Browser UI served at `/` with a Controllers tab and a Loki settings panel.
  - Batched Loki push with basic auth, configurable batch size and flush
    interval, and global → group → per-controller label resolution.
  - Discovery via `/hosts` + `/data` from seed controllers, refreshed every
    5 minutes (`LLS_DISCOVERY_SEEDS`, `LLS_DISCOVERY_PORT`,
    `LLS_DISCOVERY_REFRESH_MS`).
  - Monitoring compose profile with Loki and Grafana.

### Changed

- Log storage moved from per-controller NDJSON files to SQLite. Existing NDJSON
  logs are imported once on startup.
- The UI is split into `styles.css` and ES modules (no build step).
- Retention is byte-based per controller (`LLS_MAX_BYTES_PER_IP`) in addition to
  age and row limits. Usage totals are maintained by SQLite triggers instead of
  rescans.
- Startup migrations, imports, pruning and state restoration run in a worker
  before the listeners start.
- Crash decoding, AI passes and storage are serialized per crash, so a failed
  job does not block the queue.
- Crash dumps and their original firmware metadata are stored separately from
  the syslog record. Re-analysis always uses the original build.
- CI uses pinned Ubuntu 24.04 runners and Node 24 action runtimes.

### Fixed

- Plain-`http://` ELF downloads failed with "http is not defined" (`build/183`).
- Logger prefixes are stripped from crash dumps on every rerun, and truncated
  stack data is recovered from stored logs.
- Reboot markers and boot jumps anchor at the boot start; boot sections no
  longer repeat when sorting.
- Historical log and controller schemas are migrated.
- The controller HTTP request contract for discovery is restored, and
  soc/buildType/gitVersion are preserved across refresh cycles.
- Retention rescans no longer starve HTTP and UDP ingestion.
- Saved settings are applied on restart.
- Native decoder toolchains are installed correctly on both architectures.
- Firmware map caches are isolated per firmware, SoC and build type.
- Crash fingerprinting is fixed, and the Sming and firmware repository URLs and
  branches for source context are corrected.

### Security

- GitHub tokens, AI keys and Loki passwords are write-only in the HTTP API.
  Reads expose only configured-state flags; secrets can be explicitly replaced,
  kept or cleared; credentials are not reused after a destination change.
- Legacy Loki credentials embedded in the URL are migrated to private fields,
  with an owner-only backup.
- Crash Markdown and controller values are sanitized (DOMPurify). Attribute
  injection, inline event handlers and unsafe link protocols are blocked.
- Source-context retrieval cannot escape repositories through path traversal or
  symlinks. Repository references cannot inject shell commands or Git options.
- Firmware update requests from other origins are rejected.

---

## [0.1.0] — Initial release

- UDP syslog ingest on port 5514.
- Per-controller NDJSON log storage with configurable size cap and retention.
- REST API: sources, logs (paginated), purge.
- Health and service-info endpoints.
- Docker / Podman / docker-compose / podman-compose support.
- Multi-arch container image (amd64 + arm64) published to GHCR via GitHub Actions.
- mDNS advertisement via `LLS_MDNS_HOST`.
