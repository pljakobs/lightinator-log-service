const SYSLOG_RE = /^<(\d+)>\s*([^\s]+)\s+([^:]+):\s*(\d+)\s*(.*)$/;
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

  const message = match[5] || "";
  const restartMatch = message.match(RESTART_RE);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt,
    sourceIp,
    priority: Number.parseInt(match[1], 10),
    tag: match[2],
    app: match[3].trim(),
    deviceTime: Number.parseInt(match[4], 10),
    isRestartMarker: !!restartMatch,
    bootNonce: restartMatch ? restartMatch[1] : undefined,
    message,
    raw: line,
  };
}

module.exports = { parseSyslogLine };
