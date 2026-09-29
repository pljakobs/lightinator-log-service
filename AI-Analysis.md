# Engineering Plan: Advanced Context-Aware AI Crash Analysis Module

## Objective
Implement an automated, multi-pass AI analysis pipeline within `lightinator-log-service` that correlates firmware crash dumps with actual source code from **Sming** and **esp-rgbww-firmware**, extracts symbol context via map files, performs multi-stage reasoning to locate faults, and attaches actionable diagnostics to the database, UI, and GitHub issues.

---

## Architecture & Multi-Pass Workflow

```
[Crash Decoded] 
       │
       ▼
[1. File Extraction & Symbol Resolution]
       ├── Parse filenames & line numbers from stack trace
       ├── Fetch map file from lightinator.de (pointers/strings)
       └── Clone/checkout Sming & esp-rgbww-firmware at matching git tag/branch
       │
       ▼
[2. Pass 1: Initial Anatomical Analysis]
       ├── Analyze call stack chain & register state
       ├── Correlate symbols with local source context
       └── Determine if additional source files or headers are required
       │
       ▼
[3. Pass 2: Root Cause & Remediation Generation]
       ├── Fetch requested supplemental context (if any)
       ├── Evaluate failure vector and memory corruption scope
       └── Formulate code-level corrective action strategy
       │
       ▼
[4. Persistence & Distribution]
       ├── Save analysis blocks to database (crashDecode records)
       ├── Expose via Web UI
       └── Forward to GitHub Issue Reporter (if enabled)
```

---

## Detailed Implementation Steps

### Phase 1: Repository Management & Context Harvester (`aiContextHarvester.js`)
* **Repository Sync:** Maintain a local cache of `Sming` and `esp-rgbww-firmware` repositories. Dynamically check out the specific branch, tag, or commit hash matching the firmware build version (`gitVersion`).
* **Map File Integration:** Fetch the corresponding `.map` file from `lightinator.de` (following the existing pattern used for ELF files) to extract function addresses, global variables, static buffers, and literal strings.
* **Stack Trace Parsing:** Scan the decoded stack trace for source file paths, line numbers, and function symbols to pull exact code snippets (e.g., $\pm 10$ lines around the fault line).

### Phase 2: Multi-Pass AI Analysis Engine (`aiService.js`)
* **Pass 1 (Anatomy & Gap Analysis):**
  * Send the decoded stack trace, extracted code snippets, and map file symbols to the Gemini model (`gemini-2.5-flash`).
  * Instruct the model to analyze the call chain, register states, memory allocation patterns, and the primary fault vector.
  * Require the model to explicitly evaluate whether additional source files, header definitions, or linked submodules are necessary for a definitive conclusion.
* **Pass 2 (Remediation & Fix Generation):**
  * If Pass 1 identifies missing context, automatically retrieve those additional files from the checked-out repositories.
  * Feed the expanded context back into Gemini for a secondary reasoning pass to isolate the precise defect and generate an engineering-grade code mitigation strategy.

### Phase 3: Storage & Database Updates (`storage.js`)
* Extend the SQLite schema or JSON structure for crash records to store structured analysis metadata:
  * `ai_pass1_result`: Initial anatomical breakdown and context assessment.
  * `ai_pass2_result`: Remediation plan and corrective code patch recommendations.
  * `ai_files_referenced`: JSON array of source files inspected during analysis.

### Phase 4: UI Integration (`ui/`)
* Update the crash inspection view in the Web UI to render collapsible sections for:
  * **Pass 1 Diagnostics:** Call chain breakdown, anatomical fault assessment, and symbol correlation.
  * **Pass 2 Remediation:** Recommended code modifications and structural refactoring strategies.
  * **Source Context Viewer:** Reference snippets from Sming/esp-rgbww-firmware utilized during analysis.

### Phase 5: Issue Reporting Integration (`crashReporter.js`)
* Update the GitHub issue creation handler to automatically append the comprehensive AI analysis results (both anatomical evaluation and remediation strategy) into the body of newly created GitHub issues.

---

## Verification & Error Handling
* **Graceful Degradation:** Ensure network failures when cloning repositories or contacting the Gemini API do not disrupt core syslog ingestion or basic crash decoding.
* **Strict Terminology:** Ensure prompts and internal logging avoid casual or informal metaphors, strictly adhering to professional embedded engineering nomenclature.