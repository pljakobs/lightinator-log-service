/**
 * aiService.js
 * 
 * Multi-pass AI crash analysis engine using the official Google Gen AI SDK,
 * featuring a strictly linear execution queue for non-reentrant repository operations,
 * and an automated sequential fallback ladder.
 */

"use strict";

const { GoogleGenAI } = require("@google/genai");

class AIService {
  constructor({ apiKey, model = "gemini-3.8-flash" } = {}) {
    this.apiKey = apiKey || process.env.LLS_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    
    // Trace key resolution and source
    const source = apiKey ? "constructor argument" 
                 : (process.env.LLS_GEMINI_API_KEY ? "LLS_GEMINI_API_KEY" 
                 : (process.env.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : "none"));
                 
    const maskedKey = this.apiKey ? `${this.apiKey.slice(0, 4)}...${this.apiKey.slice(-4)}` : "MISSING";
    console.log(`[AIService] Resolved key from [${source}] (masked:${maskedKey})`);

    this.model = model;
    if (this.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
    this._queue = Promise.resolve();
  }

  isAvailable() {
    return Boolean(this.ai);
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
  async _generateWithFallback(prompt) {
    if (!this.ai) throw new Error("AI service is not configured.");

    const fallbackChain = [
      this.model,
      "gemini-3.7",
      "gemini-3.6",
      "gemini-3.5"
    ];

    const models = [...new Set(fallbackChain.filter(Boolean))];
    let lastError;

    for (const modelName of models) {
      try {
        console.log(`[AIService] Attempting generation with model: ${modelName}`);
        const response = await this.ai.models.generateContent({
          model: modelName,
          contents: prompt,
        });
        return response.text || "No analysis generated.";
      } catch (err) {
        lastError = err;
        console.warn(`[AIService] Model [${modelName}] failed:${err.message}. Downgrading to next tier...`);
      }
    }

    throw new Error(`All model fallback tiers failed. Final error: ${lastError ? lastError.message : "Unknown error"}`);
  }

  /**
   * Pass 1: Anatomical analysis, call stack evaluation, and context gap identification.
   */
  async runPass1({ soc, gitVersion, decodedText, codeSnippets, mapSymbols }) {
    const prompt = [
      `You are an expert embedded firmware engineer specializing in Sming on the ESP8266/ESP32 platform, analyzing a crash dump.`,
      'your code operates in tight heap conditions, especially on the esp8266, most of the application code uses restrictive heap guards, but there is still a lot of Framework code that uses optimistic heap management',
      `Device SOC: ${soc}`,
      `Firmware Version: ${gitVersion}`,
      ``,
      `### Decoded Stack Trace:`,
      `\`\`\`text`,
      decodedText,
      `\`\`\``,
      ``,
      `### Retrieved Source Context:`,
      codeSnippets && codeSnippets.length > 0 
        ? codeSnippets.map(s => `File: ${s.file} (Repo:${s.repo})\n\`\`\`c\n${s.snippet}\n\`\`\``).join("\n\n")
        : "No direct source snippets matched.",
      ``,
      `### Map File Symbols & Variables:`,
      mapSymbols ? mapSymbols.slice(0, 2000) : "Not available",
      ``,
      `Provide an initial engineering analysis containing:`,
      `1. Crash Anatomy: Evaluate the fault vector, register state, and call chain on the stack.`,
      `2. Subsystem Correlation: Correlate program counter addresses with symbols and code snippets.`,
      `3. Context Gap Assessment: Explicitly state whether additional source files, header definitions, or linked submodules are required for a definitive root-cause conclusion.`,
      '3a Context format: provide file paths, names, start and stop line for the required block as a json array.'
    ].join("\n");

    return await this._generateWithFallback(prompt);
  }

  /**
   * Pass 2: Root-cause isolation and remediation strategy generation.
   */
  async runPass2({ pass1Result, supplementalSnippets }) {
    const prompt = [
      `You are an expert embedded firmware engineer specializing in Sming on the ESP8266/ESP32 platform, analyzing a crash dump.`,
      'your code operates in tight heap conditions, especially on the esp8266, most of the application code uses restrictive heap guards, but there is still a lot of Framework code that uses optimistic heap management',
      ``,
      `### Pass 1 Analysis & Gap Assessment:`,
      pass1Result,
      ``,
      `### Additional Supplemental Source Context:`,
      supplementalSnippets && supplementalSnippets.length > 0 
        ? supplementalSnippets.map(s => `File: ${s.file}\n\`\`\`c\n${s.snippet}\n\`\`\``).join("\n\n")
        : "None required.",
      ``,
      `Provide your final remediation plan:`,
      `1. Root Cause Isolation: Precise diagnosis of memory corruption, null pointer dereference, exception, or assertion failure.`,
      `2. Corrective Action Strategy: Recommended code modification or refactoring strategy to prevent recurrence.`,
      `3. Proposed Code Patch: Concrete snippet showing the corrected logic.`,
    ].join("\n");

    return await this._generateWithFallback(prompt);
  }
}

module.exports = { AIService };