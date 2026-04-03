const SYSLOG_RE = /^<(\d+)>\s*([^\s]+)\s+([^:]+):\s*(\d+)\s*(.*)$/;

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
      message: line,
      raw: line,
    };
  }

  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    receivedAt,
    sourceIp,
    priority: Number.parseInt(match[1], 10),
    tag: match[2],
    app: match[3].trim(),
    deviceTime: Number.parseInt(match[4], 10),
    message: match[5] || "",
    raw: line,
  };
}

module.exports = { parseSyslogLine };
