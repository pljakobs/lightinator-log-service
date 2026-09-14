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

  // 1. Extract cause/exception type
  const causeMatch = decodedText.match(/(?:Fatal exception|Guru Meditation Error)[:\s]+(\d+|\w+)/i);
  if (causeMatch) {
    exccause = causeMatch[1].trim();
  }

  // 2. Extract top frame (PC) and top-of-stack calling frame from decoded stacktrace lines
  // Standard Sming decoded lines contain pattern: "0x40... at filename:line"
  const lines = decodedText.split("\n");
  const decodedFrames = [];

  for (const line of lines) {
    const frameMatch = line.match(/(?:at\s+|in\s+)(.+:\d+)/i);
    if (frameMatch) {
      decodedFrames.push(normalizeFrame(frameMatch[1]));
    }
  }

  if (decodedFrames.length > 0) {
    pcFrame = decodedFrames[0];
  }
  if (decodedFrames.length > 1) {
    tosFrame = decodedFrames[1];
  }

  const hashPc = hashToken(pcFrame);
  const hashTos = hashToken(tosFrame);
  const fingerprint = `${exccause}::${hashPc}::${hashTos}`;

  return { exccause, pcFrame, tosFrame, fingerprint };
}

module.exports = { extractCrashFingerprint };
