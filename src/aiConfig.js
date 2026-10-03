"use strict";

const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_URLS = {
  gemini: "https://generativelanguage.googleapis.com",
  openai: "https://api.openai.com/v1",
  ollama: "http://127.0.0.1:11434",
};

function defaultAIBackends(token = "", model = DEFAULT_MODEL) {
  return [{ id: "gemini", type: "gemini", baseUrl: DEFAULT_URLS.gemini,
    models: [...new Set([model, "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"])], token, useLegacyToken: true }];
}

function invalidConfiguration() {
  return Object.assign(new Error("Invalid AI backend configuration"), { status: 400 });
}

function parseAIBackends(value) {
  let entries;
  try { entries = typeof value === "string" ? JSON.parse(value) : value; } catch { throw invalidConfiguration(); }
  if (!Array.isArray(entries) || entries.length > 20) throw invalidConfiguration();
  const ids = new Set();
  return entries.map(entry => {
    if (!entry || !/^[a-zA-Z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id) || !Object.hasOwn(DEFAULT_URLS, entry.type)) throw invalidConfiguration();
    ids.add(entry.id);
    let url;
    try { url = new URL(entry.baseUrl || DEFAULT_URLS[entry.type]); } catch { throw invalidConfiguration(); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalidConfiguration();
    if (!Array.isArray(entry.models) || !entry.models.length || entry.models.length > 20 ||
        entry.models.some(model => typeof model !== "string" || !model.trim() || model.length > 200 || /[\r\n\0]/.test(model))) throw invalidConfiguration();
    if (entry.token != null && (typeof entry.token !== "string" || /[\r\n\0]/.test(entry.token))) throw invalidConfiguration();
    if (entry.useLegacyToken && (entry.id !== "gemini" || entry.type !== "gemini" || url.href.replace(/\/$/, "") !== DEFAULT_URLS.gemini)) throw invalidConfiguration();
    return { id: entry.id, type: entry.type, baseUrl: url.href.replace(/\/$/, ""),
      models: [...new Set(entry.models.map(model => model.trim()))], token: entry.token || "", useLegacyToken: Boolean(entry.useLegacyToken) };
  });
}

function publicAIBackends(backends) {
  return backends.map(({ token, ...backend }) => ({ ...backend, tokenConfigured: Boolean(token) }));
}

function mergeAIBackends(value, previous) {
  const normalized = parseAIBackends(value);
  const incoming = typeof value === "string" ? JSON.parse(value) : value;
  return normalized.map((backend, index) => {
    const original = previous.find(entry => entry.id === backend.id);
    const token = incoming[index].token;
    const replacesToken = token === null || (typeof token === "string" && token !== "");
    if (original?.token && (original.type !== backend.type || original.baseUrl !== backend.baseUrl) && !replacesToken) {
      throw Object.assign(new Error("Changing AI backend type or URL requires replacing or clearing its token"), { status: 400 });
    }
    if (!replacesToken && original?.useLegacyToken) return { ...backend, useLegacyToken: true, token: "" };
    return { ...backend, useLegacyToken: false, token: replacesToken ? backend.token : original?.token || "" };
  });
}

module.exports = { DEFAULT_MODEL, DEFAULT_URLS, defaultAIBackends, parseAIBackends, publicAIBackends, mergeAIBackends };