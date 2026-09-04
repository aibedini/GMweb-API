const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function clean(value, max = 240) {
  return String(value == null ? "" : value).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function classify(pathname, method) {
  const routePath = clean(pathname, 500) || "/";
  let category = "system";
  if (routePath.startsWith("/send") || routePath.startsWith("/queue") || routePath.startsWith("/admin/queue")) category = "messaging";
  else if (routePath.startsWith("/conversations")) category = "conversations";
  else if (routePath.startsWith("/browser") || routePath.startsWith("/session")) category = "browser";
  else if (routePath.startsWith("/gateway") || routePath.startsWith("/admin/transport") || routePath.startsWith("/admin/device-key")) category = "transport";
  else if (routePath.startsWith("/api/v1/pairing") || routePath.startsWith("/api/v1/pwa/token-login") || routePath === "/api/v1/agent/identity") category = "pairing";
  else if (routePath.startsWith("/admin/api-key")) category = "security";
  else if (routePath.startsWith("/dashboard")) category = "authentication";
  else if (routePath.startsWith("/admin/settings")) category = "settings";
  else if (routePath.startsWith("/admin")) category = "administration";
  else if (routePath === "/health" || routePath === "/ready") category = "health";
  return { category, type: SAFE_METHODS.has(method) ? "request" : "action" };
}

class ActivityLogStore {
  constructor(filePath, { keep = 10000 } = {}) {
    this.filePath = filePath;
    this.keep = keep;
    this.pendingWrites = 0;
  }

  async append(entry) {
    const method = clean(entry.method || "GET", 12).toUpperCase();
    const routePath = clean(entry.path || "/", 500);
    const classified = classify(routePath, method);
    const statusCode = Number(entry.statusCode) || 0;
    const row = {
      id: entry.id || crypto.randomUUID(),
      ts: entry.ts || new Date().toISOString(),
      type: entry.type || classified.type,
      category: entry.category || classified.category,
      level: statusCode >= 500 ? "error" : statusCode >= 400 ? "warning" : "info",
      title: clean(entry.title || `${method} ${routePath}`, 300),
      method,
      path: routePath,
      statusCode,
      outcome: statusCode >= 400 ? "failed" : "success",
      durationMs: Math.max(0, Math.round(Number(entry.durationMs) || 0)),
      actor: {
        type: clean(entry.actor?.type || "anonymous", 32),
        name: clean(entry.actor?.name || "Anonymous", 100),
        id: clean(entry.actor?.id || "", 100) || null
      },
      ip: clean(entry.ip, 100) || null,
      requestId: clean(entry.requestId, 100) || null,
      userAgent: clean(entry.userAgent, 300) || null,
      details: entry.details && typeof entry.details === "object" ? entry.details : {}
    };
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
      if (++this.pendingWrites >= 250) {
        this.pendingWrites = 0;
        this.trim().catch(() => {});
      }
    } catch { /* logging must never break a request */ }
    return row;
  }

  async trim() {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      const lines = text.split("\n").filter(Boolean);
      if (lines.length > this.keep) await fs.writeFile(this.filePath, `${lines.slice(-this.keep).join("\n")}\n`, "utf8");
    } catch { /* no log file yet */ }
  }

  async query({ limit = 200, type, category, level, actorType, search } = {}) {
    let entries = [];
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      entries = text.split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch { /* no log file yet */ }
    const needle = clean(search, 200).toLowerCase();
    const filtered = entries.filter((row) => {
      if (type && row.type !== type) return false;
      if (category && row.category !== category) return false;
      if (level && row.level !== level) return false;
      if (actorType && row.actor?.type !== actorType) return false;
      return !needle || JSON.stringify(row).toLowerCase().includes(needle);
    });
    const categories = {};
    const levels = { info: 0, warning: 0, error: 0 };
    const types = { request: 0, action: 0 };
    for (const row of entries.slice(-this.keep)) {
      categories[row.category || "system"] = (categories[row.category || "system"] || 0) + 1;
      levels[row.level || "info"] = (levels[row.level || "info"] || 0) + 1;
      types[row.type || "request"] = (types[row.type || "request"] || 0) + 1;
    }
    const max = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    return { logs: filtered.slice(-max).reverse(), total: filtered.length, facets: { categories, levels, types } };
  }
}

module.exports = { ActivityLogStore, classify };
