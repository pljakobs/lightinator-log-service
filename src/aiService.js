/**
 * aiService.js
 * 
 * Multi-pass AI crash analysis engine using the official Google Gen AI SDK,
 * featuring a strictly linear execution queue for non-reentrant repository operations,
 * and an automated sequential fallback ladder.
 */

"use strict";

const { GoogleGenAI } = require("@google/genai");
const { OpenAI } = require("openai");
const { Ollama } = require("ollama");
const { defaultAIBackends, parseAIBackends } = require("./aiConfig");

async function fetchWithIdleTimeout(url, options, timeoutMs) {
  const timeoutController = new AbortController();
  let timer;
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => timeoutController.abort(new DOMException("Ollama response idle timeout", "TimeoutError")), timeoutMs);
    timer.unref?.();
  };
  resetTimeout();

  let response;
  try {
    const signals = [options.signal, timeoutController.signal].filter(Boolean);
    response = await fetch(url, { ...options, signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }

  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          clearTimeout(timer);
          controller.close();
          return;
        }
        resetTimeout();
        controller.enqueue(value);
      } catch (error) {
        clearTimeout(timer);
        controller.error(error);
      }
    },
    async cancel(reason) {
      clearTimeout(timer);
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

class AIService {
  constructor({ apiKey, model = "gemini-3.8-flash", backends, contextRounds = 3, contextBytes = 120_000 } = {}) {
    this.apiKey = apiKey ?? process.env.LLS_GEMINI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    
    // Trace key resolution and source
    const source = apiKey != null ? "constructor argument" 
                 : (process.env.LLS_GEMINI_API_KEY ? "LLS_GEMINI_API_KEY" 
                 : (process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : "none"));
                 
    console.log(`[AIService] Resolved key from [${source}] (configured:${Boolean(this.apiKey)})`);

    this.model = model;
    this.contextRounds = Math.max(0, Math.min(10, Number(contextRounds) || 0));
    this.contextBytes = Math.max(1024, Number(contextBytes) || 120_000);
    this.backends = parseAIBackends(backends ?? defaultAIBackends(this.apiKey || "", model)).map(backend => {
      let client = null;
      if (backend.type === "gemini" && backend.token) {
        client = new GoogleGenAI({ apiKey: backend.token, httpOptions: { baseUrl: backend.baseUrl, timeout: backend.timeoutMs } });
      } else if (backend.type === "openai") {
        client = new OpenAI({ apiKey: backend.token || "local", baseURL: backend.baseUrl, timeout: backend.timeoutMs, maxRetries: 0 });
      } else if (backend.type === "ollama") {
        client = new Ollama({ host: backend.baseUrl,
          headers: backend.token ? { Authorization: `Bearer ${backend.token}` } : {},
          fetch: (url, options) => fetchWithIdleTimeout(url, options, backend.timeoutMs),
        });
      }
      return { ...backend, client };
    });
    this.ai = this.backends.find(backend => backend.type === "gemini")?.client;
    this._queue = Promise.resolve();
  }

  isAvailable() {
    return this.backends.some(backend => backend.client);
  }

  /**
   * Enqueues an analysis task to ensure strict linearity (non-reentrant execution).
   */
  enqueue(taskFn) {
    const promise = this._queue.then(() => taskFn());
    this._queue = promise.catch(() => {}); // Prevent queue blockage on failure
    return promise;
  }

  /**
   * Executes content generation with automatic sequential model fallback downgrade.
   */
  async _generateWithFallback(prompt, onUpdate) {
    if (!this.isAvailable()) throw new Error("AI service is not configured.");
    for (const backend of this.backends) {
      if (!backend.client) continue;
      for (const modelName of backend.models) {
        try {
          let text;
          let thinkingReported = false;
          const append = value => {
            if (typeof value !== "string" || !value) return;
            text = (text || "") + value;
            onUpdate?.({ type: "token", text: value });
          };
          if (onUpdate) onUpdate({ type: "reset", backend: backend.id, model: modelName });
          if (backend.type === "gemini") {
            if (onUpdate) {
              const stream = await backend.client.models.generateContentStream({ model: modelName, contents: prompt });
              for await (const chunk of stream) append(chunk.text);
            } else {
              text = (await backend.client.models.generateContent({ model: modelName, contents: prompt })).text;
            }
          } else if (backend.type === "openai") {
            if (onUpdate) {
              const stream = await backend.client.chat.completions.create({ model: modelName, messages: [{ role: "user", content: prompt }], stream: true });
              for await (const chunk of stream) append(chunk.choices?.[0]?.delta?.content);
            } else {
              text = (await backend.client.chat.completions.create({ model: modelName, messages: [{ role: "user", content: prompt }] })).choices?.[0]?.message?.content;
            }
          } else {
            if (onUpdate) {
              const stream = await backend.client.chat({ model: modelName, messages: [{ role: "user", content: prompt }], stream: true, options: { num_ctx: backend.numCtx } });
              for await (const chunk of stream) {
                if (!thinkingReported && typeof chunk.message?.thinking === "string" && chunk.message.thinking.length) {
                  thinkingReported = true;
                  onUpdate({ type: "activity", activity: "thinking" });
                }
                append(chunk.message?.content);
              }
            } else {
              text = (await backend.client.chat({ model: modelName, messages: [{ role: "user", content: prompt }], stream: false, options: { num_ctx: backend.numCtx } })).message?.content;
            }
          }
          if (typeof text !== "string" || !text.trim()) throw new Error("Empty model response");
          return text;
        } catch (error) {
          onUpdate?.({ type: "retry", backend: backend.id, model: modelName });
          const reason = String(error?.message || error || "Unknown error").slice(0, 500);
          console.warn(`[AIService] Backend ${backend.id}, model ${modelName} failed (${error?.name || "Error"}: ${reason}); trying next model.`);
        }
      }
    }
    throw new Error("All configured AI backends and models failed.");
  }

  _contextRequests(text) {
    const candidates = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)].map(match => match[1]);
    candidates.push(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    for (const candidate of candidates) {
      try {
        const requests = JSON.parse(candidate);
        if (Array.isArray(requests)) return requests.filter(request => typeof (request?.file || request?.path) === "string")
          .sort((first, second) => Number(second.priority === "required") - Number(first.priority === "required")).slice(0, 20);
      } catch {}
    }
    return [];
  }

  async analyzeCrash({ harvester, repoPaths, codeSnippets = [], onProgress, ...evidence }) {
    const snippets = [];
    const seen = new Set();
    let bytes = 0;
    const gaps = [];
    const add = snippet => {
      const key = `${snippet.repo}:${snippet.path || snippet.file}:${snippet.startLine || snippet.targetLine}:${snippet.stopLine || ""}`;
      if (seen.has(key)) return false;
      const size = Buffer.byteLength(snippet.snippet || "", "utf8");
      if (bytes + size > this.contextBytes) { gaps.push(`Source omitted due to context budget: ${snippet.file}`); return false; }
      seen.add(key);
      bytes += size;
      snippets.push(snippet);
      return true;
    };
    codeSnippets.forEach(add);
    const describeContext = snippet => ({
      repo: snippet.repo || "Unknown repository",
      file: snippet.file || snippet.path || "Unknown file",
      startLine: snippet.startLine || snippet.targetLine || null,
      stopLine: snippet.stopLine || snippet.targetLine || null,
    });
    onProgress?.({ type: "context", phase: "initial", files: snippets.map(describeContext) });
    let pass1 = "";
    for (let round = 0; round <= this.contextRounds; round++) {
      onProgress?.({ type: "stage", stage: "evidence", round: round + 1 });
      pass1 = await this.runPass1({
        ...evidence,
        codeSnippets: snippets,
        onProgress: onProgress ? update => {
          if (update.type === "reset") onProgress({ type: "stage", stage: "evidence-model" });
          else if (update.type === "retry") onProgress({ type: "stage", stage: "evidence-retry" });
          else if (update.type === "activity") onProgress(update);
        } : undefined,
      });
      const requests = this._contextRequests(pass1);
      if (!requests.length) break;
      if (round === this.contextRounds) { gaps.push("Maximum context rounds reached; outstanding requests remain unresolved."); break; }
      onProgress?.({ type: "stage", stage: "context", round: round + 1 });
      const supplemental = await harvester.getContextFiles(requests, repoPaths, { maxBytes: Math.max(0, this.contextBytes - bytes) });
      let added = false;
      const addedSnippets = [];
      for (const snippet of supplemental) {
        if (add(snippet)) {
          added = true;
          addedSnippets.push(describeContext(snippet));
        }
      }
      if (addedSnippets.length) onProgress?.({ type: "context", phase: "supplemental", files: addedSnippets });
      if (!added) { gaps.push("Requested source was unavailable, already retrieved, or exceeded the context budget."); break; }
    }
    onProgress?.({ type: "stage", stage: "final" });
    return this.runPass2({ ...evidence, pass1Result: `${pass1}\n\nContext limitations:\n${gaps.join("\n") || "None recorded."}`, supplementalSnippets: snippets, onUpdate: onProgress });
  }

  /**
 * Pass 1: Anatomical analysis, call stack evaluation, address resolution,
 * memory/heap analysis, hypothesis generation, and context gap identification.
 */
async runPass1({ soc, gitVersion, decodedText, codeSnippets, mapSymbols, disassembly, onProgress }) {
  const prompt = [
    `You are an expert embedded firmware engineer specializing in Sming and Xtensa/RISC-V based ESP8266/ESP32 systems, analyzing a firmware crash dump.`,
    ``,
    `Your job in this pass is forensic analysis, not immediate remediation.`,
    `Establish what is actually known from the crash dump and supplied source before forming hypotheses.`,
    `Do not assume that the instruction at the faulting PC is the original cause of the failure.`,
    ``,

    `### Firmware Environment`,
    `Device SOC: ${soc}`,
    `Firmware Version: ${gitVersion}`,
    ``,

    `### Important Runtime Characteristics`,
    `The application operates under tight heap conditions, especially on the ESP8266.`,
    `Most application code uses restrictive heap guards and attempts to avoid optimistic allocations.`,
    `However, significant framework code may use more optimistic heap management and may allocate temporary objects, buffers, strings, or other resources.`,
    `Therefore, distinguish carefully between:`,
    `- genuine out-of-memory conditions`,
    `- heap fragmentation`,
    `- allocation failure`,
    `- heap metadata corruption`,
    `- buffer overrun/underrun`,
    `- use-after-free`,
    `- double-free`,
    `- lifetime/ownership errors`,
    `- stack corruption`,
    `- and unrelated CPU faults.`,
    ``,

    `### Decoded Stack Trace`,
    `\`\`\`text`,
    decodedText || "No decoded stack trace available.",
    `\`\`\``,
    ``,

    `### Disassembly Around Faulting PC`,
    disassembly && disassembly.length > 0
      ? `\`\`\`text\n${disassembly}\n\`\`\``
      : "No disassembly supplied. Do not invent assembly instructions.",
    ``,

    `### Retrieved Source Context`,
    codeSnippets && codeSnippets.length > 0
      ? codeSnippets.map(s =>
          `File: ${s.file} (Repo:${s.repo})\n` +
          `\`\`\`c\n${s.snippet}\n\`\`\``
        ).join("\n\n")
      : "No direct source snippets matched.",
    ``,

    `### Map File Symbols & Variables`,
    mapSymbols ? mapSymbols.slice(0, 2000) : "Not available",
    ``,

    `### Core Analysis Rules`,
    ``,
    `1. Crash site is not automatically root cause.`,
    `The faulting PC identifies where the CPU detected a problem. It does not necessarily identify where memory corruption, lifetime corruption, or invalid state originated.`,
    `When appropriate, trace the possible causal chain backwards from the detected failure.`,
    ``,

    `2. Separate facts from inference.`,
    `Every important conclusion must be classified as one of:`,
    `- OBSERVED: directly supported by the dump, symbols, disassembly, or supplied source.`,
    `- INFERRED: logically derived from observed evidence.`,
    `- HYPOTHESIS: plausible explanation that is not established.`,
    `- UNKNOWN: cannot be determined from the supplied evidence.`,
    ``,

    `3. Do not invent evidence.`,
    `Never invent register values, exception causes, source code, symbols, addresses, framework behavior, structure members, macros, APIs, or assembly instructions that are not present in the supplied context.`,
    `If information is unavailable, explicitly say that it is unavailable.`,
    ``,

    `4. Architecture matters.`,
    `Do not assume ESP8266 and ESP32 exception semantics are identical.`,
    `Take the specified SOC into account when interpreting exception causes, registers, stack frames, task/core information, address ranges, instruction encoding, flash/IRAM behavior, and watchdog behavior.`,
    `If the SOC is ambiguous, explicitly identify architecture-dependent conclusions.`,
    ``,

    `5. Do not treat every unexplained stack address as corruption.`,
    `For every suspicious or unresolved address, determine whether it may represent:`,
    `- a code/function address`,
    `- a return address`,
    `- a flash string or flash-resident data address`,
    `- RAM/data`,
    `- stack memory`,
    `- peripheral/MMIO space`,
    `- an invalid/unmapped address`,
    `- or genuinely corrupted data.`,
    `Use the map symbols and linker information when available.`,
    ``,

    `6. If disassembly is supplied, use it.`,
    `Identify the exact instruction corresponding to the faulting PC when possible.`,
    `Determine which register(s) participate in the effective address calculation.`,
    `Compare the calculated access address with the reported fault address when fault information is available.`,
    `Do not claim an exact instruction-level diagnosis when disassembly is not available.`,
    ``,

    `7. Distinguish memory failure types.`,
    `Explicitly distinguish:`,
    `- null/near-null pointer dereference`,
    `- wild pointer`,
    `- use-after-free`,
    `- double-free`,
    `- buffer overflow`,
    `- buffer underflow`,
    `- heap metadata corruption`,
    `- stack corruption`,
    `- stack overflow`,
    `- allocation failure`,
    `- heap fragmentation`,
    `- invalid instruction/execute fault`,
    `- flash/IRAM access problem`,
    `- watchdog/reset`,
    `- assertion/panic`,
    `- and ordinary application logic errors.`,
    ``,

    `8. Heap analysis.`,
    `When heap behavior is relevant, inspect the supplied code for:`,
    `- unchecked allocation results`,
    `- incorrect allocation sizes`,
    `- integer overflow in size calculations`,
    `- incorrect length calculations`,
    `- buffer copies without adequate bounds`,
    `- ownership ambiguity`,
    `- object lifetime problems`,
    `- use-after-free`,
    `- double-free`,
    `- realloc/lifetime problems`,
    `- temporary allocations`,
    `- excessive copying`,
    `- String/container growth`,
    `- error paths that leak or prematurely release memory`,
    `- allocation/free imbalance`,
    `- asynchronous callback lifetime problems`,
    `- fragmentation`,
    `- framework allocations that occur indirectly.`,
    ``,

    `Do not equate "low free heap" with "heap corruption".`,
    `Do not equate "crashed in malloc/free" with "malloc/free caused the bug".`,
    ``,

    `9. Stack analysis.`,
    `Evaluate whether the stack appears structurally valid.`,
    `Look for:`,
    `- impossible return addresses`,
    `- invalid stack pointers`,
    `- repeated or nonsensical frames`,
    `- stack-region violations`,
    `- corrupted saved registers`,
    `- suspicious frame transitions`,
    `- evidence of stack exhaustion or overwrite.`,
    `However, do not label a stack frame corrupt solely because it does not map cleanly to a normal function without checking other possible address interpretations.`,
    ``,

    `10. Concurrency and lifetime.`,
    `Where relevant, consider:`,
    `- interrupts`,
    `- callbacks`,
    `- timers`,
    `- task/thread context`,
    `- asynchronous operations`,
    `- object lifetime across callbacks`,
    `- shared mutable state`,
    `- race conditions`,
    `- reentrancy.`,
    `Only raise these as hypotheses when there is evidence supporting them.`,
    ``,

    `11. Framework versus application responsibility.`,
    `If the crash occurs inside Sming/framework code, do not automatically conclude that the framework is defective.`,
    `Trace backwards to determine whether application-provided data, invalid object lifetime, invalid lengths, allocation failures, or corrupted state could have caused framework code to fail.`,
    `Conversely, do not automatically blame application code when the available evidence specifically indicates a framework defect.`,
    ``,

    `### Required Pass 1 Analysis`,
    ``,

    `1. Crash Classification`,
    `Identify the apparent fault/reset/panic category if the dump provides enough evidence.`,
    `State the relevant exception/fault information, faulting PC, fault address, stack pointer, core/task context, and other relevant registers when available.`,
    ``,

    `2. Crash Anatomy`,
    `Explain what the CPU appears to have been doing at the point of failure.`,
    `Separate directly observed register/fault facts from interpretation.`,
    ``,

    `3. Faulting Instruction`,
    `If disassembly is available, identify the instruction at the faulting PC and explain the memory/code operation it performs.`,
    `If disassembly is unavailable, explicitly state that exact instruction-level analysis cannot be confirmed.`,
    ``,

    `4. Call Stack Evaluation`,
    `Evaluate each meaningful stack frame.`,
    `For each frame, identify the symbol/source location when possible and explain its relevance.`,
    `Identify suspicious, missing, or unresolved frames without automatically assuming corruption.`,
    ``,

    `5. Address and Symbol Correlation`,
    `Correlate program counter addresses, return addresses, register values, and suspicious stack values against the supplied map symbols.`,
    `Check whether unexplained addresses may actually be flash strings or other valid data addresses.`,
    `Do not call an address corrupt merely because it does not correspond to a function.`,
    ``,

    `6. Source Correlation`,
    `Correlate the crash location and callers with the supplied source snippets.`,
    `Identify exact source statements that could plausibly produce the observed failure.`,
    `Do not infer source behavior that is not visible in the supplied snippets.`,
    ``,

    `7. Memory and Heap Analysis`,
    `Determine whether the evidence supports allocation failure, fragmentation, heap corruption, buffer corruption, lifetime corruption, or another memory-related failure.`,
    `Explain the evidence for and against each significant possibility.`,
    ``,

    `8. Causal Chain`,
    `Where possible, construct a causal chain from the earliest plausible defect to the observed crash.`,
    `Example structure:`,
    `earlier invalid operation -> corrupted state/memory -> later detection -> fault.`,
    `Do not claim a causal chain as fact unless the supplied evidence supports it.`,
    ``,

    `9. Competing Hypotheses`,
    `List the important plausible explanations that remain.`,
    `For each hypothesis provide:`,
    `- hypothesis`,
    `- supporting evidence`,
    `- contradicting evidence`,
    `- missing evidence`,
    `- confidence.`,
    ``,

    `Use confidence values exactly as:`,
    `CONFIRMED`,
    `STRONGLY_SUPPORTED`,
    `PLAUSIBLE`,
    `SPECULATIVE`,
    `INSUFFICIENT_DATA`,
    ``,

    `10. Context Gap Assessment`,
    `Explicitly determine whether additional source files, header definitions, linked submodules, disassembly, linker information, allocator information, or callers are required for a definitive root-cause conclusion.`,
    ``,

    `11. Context Request Format`,
    `Provide required additional source/context as a JSON array.`,
    `Each entry must contain:`,
    `- file`,
    `- start_line`,
    `- end_line`,
    `- reason`,
    `- priority`,
    `Use full_file: true only when the entire file is necessary; otherwise request bounded line ranges.`,
    `Do not repeat a request whose source is already included. Return an empty array when context is sufficient.`,
    ``,

    `Priority must be one of:`,
    `required`,
    `confirmation`,
    `optional`,
    ``,

    `Example:`,
    `\`\`\`json`,
    `[{`,
    `  "file": "src/Foo.cpp",`,
    `  "start_line": 120,`,
    `  "end_line": 175,`,
    `  "reason": "Need the caller implementation to determine whether the buffer remains valid when the callback executes.",`,
    `  "priority": "required"`,
    `}]`,
    `\`\`\``,
    ``,

    `12. Evidence Summary`,
    `End the analysis with a concise summary containing:`,
    `- confirmed facts`,
    `- strongest hypothesis`,
    `- alternative hypotheses`,
    `- most important missing evidence`,
    `- whether Pass 2 can reasonably proceed to a concrete patch.`,
    ``,

    `### Required Output Structure`,
    `Use these headings exactly:`,
    ``,
    `## 1. Crash Classification`,
    `## 2. Crash Anatomy`,
    `## 3. Faulting Instruction`,
    `## 4. Call Stack Evaluation`,
    `## 5. Address and Symbol Correlation`,
    `## 6. Source Correlation`,
    `## 7. Memory and Heap Analysis`,
    `## 8. Causal Chain`,
    `## 9. Competing Hypotheses`,
    `## 10. Context Gap Assessment`,
    `## 11. Context Requests`,
    `## 12. Evidence Summary`,
    ``,

    `Be technically precise and conservative.`,
    `A useful "insufficient data" conclusion is preferable to an invented root cause.`
  ].join("\n");

  return await this._generateWithFallback(prompt, onProgress);
}


/**
 * Pass 2: Independent root-cause validation, causal-chain isolation,
 * remediation strategy, patch generation, and verification.
 */
async runPass2({ pass1Result, supplementalSnippets, mapSymbols, disassembly, decodedText, onUpdate }) {
  const prompt = [
    `You are an expert embedded firmware engineer specializing in Sming and Xtensa/RISC-V based ESP8266/ESP32 systems.`,
    `You are performing the final forensic analysis of a firmware crash.`,
    ``,

    `This is Pass 2.`,
    `Pass 1 is evidence and hypothesis material, not ground truth.`,
    `Independently evaluate the Pass 1 reasoning against the available evidence.`,
    `Do not simply repeat or accept its proposed root cause.`,
    ``,

    `### Runtime Characteristics`,
    `The application operates under tight heap conditions, especially on the ESP8266.`,
    `Most application code uses restrictive heap guards, while significant framework code may use more optimistic heap management.`,
    `Treat heap exhaustion, fragmentation, corruption, lifetime errors, and invalid memory access as distinct failure modes.`,
    ``,

    `### Pass 1 Analysis & Gap Assessment`,
    `\`\`\`text`,
    pass1Result || "No Pass 1 result available.",
    `\`\`\``,
    ``,
    `### Original Decoded Crash Evidence`,
    `\`\`\`text`,
    decodedText || "No decoded evidence supplied.",
    `\`\`\``,
    ``,

    `### Additional Supplemental Source Context`,
    supplementalSnippets && supplementalSnippets.length > 0
      ? supplementalSnippets.map(s =>
          `File: ${s.file}\n` +
          `\`\`\`c\n${s.snippet}\n\`\`\``
        ).join("\n\n")
      : "None supplied.",
    ``,

    `### Map File Symbols & Variables`,
    mapSymbols ? mapSymbols.slice(0, 2000) : "Not available.",
    ``,

    `### Disassembly`,
    disassembly && disassembly.length > 0
      ? `\`\`\`text\n${disassembly}\n\`\`\``
      : "Not available.",
    ``,

    `### Pass 2 Rules`,
    ``,

    `1. Validate before diagnosing.`,
    `Do not accept a Pass 1 hypothesis merely because it is plausible.`,
    `Check whether the proposed root cause explains the actual fault type, PC, fault address, registers, stack, source, and timing/context represented by the dump.`,
    ``,

    `2. Distinguish crash site, immediate cause, and originating cause.`,
    `Explicitly identify:`,
    `- where the CPU detected the problem`,
    `- what operation immediately failed`,
    `- what earlier condition most likely produced that failure.`,
    `These may be the same location, but do not assume that they are.`,
    ``,

    `3. Build a causal chain.`,
    `The final diagnosis should explain the sequence of events from the earliest supported defect through to the observed crash.`,
    `For example:`,
    `invalid length calculation -> out-of-bounds write -> heap metadata corruption -> later free() -> allocator failure -> CPU exception.`,
    `Only use a causal chain when the evidence supports it.`,
    ``,

    `4. Eliminate alternatives.`,
    `For each major competing hypothesis from Pass 1, state whether it is:`,
    `- supported`,
    `- weakened by evidence`,
    `- contradicted by evidence`,
    `- or unresolved.`,
    `Do not force a single root cause if the available evidence cannot distinguish between alternatives.`,
    ``,

    `5. Evidence discipline.`,
    `Separate:`,
    `- confirmed facts`,
    `- strong inferences`,
    `- hypotheses`,
    `- unresolved questions.`,
    `Never manufacture missing evidence.`,
    ``,

    `6. Source discipline.`,
    `Only claim that a specific source statement is responsible when that statement is present in the supplied source context.`,
    `Do not invent omitted lines, function implementations, structure members, macros, configuration values, APIs, or framework internals.`,
    ``,

    `7. Concrete patch discipline.`,
    `Only provide a concrete code patch when the relevant source code is actually present in the supplied snippets.`,
    `The patch must modify only logic that can be supported by the provided source.`,
    `Do not include fictional "old code" that is not present in the supplied snippets.`,
    `Do not invent surrounding code merely to make a patch compile.`,
    `If the relevant source is incomplete, provide a remediation strategy or pseudocode instead of pretending to provide a verified patch.`,
    ``,

    `8. Framework code.`,
    `If the failure occurs in framework code, determine whether application-provided state or data could have triggered it.`,
    `Do not blame the framework merely because the faulting PC is inside framework code.`,
    `Do not blame application code when the evidence points directly to a framework defect.`,
    ``,

    `9. Unresolved addresses.`,
    `If any stack or register addresses do not cleanly map into functions, check the map information for possible flash strings or other valid data before interpreting them as corrupted return addresses.`,
    `Classify unresolved addresses as code, data/string, RAM, stack, peripheral, invalid, or genuinely unresolved where possible.`,
    ``,

    `10. Memory corruption.`,
    `When memory corruption is suspected, identify:`,
    `- the operation that may have corrupted memory`,
    `- the affected object/buffer/metadata if identifiable`,
    `- the likely corruption direction and size if determinable`,
    `- when the corruption was likely introduced`,
    `- when it was detected.`,
    `Do not assume that the detection point is the corruption point.`,
    ``,

    `11. Heap behavior.`,
    `Explicitly distinguish:`,
    `- allocation failure`,
    `- low heap`,
    `- fragmentation`,
    `- heap metadata corruption`,
    `- use-after-free`,
    `- double-free`,
    `- buffer overflow/underflow.`,
    `If the evidence only supports "memory-related failure", do not over-specify the mechanism.`,
    ``,

    `12. Verification.`,
    `Every proposed fix must have a verification strategy capable of proving that the suspected mechanism has been addressed.`,
    `Include targeted runtime instrumentation, assertions, heap checks, guard patterns, logging, stress tests, or reproduction tests where appropriate.`,
    `Do not claim that a fix is proven merely because the crash disappears once.`,
    ``,

    `### Required Final Analysis`,
    ``,

    `1. Final Root Cause Assessment`,
    `State the most strongly supported root cause and its confidence.`,
    `If no single root cause can be established, explicitly say so and provide the remaining hypotheses instead of arbitrarily selecting one.`,
    ``,

    `2. Evidence Supporting the Diagnosis`,
    `List the concrete dump, symbol, disassembly, and source evidence supporting the diagnosis.`,
    ``,

    `3. Evidence Against / Remaining Uncertainty`,
    `Identify evidence that weakens the diagnosis and explicitly identify unresolved questions.`,
    ``,

    `4. Causal Chain`,
    `Provide the most likely complete chain from originating defect to observed crash.`,
    ``,

    `5. Root Cause Isolation`,
    `Identify the exact source statement/function/component responsible when the evidence permits this.`,
    `If it does not, identify the narrowest defensible location and explain what additional context is required.`,
    ``,

    `6. Corrective Action Strategy`,
    `Explain the engineering change required to prevent recurrence.`,
    `Consider correctness, memory usage, heap pressure, lifetime, ownership, error handling, and embedded-system constraints.`,
    ``,

    `7. Proposed Code Patch`,
    `Only provide a concrete patch if the relevant source is present.`,
    `The patch must be based strictly on supplied source code.`,
    `Do not invent missing code.`,
    `If a concrete patch cannot safely be produced, explicitly state why and provide the exact source context still required.`,
    ``,

    `8. Additional Context Required`,
    `If more information is required, provide a JSON array using this format:`,
    `\`\`\`json`,
    `[{`,
    `  "file": "src/Foo.cpp",`,
    `  "start_line": 120,`,
    `  "end_line": 175,`,
    `  "reason": "Need to verify ownership and lifetime of the object passed to the asynchronous callback.",`,
    `  "priority": "required"`
    `}]`,
    `\`\`\``,
    ``,

    `9. Verification Plan`,
    `Provide concrete tests and instrumentation to verify the remediation.`,
    `Include both:`,
    `- a targeted reproduction test for the suspected failure`,
    `- regression testing for normal operation and constrained-heap conditions.`,
    ``,

    `10. Residual Risk`,
    `Identify any remaining plausible failure modes that the proposed change does not address.`,
    ``,

    `### Required Output Structure`,
    `Use these headings exactly:`,
    ``,
    `## 1. Final Root Cause Assessment`,
    `## 2. Evidence Supporting the Diagnosis`,
    `## 3. Evidence Against / Remaining Uncertainty`,
    `## 4. Causal Chain`,
    `## 5. Root Cause Isolation`,
    `## 6. Corrective Action Strategy`,
    `## 7. Proposed Code Patch`,
    `## 8. Additional Context Required`,
    `## 9. Verification Plan`,
    `## 10. Residual Risk`,
    ``,

    `### Final Requirement`,
    `Do not optimize for producing a confident answer.`,
    `Optimize for producing a technically defensible answer.`,
    `If the supplied evidence is insufficient to establish root cause, say so clearly and identify the smallest additional evidence needed to establish it.`
  ].join("\n");

  return await this._generateWithFallback(prompt, onUpdate);
  }
}

module.exports = { AIService };