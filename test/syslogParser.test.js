"use strict";

const { parseSyslogLine } = require("../src/syslogParser");

describe("parseSyslogLine", () => {
  const SOURCE_IP = "192.168.1.10";

  describe("basic structure", () => {
    test("returns an object with required fields", () => {
      const result = parseSyslogLine("<134>hostname app: message text", SOURCE_IP);
      expect(result).toMatchObject({
        sourceIp: SOURCE_IP,
        raw: "<134>hostname app: message text",
      });
      expect(typeof result.id).toBe("string");
      expect(result.id.length).toBeGreaterThan(0);
      expect(typeof result.receivedAt).toBe("string");
      // receivedAt is a valid ISO date
      expect(() => new Date(result.receivedAt)).not.toThrow();
    });

    test("id is unique on repeated calls", () => {
      const r1 = parseSyslogLine("<6>host app: msg", SOURCE_IP);
      const r2 = parseSyslogLine("<6>host app: msg", SOURCE_IP);
      expect(r1.id).not.toBe(r2.id);
    });
  });

  describe("well-formed syslog lines", () => {
    test("parses priority, tag, app, and message", () => {
      const result = parseSyslogLine("<134>ESP_RGB hostname: Hello world", SOURCE_IP);
      expect(result.priority).toBe(134);
      expect(result.tag).toBe("ESP_RGB");
      expect(result.app).toBe("hostname");
      expect(result.message).toBe("Hello world");
    });

    test("parses priority 0", () => {
      const result = parseSyslogLine("<0>host app: msg", SOURCE_IP);
      expect(result.priority).toBe(0);
    });

    test("parses large priority value", () => {
      const result = parseSyslogLine("<191>host app: msg", SOURCE_IP);
      expect(result.priority).toBe(191);
    });

    test("message may be empty", () => {
      const result = parseSyslogLine("<6>host app: ", SOURCE_IP);
      expect(result.message).toBe("");
    });

    test("message with special characters", () => {
      const result = parseSyslogLine("<6>host app: foo=bar baz:qux [123]", SOURCE_IP);
      expect(result.message).toBe("foo=bar baz:qux [123]");
    });
  });

  describe("deviceTime field", () => {
    test("parses numeric deviceTime when present", () => {
      const result = parseSyslogLine("<134>host app: 1700000000 some message", SOURCE_IP);
      expect(result.deviceTime).toBe(1700000000);
    });

    test("deviceTime is null when absent", () => {
      const result = parseSyslogLine("<6>host app: hello", SOURCE_IP);
      expect(result.deviceTime).toBeNull();
    });
  });

  describe("bootNonce field", () => {
    test("parses bootNonce when present", () => {
      const result = parseSyslogLine("<134>host app: nonce:42 message", SOURCE_IP);
      expect(result.bootNonce).toBe(42);
    });

    test("bootNonce is undefined when absent", () => {
      const result = parseSyslogLine("<6>host app: hello", SOURCE_IP);
      expect(result.bootNonce).toBeUndefined();
    });

    test("parses both nonce and deviceTime together", () => {
      const result = parseSyslogLine("<134>host app: nonce:7 1700000000 crash!", SOURCE_IP);
      expect(result.bootNonce).toBe(7);
      expect(result.deviceTime).toBe(1700000000);
      expect(result.message).toBe("crash!");
    });
  });

  describe("sourceIp passthrough", () => {
    test("sets sourceIp from parameter", () => {
      const r = parseSyslogLine("<6>host app: msg", "10.0.0.1");
      expect(r.sourceIp).toBe("10.0.0.1");
    });

    test("uses undefined sourceIp if not provided", () => {
      const r = parseSyslogLine("<6>host app: msg");
      expect(r.sourceIp).toBeUndefined();
    });
  });

  describe("unmatched / malformed lines", () => {
    test("falls back gracefully for empty string", () => {
      const result = parseSyslogLine("", SOURCE_IP);
      expect(result.priority).toBeNull();
      expect(result.tag).toBeNull();
      expect(result.app).toBeNull();
      expect(result.deviceTime).toBeNull();
      expect(result.bootNonce).toBeUndefined();
      expect(result.message).toBe("");
      expect(result.raw).toBe("");
      expect(result.sourceIp).toBe(SOURCE_IP);
    });

    test("falls back gracefully for plain text without syslog prefix", () => {
      const result = parseSyslogLine("just a random log line", SOURCE_IP);
      expect(result.priority).toBeNull();
      expect(result.message).toBe("just a random log line");
    });

    test("falls back gracefully for null input", () => {
      const result = parseSyslogLine(null, SOURCE_IP);
      expect(result.priority).toBeNull();
      expect(result.message).toBe("");
    });

    test("falls back gracefully for undefined input", () => {
      const result = parseSyslogLine(undefined, SOURCE_IP);
      expect(result.priority).toBeNull();
    });

    test("raw field contains the trimmed original line even on mismatch", () => {
      const result = parseSyslogLine("  random text  ", SOURCE_IP);
      expect(result.raw).toBe("random text");
    });
  });

  describe("app field trimming", () => {
    test("trims whitespace from app name", () => {
      const result = parseSyslogLine("<6>host  app with spaces : msg", SOURCE_IP);
      // app is captured between tag and colon — should be trimmed
      expect(result.app).toBe("app with spaces");
    });
  });
});
