# Code Review TODO

Review date: 2026-10-03. Completed items require focused regression coverage.

## Security

- [x] **1a. Write-only credential APIs.** API reads return only configured flags, saves preserve omitted/blank secrets, null explicitly clears them, and backend code reads credentials privately. Credential fragments and reflected upstream responses are excluded from logs/API errors. Covered by real API and browser tests.
- [ ] **1b. Unauthenticated destructive APIs.** Design authentication, authorization, and CORS restrictions for configuration changes, log deletion, restart, and outbound connection tests. Write-only secrets do not prevent unauthorized writes.
- [x] **2. Shell injection in repository operations.** Use argument-based Git execution, validate names/protocols/references, resolve refs to commits, and prevent option injection and repository path traversal. Covered by real Git fixtures, including remote-only branches.
- [x] **3. Browser and settings injection.** Escape HTML attribute quotes, eliminate interpolated inline event handlers, sanitize Markdown output with locally served DOMPurify, restrict link protocols, and escape error output. Confine AI-requested source reads to real repository roots, reject symlink escapes, and reject multiline/NUL settings values. Covered by browser and filesystem tests.

## Runtime and Persistence

- [x] **4. Broken HTTP discovery.** Reconcile the URL/options helper with its host/port/path callers and add a real HTTP discovery fixture.
    fix
- [x] **5. Saved settings loaded too late.** Construct runtime configuration after loading the persisted environment and test restart behavior.
    fix
- [x] **6. AI enable and model settings ignored.** Wire the opt-out flag and selected model into service initialization and crash handling.
    this is an artifact of a design change in the past. The implemented ai decoder uses a model ladder that is currently hardcoded to use Gemini versions.
    Ideally, we'd pull the configuration for this into the env file and make it editable in the configuration ui.
    since that would make it possible to provide different model backends, we will need things like url, possibly api type, token etc. This would also allow a local model, which is helpful
    implement this
    Implemented: ordered Gemini/OpenAI-compatible/Ollama backends, model lists, URLs, and write-only tokens are editable in the AI tab and persisted in LLS_AI_BACKENDS.
- [x] AI analysis - the two pass analysis is not ideal: 
    - the selected context was not enough and the models hallucinated code that did not exist. 
        - possibly, we need a looping context gathering to fetch the top most relevant code locations
        - currently, we're just including the full files where the context lies, that's wasteful on tokes but makes sure we have what we need
    - the first pass is fully integrated into the ai output which makes that hard to read as the two analysis can slightly go in different directions. We should rework the analysis such that the first pass(es) work as providers for the final pass and only the final pass is put into the output
    Implemented: configurable context rounds and UTF-8 budgets, bounded requested ranges with explicit full-file expansion, preserved original evidence, and final-only output. This constrains evidence gathering but cannot guarantee that a model will never hallucinate.
- [x] **7. Incomplete SQLite migrations.** Migrate missing log nonce/time columns and controller metadata columns; test historical schemas.
    fix 
- [x] **8. Incomplete crash persistence and re-analysis.** Persist firmware metadata and the full collected raw dump. Re-analyze with the original build instead of current controller metadata or prior decoded/AI text.
    fix
- [x] **9. Map cache mixes builds.** Key maps by firmware version, SoC, and build type, and select the correct map filename for each architecture.
    fix
- [x] **10. Decoder container tools.** Provide architecture-compatible host executables for ARM64 and AMD64 and include SoC-specific objdump tools. Validate decoding inside built images. AMD64 and ARM64 production images passed ESP8266, ESP32, and ESP32-C3 decoder smoke tests.
    fix
- [x] **11. NDJSON migration fails.** Supply the crash_decode SQL binding and test migration using real legacy files.
    fix

## UI and Analysis

- [x] **12. Stale and skipped live log rows.** Merge updates to existing IDs and page through bursts larger than the tail window without losing intervening rows.
    fix
- [x] **13. Unfulfilled Pass 1 context requests.** Parse requested files/ranges, reconcile the request schema, retrieve supplemental context, and supply map/disassembly evidence to Pass 2.
    see above
- [x] **14. Unenforced retention settings.** Implement advertised age/byte limits or remove the unsupported options and documentation.
    is that with regards to data pruning? if so, fix
- [x] **15. Loki connection-test credentials.** Preserve omitted/blank passwords, keep test configuration separate from forwarding configuration, and require replacement/clearing when URL or username changes. Exclude upstream response bodies and embedded URL credentials from API errors. Covered by API and local HTTP tests.
- [x] **16. Configuration UI - make sure all configurable items are represented in the config ui with the correct ui gadget (text for free text, password for credentials, toggle for boolean etc).** All user-facing settings have schema-driven controls and credential aliases use their canonical control. Deployment filesystem paths are private environment settings, excluded from the API/UI. Covered by complete-schema and path-confidentiality checks.
- [x] **17. UI layout - move Loki settings to the second tab.** Service opens first, followed by Loki, AI, and GitHub.
- [x] **18. Separate base configuration into useful tabs.** AI and GitHub settings have dedicated tabs; switching tabs preserves edits.
- [x] **19. Base configuration fields missing.** The Service tab opens populated. Invalid AI configuration returns the complete form with a recoverable configuration error instead of hiding all settings. Covered by API and browser tests.
- [x] **20. Deployment configuration compatibility.** Legacy quoted environment keys/models and existing provider settings load without rewriting the environment file. Embedded Loki URL credentials migrate to private fields with an owner-only backup. Upgrade behavior and repeat startup are covered by regression fixtures.
- [x] **21. Responsive operational views.** Controller selection uses an accessible phone/tablet drawer; logs, controller cards, crash lists, and fullscreen decode views fit 320px, 390px, and 768px screens. Desktop columns remain unchanged. Covered by populated viewport tests.
- [x] **22. CI runner/action updates and test reporting.** Pin Ubuntu 24.04, use Node 24 action runtimes, retain Node 22/24 application tests, publish inline/JUnit/check reports and browser HTML/trace artifacts, and retain fork-safe summaries. Report formats and workflow guards have regression coverage.
- [x] **23. Background setup.** Run schema migration, legacy imports, pruning, and state restoration in a worker. Overlap independent configuration loading and repository preparation while retaining serialized crash jobs. Main-thread heartbeat and readiness-error tests pass.
- [x] **24. Ingestion CPU starvation.** Replace per-packet retained-log scans and large OFFSET deletion with trigger-maintained byte/row usage and indexed oldest-row deletion. Below-budget ingestion, updates, IP changes, purges, and migrations have regression coverage.
- [x] **Operational follow-up:** deployed revision e9b9823 to 192.168.29.5 and restored the 20 MiB per-controller byte budget from the protected pre-mitigation backup. The 100,000-row and 90-day limits remain active. HTTP health returns 200 in about 22 ms with no queued listener connections; incremental usage totals match the live database and all sources satisfy the byte budget. The protected backup is retained.

## Credential Contract

The backend reads secrets directly from internal configuration or private storage, not through HTTP. Caller locality is not a credential-access boundary.

- API reads expose only configured/not-configured flags, never existing secret values.
- Omitted or blank secret updates preserve existing values; a new value replaces them; null explicitly clears them.
- Changing an outbound credential destination must require a replacement credential or explicit clearing, not silently reuse a saved secret.
- Write-only credentials do not replace authentication or protect against an attacker with host/container filesystem access.