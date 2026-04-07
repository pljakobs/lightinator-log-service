// The sequence-number (uptime-ms prefix) is optional: messages emitted via
// Serial.printf / debugf without the debug_i uptime stamp won't have one.
// Group layout:
//   1 priority  2 hostname  3 tag  4 nonce (optional, new fw)  5 deviceTime (optional)  6 message
const SYSLOG_RE = /^<(\d+)>\s*([^\s]+)\s+([^:]+):\s*(?:nonce:(\d+)\s+)?(?:(\d+)\s+)?(.*)/;
// Optional nonce suffix: "===== system restart ===== nonce:12345"
const RESTART_RE = /^={4,}\s*system restart\s*={4,}(?:\s+nonce:(\d+))?$/i;

function parseSyslogLine(rawLine, sourceIp) {
  const line = String(rawLine || "").trim();
  const receivedAt = new Date().toISOString();

  const match = line.match(SYSLOG_RE);
  if (!match) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      receivedAt,
      sourceIp,
      priority: null,
      tag: null,
      app: null,
      deviceTime: null,
      isRestartMarker: false,
      message: line,
      raw: line,
    };
  }

  const message = match[6] || "";
  const restartMatch = message.match(RESTART_RE);
  // bootNonce: prefer the per-line header nonce (match[4], new firmware),
  // fall back to the nonce embedded in the restart marker message body (old firmware).
  const bootNonce = match[4] != null
    ? Number.parseInt(match[4], 10)
    : (restartMatch?.[1] != null ? Number.parseInt(restartMatch[1], 10) : undefined);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt,
    sourceIp,
    priority: Number.parseInt(match[1], 10),
    tag: match[2],
    app: match[3].trim(),
    deviceTime: match[5] != null ? Number.parseInt(match[5], 10) : null,
    isRestartMarker: !!restartMatch,
    bootNonce,
    message,
    raw: line,
  };
}

module.exports = { parseSyslogLine };
