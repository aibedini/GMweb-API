"use strict";
/**
 * Read-only discovery of hostnames this server ALREADY serves, so an existing
 * domain (installed earlier by `gmweb public-dashboard` or by hand) shows up in
 * the Domains list instead of being invisible.
 *
 * Sources: the configured public origins, and `server_name` lines in nginx's
 * site directories (world-readable by default; unreadable files are skipped).
 * Nothing here writes anything, and a detected name is only a suggestion: it is
 * validated like any other hostname before it can be tracked.
 */
const fs = require("node:fs");
const path = require("node:path");
const { normalizeHostname } = require("./domainStore");

const MARKER = "managed-by: gmweb-domain-helper";
const DIRS = ["/etc/nginx/sites-enabled", "/etc/nginx/conf.d"];

function hostOf(origin) {
  try { return new URL(String(origin)).hostname; } catch { return null; }
}

function detectServedHostnames({ origins = [], dirs = DIRS, readdir = fs.readdirSync, readFile = fs.readFileSync } = {}) {
  const found = new Map();
  const add = (name, source) => {
    const n = normalizeHostname(name);
    if (n.ok && !found.has(n.normalized)) found.set(n.normalized, source);
  };
  for (const origin of origins) { const h = hostOf(origin); if (h) add(h, "configured-origin"); }
  for (const dir of dirs) {
    let files = [];
    try { files = readdir(dir); } catch { continue; }
    for (const file of files) {
      let text;
      try { text = String(readFile(path.join(dir, file), "utf8")); } catch { continue; }
      if (text.includes(MARKER)) continue; // ours: already managed
      for (const line of text.split("\n")) {
        const m = /^\s*server_name\s+([^;]+);/.exec(line);
        if (m) for (const name of m[1].trim().split(/\s+/)) add(name, "nginx");
      }
    }
  }
  return [...found].map(([hostname, source]) => ({ hostname, source }));
}

module.exports = { detectServedHostnames };
