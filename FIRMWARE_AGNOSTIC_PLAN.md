# Firmware-Agnostic Log Service Plan

Status: proposed future work; implementation is not started.
Created: 2026-10-03.

## Objective

Support logs and crashes from multiple firmware projects in one service without
requiring esp_rgbww_firmware, Sming, swarm membership, or a device HTTP API.
Preserve existing Lightinator deployments and their historical data.

Start with explicit identity and reproducible build provenance. Introduce small
adapter interfaces only where existing firmware-specific behavior requires them,
rather than building a general plugin framework upfront.

## Architecture

| Layer | Responsibilities |
| --- | --- |
| Core service | Ingestion, normalized records, persistence, retention, search, UI, analysis orchestration, and AI providers |
| Platform/format decoder | Crash recognition, dump collection, architecture-specific decoding, toolchain selection, and disassembly |
| Firmware adapter | Discovery, metadata acquisition, optional logging controls, identity extraction, and firmware-specific analysis context |
| Project/build registry | Trusted project configuration, versioned manifests, artifact resolution, and immutable source context |

Decouple architecture from crash format: two projects using ESP32 may emit
different panic formats but share the same address-resolution toolchain.
Unknown firmware must still be able to send logs. Missing identity, unsupported
crash formats, or unavailable artifacts must not stop collection.

## Identity Contract

Define a versioned ingestion metadata contract containing:

- `projectId`: configured firmware/project identity, namespaced within the service.
- `deviceId`: stable device identity, independent of IP and display name.
- `buildId`: unique identity for the actual build, not merely a branch or version label.
- `platform`: SoC/architecture information used to select supported tooling.
- `bootId`: per-boot identity for ordering and associating crash records.
- `contextRef`: optional compact reference to previously announced boot/build metadata.

Keep `sourceIp`, application tags, device uptime, and human-readable firmware
versions as useful attributes, not primary identities. Scope devices and boots by
project/device identity so different projects and address reuse cannot collide.

Firmware should announce metadata at boot and carry enough session information
on subsequent messages to resolve it cheaply. Because UDP announcements can be
lost or reordered, specify announcement repetition, collector restarts, stale
references, and late packets explicitly. Missing announcements must produce an
unresolved identity, not an assumed build copied from the device's current state.

Retain legacy syslog parsing and IP-based identities during migration. Record
whether identity is explicit, adapter-resolved, or legacy/unresolved. Freeze the
resolved project/build/boot metadata on each crash; firmware upgrades must not
change how an older crash is decoded.

## Build Manifest Contract

Publish a versioned, machine-readable manifest alongside each build. Define and
validate its schema before implementing artifact resolution.

Required information:

- Schema version, project ID, unique build ID, platform, and crash-decoder profile.
- ELF and optional map artifact references, sizes, and cryptographic checksums.
- Application repository and exact commit, including relevant submodule revisions.
- Framework/dependency repositories and exact commits rather than moving branches.
- Build type, toolchain identity/version, and available debug information.
- Source-path mappings from compiler build paths to repository-relative paths.
- Optional project analysis profile and build-specific diagnostic metadata.

Resolve relative artifact references against the project's configured artifact
source. Validate identity against the requested project/build and reject checksum
mismatches. Do not guess branches from version strings, choose filenames from
application-specific conventions, or fetch a moving framework `develop` branch
for a historical crash.

Decoder profiles and toolchains must come from service-supported configuration;
a manifest must not authorize arbitrary commands or executable downloads.

## Project Configuration

Add a registry for multiple firmware projects. Each project declares:

- Project ID and display name.
- Firmware adapter and supported decoder profiles.
- Manifest/artifact source and permitted source repositories.
- Optional discovery/metadata settings and device-control capabilities.
- Project-specific AI analysis profile and context policy.
- Optional retention overrides, if needed after the core migration is proven.

Keep tokens/passwords write-only through the API. Project configuration should
expose configured-state flags, preserve omitted secrets, support explicit
clearing, and prevent implicit credential reuse after a destination change.
Deployment filesystem paths remain private environment settings.

## Adapter Boundaries

Extract existing behavior into a built-in Lightinator adapter:

- Swarm `/hosts` and `/data` discovery and group membership.
- `/info` metadata interpretation and legacy firmware-version handling.
- `/config` remote logging control.
- Current syslog identity conventions and legacy artifact layout fallback.
- Lightinator-specific AI assumptions, including heap guards and framework use.

Adapters return normalized metadata and explicit capabilities. Discovery and
remote control are optional. A generic project may use mDNS, explicit device
registration, transport metadata, or log-only ingestion with no HTTP endpoints.

The core must not probe firmware-specific URLs on every unknown sender or show
logging controls for devices whose adapters do not support them.

## Persistence and Isolation

- Persist project/device/build/boot identities on logs and crashes, alongside raw evidence.
- Store immutable resolved manifest snapshots or content-addressed references for re-analysis.
- Partition artifact/map caches by project, build, platform, and checksum.
- Prepare immutable commit-specific source trees or worktrees; do not switch a shared checkout beneath another analysis.
- Scope crash fingerprints and issue deduplication by project and relevant build/platform context.
- Migrate retention accounting and boot tracking from IP-only keys to stable identities without breaking usage totals or old queries.
- Preserve unresolved historical records; do not invent project/build associations or silently reassign them.

Retain the current serialized analysis chain initially. Parallel analysis is a
separate optimization only after immutable source/artifact contexts and shared
resource limits have been validated. Keep ingestion independent of decoding,
repository availability, and AI provider failures.

## Analysis and UI

Use a generic evidence-first analysis profile with platform and project overlays.
Remove unconditional assumptions about application heap management or particular
framework APIs. Continue bounded iterative context retrieval, explicit evidence
gaps, and final-only reporting; these controls cannot guarantee that a model will
never hallucinate.

Display project, stable device, build, and platform identities where useful.
Support project filtering in logs, search, devices, and crashes. Keep IP visible
as a network attribute. Use generic device terminology and capability-driven
controls while preserving mobile drawers and usable decode views.

## Security and Operational Constraints

- Only configured/trusted registry sources may resolve manifests, repositories, and artifacts; log payloads must not introduce arbitrary fetch URLs.
- Validate schemas, checksums, protocols, redirects, path mappings, and real source-root confinement.
- Bound downloads, dump collection, source context, worker usage, and analysis queues.
- Protect project registration, credential changes, and device-control APIs; authentication/authorization remains an open prerequisite in [TODO.md](TODO.md).
- Report unavailable artifacts and identity conflicts without discarding raw logs/crashes.
- Keep migrations/background setup off the main event loop and preserve incremental retention accounting.
- Preserve deployed configuration and retain protected backups where an on-disk format migration is necessary.

## Implementation Phases

### Phase 1: Characterize and Extract Lightinator Behavior

- [ ] Inventory firmware assumptions in parser, discovery, decoder, harvester, reporter, storage, and UI.
- [ ] Add characterization fixtures for current Lightinator discovery, syslog, dumps, artifact URLs, and analysis profiles.
- [ ] Extract a built-in adapter and platform/format decoder interfaces with unchanged behavior.

Acceptance: existing tests and a representative Lightinator deployment retain
their current behavior, configuration, data, and decoding results.

### Phase 2: Introduce Identity and Backward-Compatible Storage

- [ ] Agree the versioned ingestion identity/session contract with a firmware producer.
- [ ] Add project/device/build/boot fields, registry identities, and migrations.
- [ ] Preserve legacy endpoints and IP-based fallbacks with explicit resolution status.
- [ ] Update boot tracking, retention accounting, and crash provenance together.

Acceptance: two project/device identities can coexist behind one IP, a device can
change IP without losing continuity, and late boot messages cannot select the
wrong crash build. Historical data remains readable without fabricated metadata.

### Phase 3: Resolve Immutable Build Manifests and Artifacts

- [ ] Define the manifest schema and producer-side publication procedure.
- [ ] Validate manifests/artifacts and persist immutable crash build provenance.
- [ ] Prepare exact application/framework/dependency revisions and safe path mappings.
- [ ] Replace legacy filename/repository/branch guessing with manifest resolution.
- [ ] Keep a documented Lightinator fallback for older builds lacking manifests.

Acceptance: historical crash decoding uses matching, checksum-verified artifacts
and source even after device upgrades or source branches move.

### Phase 4: Prove Multi-Firmware Operation

- [ ] Register a second, distinct firmware fixture, preferably on an already supported platform.
- [ ] Include a log-only device without discovery or remote-control endpoints.
- [ ] Verify project-separated caches, fingerprints, exports, and analysis profiles.
- [ ] Update project-aware UI/API filtering and optional capability controls.

Acceptance: Lightinator and the second firmware operate simultaneously without
cross-project source/artifact selection, unexpected HTTP probes, or data mixing.

### Phase 5: Harden and Roll Out

- [ ] Test interrupted migrations, unavailable registries, conflicting identities, and malformed/oversized manifests.
- [ ] Validate startup/ingestion responsiveness, retention totals, and bounded background resource usage.
- [ ] Run platform decoding fixtures on AMD64 and ARM64 images and browser tests across desktop/mobile.
- [ ] Document project onboarding, firmware metadata emission, build publication, legacy support, and rollback constraints.
- [ ] Decide separately whether immutable contexts justify bounded concurrent analysis.

Acceptance: upgrade tests preserve existing configuration and historical data;
unrecognized firmware still logs successfully; CI publishes useful results for
all added contract and integration tests.

## Decisions to Resolve Before Implementation

1. Choose the metadata wire format: compatible structured syslog fields, a compact boot announcement, or an additional registration endpoint.
2. Define a build ID that distinguishes configuration/toolchain differences, not just Git commits.
3. Decide which registry sources and manifest authentication/signing mechanisms are required initially.
4. Agree device-ID namespacing, conflict handling, and the duration of legacy IP-based support.
5. Select the second firmware fixture and representative raw crash samples.
6. Decide whether issue destinations and retention policies are global or project-specific.
7. Define retention/lifecycle rules for source worktrees, artifacts, and manifests needed by historical crashes.

## Scope Limits

No implementation, service rename, public cloud ingress, broad transport rewrite,
or third-party executable plugin loading is authorized by this document. Keep
the first implementation focused on contracts and a second working firmware
project. Add further architectures and transports only when a concrete producer
requires them.