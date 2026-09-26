/**
 * aiService.js
 * 
 * Multi-pass AI crash analysis engine using the official Google Gen AI SDK.
 */

"use strict";

const { GoogleGenAI } = require("@google/genai");

class AIService {
  constructor({ apiKey, model = "gemini-2.5-flash" } = {}) {
    this.apiKey = apiKey || process.env.LLS_GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    this.model = model;
    if (this.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: this.apiKey });
    }
  }

  isAvailable() {
    return Boolean(this.ai);
  }

  /**
   * Pass 1: Anatomical analysis, call stack evaluation, and context gap identification.
   */
  async runPass1({ soc, gitVersion, decodedText, codeSnippets, mapSymbols }) {
    if (!this.ai) throw new Error("AI service is not configured.");

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

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
    });

    return response.text || "No Pass 1 analysis generated.";
  }

  /**
   * Pass 2: Root-cause isolation and remediation strategy generation.
   */
  async runPass2({ pass1Result, supplementalSnippets }) {
    if (!this.ai) throw new Error("AI service is not configured.");

    const prompt = [
            `You are an expert embedded firmware engineer specializing in Sming on the ESP8266/ESP32 platform, analyzing a crash dump.`,
      'your code operates in tight heap conditions, especially on the esp8266, most of the application code uses restrictive heap guards, but there is still a lot of Framework code that uses optimistic heap management'.
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

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: prompt,
    });

    return response.text || "No Pass 2 analysis generated.";
  }
}

module.exports = { AIService };