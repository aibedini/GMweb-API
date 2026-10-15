#!/usr/bin/env node
"use strict";

/**
 * PUBLIC_WEB_ORIGIN preflight for GMweb production.
 *
 * Run BEFORE anything restarts or activates the API. It establishes the ADR-007 origins or
 * stops the deployment, so a missing value can never turn into a service restart loop.
 *
 * Exit codes
 *   0  the origins are resolved, validated and propagated
 *   1  no valid value could be established (non-interactive) -> DO NOT activate
 *   2  a value was found but is invalid, or systemd propagation could not be repaired
 *   3  usage error
 *
 * Read-only mode (`--check-only`) never writes: it reports whether a deploy would be safe.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const {
  validatePublicOrigin,
  resolvePublicOrigin,
  sameHost,
  interactivePromptText,
} = require("./lib/publicOrigin");
const systemdEnvironment = require("./lib/systemdEnvironment");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_APP_DIR = process.env.GMWEB_APP_DIR || "/opt/gmweb-api";
const WEB_KEY = "PUBLIC_WEB_ORIGIN";
const API_KEY = "PUBLIC_API_ORIGIN";

const EXIT_OK = 0;
const EXIT_UNRESOLVED = 1;
const EXIT_INVALID = 2;
const EXIT_USAGE = 3;

function usage() {
  return [
    "Usage: node scripts/publicOriginPreflight.js [options]",
    "",
    "  --app-dir DIR        application directory holding .env (default: /opt/gmweb-api)",
    "  --systemd-root DIR   filesystem root for systemd unit discovery (default: /)",
    "  --web-origin URL     explicit PUBLIC_WEB_ORIGIN, highest precedence",
    "  --api-origin URL     explicit PUBLIC_API_ORIGIN",
    "  --proxy-origin URL   origin from the authoritative public vhost, if already known",
    "  --interactive        allow prompting when discovery fails (default: tty detection)",
    "  --non-interactive    never prompt; fail instead",
    "  --check-only         read-only: report, change nothing",
    "  --json               machine-readable result on stdout",
    "  --help               this text",
    "",
    "Never prints secret values.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    appDir: DEFAULT_APP_DIR,
    systemdRoot: "/",
    webOrigin: undefined,
    apiOrigin: undefined,
    proxyOrigin: undefined,
    interactive: undefined,
    checkOnly: false,
    json: false,
    help: false,
  };
  const takesValue = new Set(["--app-dir", "--systemd-root", "--web-origin", "--api-origin", "--proxy-origin"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--interactive") {
      options.interactive = true;
      continue;
    }
    if (arg === "--non-interactive") {
      options.interactive = false;
      continue;
    }
    if (arg === "--check-only") {
      options.checkOnly = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (takesValue.has(flag)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) {
        throw new Error(`${flag} requires a value`);
      }
      const key = {
        "--app-dir": "appDir",
        "--systemd-root": "systemdRoot",
        "--web-origin": "webOrigin",
        "--api-origin": "apiOrigin",
        "--proxy-origin": "proxyOrigin",
      }[flag];
      options[key] = value;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

/**
 * Is this deployment single-origin?
 *
 * Two independent signals, and a live probe beats a static one:
 *   1. the running API answers `/web/` and `/health` on the SAME base URL, which is
 *      direct physical evidence that one origin serves both (authentication is not
 *      required for either route);
 *   2. failing that, the checkout structurally mounts the PWA under `/web` and the API
 *      under `/api/v1` on one Fastify instance.
 *
 * The API origin is only ever reused as the web origin when one of these is true, because
 * ADR-007 binds both origins into the pairing transcript and a wrong web origin silently
 * breaks Android enrollment.
 */
async function detectSingleOrigin(port) {
  const evidence = [];
  const base = `http://127.0.0.1:${port}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const [health, web] = await Promise.all([
      fetch(`${base}/health`, { signal: controller.signal, redirect: "manual" }),
      fetch(`${base}/web/`, { signal: controller.signal, redirect: "manual" }),
    ]);
    clearTimeout(timer);
    if (health.ok && web.ok) {
      evidence.push(`live probe: ${base}/health and ${base}/web/ both answered on one origin`);
      return { singleOrigin: true, evidence };
    }
    evidence.push(`live probe inconclusive (/health=${health.status}, /web/=${web.status})`);
  } catch (error) {
    evidence.push(`live probe unavailable (${error.name === "AbortError" ? "timeout" : error.code || error.message})`);
  }

  // Structural fallback: the app itself mounts both surfaces on one listener.
  try {
    const serverSource = fs.readFileSync(path.join(REPO_ROOT, "src", "server.js"), "utf8");
    const mountsWeb = /app\.get\(\s*"\/web/.test(serverSource) || serverSource.includes('"/web"');
    const mountsApi = serverSource.includes("/api/v1/") || serverSource.includes('"/api/');
    if (mountsWeb && mountsApi) {
      evidence.push("structural: src/server.js mounts the PWA (/web) and the API (/api/v1) on one Fastify instance");
      return { singleOrigin: true, evidence };
    }
    evidence.push("structural: could not confirm /web and /api mount on one instance");
  } catch (error) {
    evidence.push(`structural check unavailable (${error.message})`);
  }
  return { singleOrigin: false, evidence };
}

/**
 * Discover the public web origin from an authoritative reverse-proxy virtual host.
 *
 * Only `server_name`/`server` directives on a listening TLS (443) server block are
 * considered, and a wildcard or catch-all name is rejected: a vhost that answers for
 * everything does not tell us the application's public name.
 */
function discoverFromReverseProxy(roots) {
  const candidates = [];
  const nginxFiles = [];
  const caddyFiles = [];
  for (const root of roots) {
    for (const dir of ["etc/nginx/sites-enabled", "etc/nginx/conf.d"]) {
      const full = path.join(root, dir);
      let names = [];
      try {
        names = fs.readdirSync(full);
      } catch {
        continue;
      }
      for (const name of names) nginxFiles.push(path.join(full, name));
    }
    caddyFiles.push(path.join(root, "etc/caddy/Caddyfile"));
  }

  for (const file of nginxFiles) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // Track the enclosing server block so a server_name on a plain :80 block is ignored.
    const lines = text.split(/\r?\n/);
    let inServer = false;
    let tls = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (/^server\s*\{/.test(line)) {
        inServer = true;
        tls = false;
        continue;
      }
      if (!inServer) continue;
      if (/listen\s+[^;]*\b443\b/.test(line) || /listen\s+[^;]*\bssl\b/.test(line)) tls = true;
      const match = /^server_name\s+([^;]+);/.exec(line);
      if (match && tls) {
        for (const name of match[1].split(/\s+/)) {
          const host = name.trim();
          if (!host || host === "_" || host.startsWith("*") || host.startsWith("~")) continue;
          candidates.push({ origin: `https://${host}`, source: `nginx server_name in ${file}` });
        }
      }
      if (line === "}") inServer = false;
    }
  }

  for (const file of caddyFiles) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/^\s*([a-z0-9.-]+\.[a-z]{2,})\s*\{/gim)) {
      candidates.push({ origin: `https://${match[1]}`, source: `Caddyfile site in ${file}` });
    }
  }
  return candidates;
}

function readServicePort(envValues) {
  const fromEnv = Number.parseInt(envValues.PORT, 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return 3030;
}

/** `/proc/<pid>/environ` is NUL-separated; read only the keys we own. */
function readProcessEnvironment(pid) {
  try {
    const raw = fs.readFileSync(path.join("/proc", String(pid), "environ"), "utf8");
    const out = {};
    for (const entry of raw.split("\0")) {
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq <= 0) continue;
      const key = entry.slice(0, eq);
      if (key === WEB_KEY || key === API_KEY || key === "NODE_ENV") out[key] = entry.slice(eq + 1);
    }
    return out;
  } catch {
    return null;
  }
}

function runSystemctl(args) {
  // Local to this module so tests can stub it; never used to print secrets.
  const { execFileSync } = require("node:child_process");
  try {
    return execFileSync("systemctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    return error.stdout ? String(error.stdout).trim() : null;
  }
}

/** Find the PID systemd reports for the service, so we can verify the real process env. */
function activeServicePid() {
  const raw = runSystemctl(["show", "-p", "MainPID", "--value", systemdEnvironment.UNIT_NAME]);
  const pid = Number.parseInt(raw || "", 10);
  return Number.isFinite(pid) && pid > 1 ? pid : null;
}

/** Restart counters and active state, used to detect a restart loop instead of claiming success. */
function serviceState() {
  const show = (property) => runSystemctl(["show", "-p", property, "--value", systemdEnvironment.UNIT_NAME]);
  const activeState = show("ActiveState");
  const subState = show("SubState");
  const nRestarts = Number.parseInt(show("NRestarts") || "", 10);
  return {
    activeState: activeState || "unknown",
    subState: subState || "unknown",
    restarts: Number.isFinite(nRestarts) ? nRestarts : null,
    pid: activeServicePid(),
  };
}

function promptForOrigin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(`\n${interactivePromptText()}\n`);
    const ask = () => {
      rl.question("> ", (answer) => {
        const trimmed = String(answer || "").trim();
        if (!trimmed) {
          process.stderr.write("\n[x] A value is required. PUBLIC_WEB_ORIGIN must be an HTTPS URL.\n");
          ask();
          return;
        }
        const result = validatePublicOrigin(trimmed);
        if (!result.ok) {
          process.stderr.write(`\n[x] That value is not usable: ${result.message}\n`);
          process.stderr.write("    It must be an https:// origin with a public hostname, no path, no query, no credentials.\n");
          ask();
          return;
        }
        rl.close();
        resolve(result.origin);
      });
    };
    ask();
  });
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[x] ${error.message}\n\n${usage()}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return EXIT_OK;
  }

  const appDir = path.resolve(options.appDir);
  const systemdRoot = path.resolve(options.systemdRoot);
  const envFile = path.join(appDir, ".env");

  // ---- gather facts -------------------------------------------------------
  const effective = systemdEnvironment.effectiveServiceEnvironment(systemdRoot);
  const envFileValues = systemdEnvironment.readEnvFileValues(envFile);
  const servicePort = readServicePort(envFileValues);

  const { singleOrigin, evidence: singleOriginEvidence } = await detectSingleOrigin(servicePort);

  const proxyCandidates = discoverFromReverseProxy(
    systemdRoot === path.parse(systemdRoot).root ? [systemdRoot] : [systemdRoot, REPO_ROOT]
  );

  const explicitWeb = options.webOrigin || process.env.GMWEB_PUBLIC_WEB_ORIGIN;
  // An explicit API origin from the CLI/environment beats the file, matching how the
  // application itself prefers process.env over any file-derived value.
  const apiOrigin =
    options.apiOrigin ||
    process.env.GMWEB_PUBLIC_API_ORIGIN ||
    process.env[API_KEY] ||
    effective.environment[API_KEY] ||
    envFileValues[API_KEY];

  const facts = {
    explicitWebOrigin: explicitWeb,
    effectiveWebOrigin: effective.environment[WEB_KEY],
    envFileWebOrigin: envFileValues[WEB_KEY],
    apiOrigin,
    proxyWebOrigin: proxyCandidates.length ? proxyCandidates[0].origin : undefined,
    singleOriginApp: singleOrigin,
    sources: {
      explicit: "GMWEB_PUBLIC_WEB_ORIGIN / --web-origin",
    },
  };

  let resolved = resolvePublicOrigin(facts);

  // ---- interactive fallback ----------------------------------------------
  const interactive =
    options.interactive === undefined
      ? Boolean(process.stdin.isTTY)
      : options.interactive;

  if (!resolved.ok) {
    if (!interactive) {
      const detail = resolved.invalid.length
        ? resolved.invalid.map((item) => `  - ${item.source}: ${item.message}`).join("\n")
        : "  - no configuration source provided a value";
      process.stderr.write(
        [
          "",
          "[x] Refusing to continue: PUBLIC_WEB_ORIGIN could not be established.",
          "",
          detail,
          "",
          "  ADR-007 requires an explicit HTTPS public web origin in production. Starting the",
          "  API without one produces a guaranteed restart loop, so nothing was restarted.",
          "",
          "  Resolve it with one of:",
          `    - set ${WEB_KEY} in ${envFile} (https:// origin, no trailing slash)`,
          "    - re-run this preflight interactively on a terminal",
          "    - pass --web-origin https://your.web.host",
          "",
        ].join("\n")
      );
      // A supplied-but-unusable value is a different failure from "nothing was found": the
      // caller must fix a value rather than supply one. The distinct code lets the
      // installers and the deploy script report the right next action.
      const suppliedButInvalid = resolved.invalid.some((item) => item.explicit) || resolved.invalid.length > 0;
      return suppliedButInvalid ? EXIT_INVALID : EXIT_UNRESOLVED;
    }
    const answered = await promptForOrigin();
    // Re-resolve with the administrator's value as the explicit source, so the rest of the
    // flow (persistence, propagation, verification) treats it exactly like a configured one.
    resolved = resolvePublicOrigin({ ...facts, explicitWebOrigin: answered });
  }

  if (!resolved.ok || !resolved.origin) {
    process.stderr.write(`[x] ${resolved.message || "unresolved"}\n`);
    return EXIT_UNRESOLVED;
  }

  // ---- validate before writing -------------------------------------------
  const finalCheck = validatePublicOrigin(resolved.origin);
  if (!finalCheck.ok) {
    process.stderr.write(`[x] Resolved value is invalid: ${finalCheck.message}\n`);
    return EXIT_INVALID;
  }
  const origin = finalCheck.origin;

  // A different host in PUBLIC_API_ORIGIN is not an error, but the two origins are bound
  // into the same pairing transcript, so it is worth stating plainly rather than letting an
  // operator discover it during Android enrollment.
  const apiValid = apiOrigin ? validatePublicOrigin(apiOrigin) : null;
  const hostNote = apiValid && apiValid.ok
    ? sameHost(apiValid.origin, origin)
      ? `web and API share the host ${new URL(origin).hostname}`
      : `web origin host ${new URL(origin).hostname} differs from API origin host ${new URL(apiValid.origin).hostname}; both are bound into pairing transcripts`
    : null;

  const changes = [];
  let propagationChanged = false;
  let propagationReason = null;

  // The application validates BOTH origins and refuses to start without either
  // (`pairingRoutes.js`: PUBLIC_WEB_ORIGIN and PUBLIC_API_ORIGIN must both be explicit HTTPS
  // origins in production). Fixing only the web origin would move the crash, not remove it,
  // so when this deployment is single-origin the API origin is derived from the web origin.
  // When it is NOT known to be single-origin, a missing API origin is reported rather than
  // invented, because the two are bound into the same pairing transcript.
  let apiForWrite = apiValid && apiValid.ok ? apiValid.origin : null;
  let apiDerivedFromWeb = false;
  if (!apiForWrite && singleOrigin) {
    apiForWrite = origin;
    apiDerivedFromWeb = true;
  }

  if (!options.checkOnly) {
    // ---- persist to the canonical file -----------------------------------
    const envWrite = systemdEnvironment.setEnvFileValue(envFile, WEB_KEY, origin);
    if (envWrite.changed) changes.push(`${WEB_KEY} written to ${envFile}`);

    if (apiForWrite && systemdEnvironment.readEnvFileValue(envFile, API_KEY) !== apiForWrite) {
      const apiWrite = systemdEnvironment.setEnvFileValue(envFile, API_KEY, apiForWrite);
      if (apiWrite.changed) {
        changes.push(
          `${API_KEY} written to ${envFile}` +
          (apiDerivedFromWeb ? " (same origin as the web app; the application requires it explicitly)" : "")
        );
      }
    }

    // ---- make systemd actually deliver it --------------------------------
    const ensured = systemdEnvironment.ensureServiceLoadsEnvironmentFile(systemdRoot, envFile);
    propagationChanged = ensured.daemonReloadRequired;
    propagationReason = ensured.reason;
    if (ensured.changed) {
      changes.push(`systemd drop-in ${ensured.dropin} (${ensured.reason})`);
    }
  }

  // Re-read systemd's view after the write: this is the value the process will really get.
  const after = systemdEnvironment.effectiveServiceEnvironment(systemdRoot);
  const propagatedValue = after.environment[WEB_KEY];
  const propagationOk = propagationValueOk(propagatedValue, origin);

  const processEnv = serviceState().pid ? readProcessEnvironment(serviceState().pid) : null;

  const result = {
    ok: true,
    origin,
    source: resolved.source,
    changed: changes.length > 0,
    changes,
    conflict: resolved.conflict,
    invalid: resolved.invalid,
    notes: [...resolved.notes, ...singleOriginEvidence, ...(hostNote ? [hostNote] : [])],
    env_file: envFile,
    env_file_value: systemdEnvironment.readEnvFileValue(envFile, WEB_KEY) || null,
    env_file_api_value: systemdEnvironment.readEnvFileValue(envFile, API_KEY) || null,
    api_origin: apiForWrite,
    api_origin_derived: apiDerivedFromWeb,
    systemd_effective_value: propagatedValue || null,
    systemd_propagation_ok: propagationOk,
    systemd_propagation_reason: propagationReason,
    systemd_will_reload: propagationChanged,
    single_origin_app: singleOrigin,
    service: serviceState(),
    running_process_web_origin: processEnv ? processEnv[WEB_KEY] || null : null,
    running_process_agrees: processEnv ? processEnv[WEB_KEY] === origin : null,
    check_only: options.checkOnly,
  };

  if (!propagationOk && !options.checkOnly) {
    result.ok = false;
    result.message =
      `systemd still does not expose ${WEB_KEY} to the service ` +
      `(service environment file: ${envFile}). The unit and its drop-ins must reference it ` +
      `before the service is restarted.`;
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const write = (line) => process.stderr.write(`${line}\n`);
    write("");
    write(`[*] PUBLIC_WEB_ORIGIN: ${origin}`);
    write(`    source:                 ${result.source}`);
    write(`    canonical env file:     ${envFile} => ${result.env_file_value || "<unset>"}`);
    if (result.api_origin) {
      write(`    PUBLIC_API_ORIGIN:      ${result.api_origin}${result.api_origin_derived ? " (same origin; required explicitly by ADR-007)" : ""}`);
    } else {
      write("    PUBLIC_API_ORIGIN:      <unset> -- the API REFUSES TO START without it; set it explicitly for this deployment");
    }
    write(`    systemd effective:      ${result.systemd_effective_value || "<not visible to the service>"}`);
    write(`    propagation:            ${propagationOk ? "OK (systemd will pass it to the process)" : "BROKEN"}`);
    if (result.running_process_web_origin) {
      write(`    running process agrees: ${result.running_process_agrees ? "yes" : "NO (restart required)"}`);
    }
    if (hostNote) write(`    note:                   ${hostNote}`);
    if (resolved.conflict) {
      write(`    conflict:               kept ${resolved.conflict.chosen}, rejected ${resolved.conflict.rejected} (${resolved.conflict.rejectedSource})`);
    }
    for (const item of resolved.invalid) {
      write(`    ignored:                ${item.source} -> ${item.message}`);
    }
    for (const note of result.notes) write(`    note:                   ${note}`);
    if (changes.length) {
      write("");
      for (const change of changes) write(`    changed: ${change}`);
    }
    if (result.systemd_will_reload) {
      write("");
      write("    systemd unit definitions changed: run `systemctl daemon-reload` before restarting");
      write("    (`systemctl restart` alone does NOT re-read unit files).");
    }
    write("");
  }

  if (!result.ok) {
    process.stderr.write(`[x] ${result.message}\n`);
    return EXIT_INVALID;
  }
  return EXIT_OK;
}

/**
 * Did systemd end up passing the intended value? Compared without ever printing the whole
 * environment, and tolerant of the trailing slash the app contract forbids.
 */
function propagationValueOk(propagated, expected) {
  if (!propagated) return false;
  const check = validatePublicOrigin(propagated);
  if (!check.ok) return false;
  return check.origin === expected;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[x] preflight failed unexpectedly: ${error.message}\n`);
      process.exitCode = EXIT_INVALID;
    });
}

module.exports = {
  main,
  parseArgs,
  detectSingleOrigin,
  discoverFromReverseProxy,
  propagationValueOk,
  readServicePort,
  EXIT_OK,
  EXIT_UNRESOLVED,
  EXIT_INVALID,
  EXIT_USAGE,
};
