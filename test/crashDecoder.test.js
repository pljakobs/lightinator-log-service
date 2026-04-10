"use strict";

const { CrashDecoder } = require("../src/crashDecoder");

function makeRecord(ip, message, overrides = {}) {
  return {
    id: `test-${Date.now()}`,
    receivedAt: new Date().toISOString(),
    sourceIp: ip,
    priority: 6,
    tag: "ESP8266",
    app: "system",
    message,
    raw: message,
    ...overrides,
  };
}

const TRIGGER_LINE = "pc=0x40201234 sp=0x3ffff350 excvaddr=0x00000000";

describe("CrashDecoder.feed() — state machine", () => {
  let onDecoded;
  let decoder;

  beforeEach(() => {
    onDecoded = jest.fn();
    decoder = new CrashDecoder({
      elfCacheDir: "/tmp/lls-test-elfs",
      elfBaseUrl: "http://example.com/download",
      onDecoded,
    });
  });

  // ── Trigger detection ─────────────────────────────────────────────────────

  test("returns false for a regular (non-crash) message", () => {
    const result = decoder.feed(makeRecord("1.2.3.4", "Normal startup message"));
    expect(result).toBe(false);
  });

  test("returns true when trigger line is detected", () => {
    const result = decoder.feed(makeRecord("1.2.3.4", TRIGGER_LINE));
    expect(result).toBe(true);
  });

  test("trigger starts collection (record present in state)", () => {
    decoder.feed(makeRecord("1.2.3.4", TRIGGER_LINE));
    expect(decoder._collecting.has("1.2.3.4")).toBe(true);
  });

  test("trigger line is case-insensitive (upper-case hex)", () => {
    const upper = "pc=0x40201234 sp=0x3FFFF350 excvaddr=0x00000000";
    decoder.feed(makeRecord("1.2.3.4", upper));
    expect(decoder._collecting.has("1.2.3.4")).toBe(true);
  });

  // ── Collecting phase ──────────────────────────────────────────────────────

  test("lines after trigger are collected", () => {
    const ip = "1.2.3.4";
    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    decoder.feed(makeRecord(ip, "epc2=0x00000000 epc3=0x00000000 exccause=3 depc=0x00000000"));
    const state = decoder._collecting.get(ip);
    expect(state.lines.length).toBe(2);
  });

  test("'Stack dump:' sets inStack flag", () => {
    const ip = "1.2.3.4";
    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    decoder.feed(makeRecord(ip, "Stack dump:"));
    const state = decoder._collecting.get(ip);
    expect(state.inStack).toBe(true);
  });

  test("lines outside a crash context are ignored", () => {
    decoder.feed(makeRecord("1.2.3.4", "some unrelated line"));
    expect(decoder._collecting.has("1.2.3.4")).toBe(false);
  });

  // ── Separate IPs are tracked independently ─────────────────────────────────

  test("separate IPs maintain independent crash state", () => {
    const ip1 = "1.2.3.4";
    const ip2 = "1.2.3.5";
    decoder.feed(makeRecord(ip1, TRIGGER_LINE));
    decoder.feed(makeRecord(ip2, "ordinary message"));
    expect(decoder._collecting.has(ip1)).toBe(true);
    expect(decoder._collecting.has(ip2)).toBe(false);
  });

  test("two IPs can collect concurrently", () => {
    const ip1 = "1.2.3.4";
    const ip2 = "5.6.7.8";
    decoder.feed(makeRecord(ip1, TRIGGER_LINE));
    decoder.feed(makeRecord(ip2, TRIGGER_LINE));
    expect(decoder._collecting.has(ip1)).toBe(true);
    expect(decoder._collecting.has(ip2)).toBe(true);
  });

  // ── End-of-dump ───────────────────────────────────────────────────────────

  test("blank line after stack data ends collection", () => {
    const ip = "1.2.3.4";
    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    decoder.feed(makeRecord(ip, "Stack dump:"));
    decoder.feed(makeRecord(ip, "3ffff350:  40201234 3ffef888"));
    decoder.feed(makeRecord(ip, ""));  // blank → end
    // State should be removed from _collecting
    expect(decoder._collecting.has(ip)).toBe(false);
  });

  test("blank line before 'Stack dump:' does NOT end collection", () => {
    const ip = "1.2.3.4";
    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    // inStack is still false here
    decoder.feed(makeRecord(ip, ""));
    // Still collecting because inStack was false
    expect(decoder._collecting.has(ip)).toBe(true);
  });

  // ── Re-trigger during collection ──────────────────────────────────────────

  test("new trigger from same IP resets collection", () => {
    const ip = "1.2.3.4";
    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    decoder.feed(makeRecord(ip, "Stack dump:"));
    decoder.feed(makeRecord(ip, "3ffff350:  40201234"));
    // Second crash before the first finishes — should reset
    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    const state = decoder._collecting.get(ip);
    expect(state.inStack).toBe(false);
    expect(state.lines.length).toBe(1); // only the new trigger line
  });

  // ── _decode is scheduled asynchronously ──────────────────────────────────

  test("_decode is called via setImmediate after end-of-dump (mocked)", async () => {
    const ip = "1.2.3.4";
    // Spy on _decode to prevent actual network/process calls
    const decodeSpy = jest.spyOn(decoder, "_decode").mockResolvedValue(undefined);

    decoder.feed(makeRecord(ip, TRIGGER_LINE));
    decoder.feed(makeRecord(ip, "Stack dump:"));
    decoder.feed(makeRecord(ip, "3ffff350:  40201234"));
    decoder.feed(makeRecord(ip, ""));

    // Wait for setImmediate to fire
    await new Promise(resolve => setImmediate(resolve));
    expect(decodeSpy).toHaveBeenCalledWith(ip, expect.any(Object), expect.any(Array));
    decodeSpy.mockRestore();
  });
});
