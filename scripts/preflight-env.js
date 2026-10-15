#!/usr/bin/env node
"use strict";
/**
 * Preflight the environment contract BEFORE promoting a candidate.
 *
 * THE INCIDENT THIS PREVENTS
 *
 * On 2026-10-14 the updater promoted a release whose startup guard requires an
 * explicit HTTPS `PUBLIC_WEB_ORIGIN` in production. The server's `.env` did not
 * satisfy it. Because `NODE_ENV=production` is injected by systemd INDEPENDENTLY
 * of `.env`, and because `dotenv.config()` does NOT override variables that are
 * already set in the process environment, the new code threw during startup:
 *
 *     2581 x  PUBLIC_WEB_ORIGIN must be set to an HTTPS URL in production
 *             (ADR-007 BLOCKER 7) — refusing to start
 *
 * systemd restarted it every 5s for five hours. Every subsequent `gmweb update`
 * then failed at the queue gate with
 *     "Cannot inspect the queue; refusing a migration without send-safety checks."
 * because the API was simply not running. The operator saw a QUEUE problem that
 * was really a SERVICE-START problem.
 *
 * So: a candidate that cannot start with the CURRENT environment must be rejected
 * BEFORE the live service is ever restarted.
 *
 * Precedence, mirroring runtime exactly:
 *   1. systemd `Environment=`  (already in process.env at start; dotenv will NOT
 *      override it)
 *   2. `.env`                  (fills only the gaps)
 *
 * Usage:
 *   node scripts/preflight-env.js --app-dir /opt/gmweb-api [--env-file path]
 * Exit 0 = compatible, 1 = candidate would fail to start (blocks promotion).
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function parseEnvFile(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** systemd Environment= for the unit; these WIN over .env at runtime. */
function systemdEnvironment(service) {
  try {
    const raw = execFileSync("systemctl", ["show", "-p", "Environment", "--value", service],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const out = {};
    // Values are whitespace-separated KEY=VALUE with shell-ish quoting.
    for (const token of raw.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      let value = token.slice(eq + 1);
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      out[token.slice(0, eq)] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** The candidate's startup contract, expressed as checks. */
function checkEnvironment(env) {
  const problems = [];
  const isProduction = env.NODE_ENV === "production";

  if (isProduction) {
    // Mirrors src/pairingRoutes.js (ADR-007 BLOCKER 7). Kept in sync deliberately:
    // if the app tightens this, the preflight must tighten with it.
    const web = env.PUBLIC_WEB_ORIGIN;
    if (!web) {
      problems.push("PUBLIC_WEB_ORIGIN is not set, but NODE_ENV=production requires an explicit HTTPS origin "
        + "(ADR-007). Set it in the service .env, or the API will refuse to start.");
    } else if (!web.startsWith("https://")) {
      problems.push(`PUBLIC_WEB_ORIGIN is not an HTTPS URL (starts with "${web.slice(0, 8)}…"), but `
        + "NODE_ENV=production requires one (ADR-007). The API will refuse to start.");
    }
    const api = env.PUBLIC_API_ORIGIN;
    if (web && api) {
      for (const [name, value] of [["PUBLIC_WEB_ORIGIN", web], ["PUBLIC_API_ORIGIN", api]]) {
        let parsed;
        try { parsed = new URL(value); } catch { problems.push(`${name} is not a valid URL.`); continue; }
        if (parsed.protocol !== "https:") {
          problems.push(`${name} must use https:// in production.`);
        }
        if (parsed.origin !== value.replace(/\/$/, "")) {
          problems.push(`${name} must be an ORIGIN only (no path): got "${value}".`);
        }
      }
    }
  }

  // A service that cannot authenticate cannot be health-checked or drained.
  if (!env.API_TOKEN) {
    problems.push("API_TOKEN is not set. The service would start without authentication and "
      + "the updater could not verify readiness.");
  }
  return problems;
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--app-dir") args.appDir = argv[++i];
    else if (argv[i] === "--env-file") args.envFile = argv[++i];
    else if (argv[i] === "--service") args.service = argv[++i];
    else if (argv[i] === "--json") args.json = true;
  }
  const appDir = args.appDir || "/opt/gmweb-api";
  const envFile = args.envFile || path.join(appDir, ".env");
  const service = args.service || "gmweb-api.service";

  const fileEnv = fs.existsSync(envFile) ? parseEnvFile(fs.readFileSync(envFile, "utf8")) : {};
  const unitEnv = systemdEnvironment(service);
  // systemd wins: dotenv does not override an already-set process variable.
  const effective = { ...fileEnv, ...unitEnv };

  const problems = checkEnvironment(effective);
  const report = {
    service,
    envFile,
    // Names only — never values.
    keysFromUnit: Object.keys(unitEnv).sort(),
    productionMode: effective.NODE_ENV === "production",
    nodeEnvSource: Object.prototype.hasOwnProperty.call(unitEnv, "NODE_ENV") ? "systemd" : (fileEnv.NODE_ENV ? ".env" : "unset"),
    ok: problems.length === 0,
    problems,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    process.stdout.write(`Environment contract OK (NODE_ENV source: ${report.nodeEnvSource})\n`);
  } else {
    process.stderr.write("Candidate is NOT compatible with the current environment:\n");
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.stderr.write("\nFix the environment, then re-run. The live service was NOT touched.\n");
  }
  return report.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseEnvFile, checkEnvironment, systemdEnvironment };
