"use strict";

const crypto = require("crypto");

/**
 * Normalizes a decoded frame string by stripping build-path prefixes.
 * Example: "/home/runner/work/app/src/main.cpp:42" -> "src/main.cpp:42"
 */
function normalizeFrame(frameStr) {
  if (!frameStr) return "";
  let clean = frameStr.trim();
  // Strip compiler build-root prefixes up to common source folders
  clean = clean.replace(/^(?:\/.*?\/)+(?=(?:src|include|Sming|Components)\/)/i, "");
  return clean;
}

function hashToken(text) {
  if (!text) return "00000000";
  return crypto.createHash("sha256").update(text).digest("hex").slice(-8);
}

/**
 * Parses decoded crash output and extracts fingerprint components.
 * Returns: { exccause, pcFrame, tosFrame, fingerprint }
 */
function extractCrashFingerprint(decodedText) {
  let exccause = "unknown";
  let pcFrame = "";
  let tosFrame = "";

  if (!decodedText) {
    return { exccause, pcFrame, tosFrame, fingerprint: "unknown::00000000::00000000" };
  }

  // 1. Extract exception cause (supports "Fatal exception (4):", "Fatal exception 4", etc.)
  const causeMatch = decodedText.match(/(?:Fatal exception|Guru Meditation Error)[^\d\n]*\(?(\d+|\w+)\)?/i);
  if (causeMatch) {
    exccause = causeMatch[1].trim();
  }

  // 2. Extract call frames matching file:line patterns (e.g. "path/file.c:124")
  const lines = decodedText.split("\n");
  const decodedFrames = [];

  for (const line of lines) {
    // Match optional 'at/in' OR lines containing source file paths with line numbers
    const frameMatch = line.match(/(?:(?:at|in)\s+)?([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+:\d+)/i);
    if (frameMatch) {
      decodedFrames.push(normalizeFrame(frameMatch[1]));
    }
  }

  if (decodedFrames.length > 0) pcFrame = decodedFrames[0];
  if (decodedFrames.length > 1) tosFrame = decodedFrames[1];

  const hashPc = hashToken(pcFrame);
  const hashTos = hashToken(tosFrame);
  const fingerprint = `${exccause}::${hashPc}::${hashTos}`;

  return { exccause, pcFrame, tosFrame, fingerprint };
}
module.exports = { extractCrashFingerprint };
