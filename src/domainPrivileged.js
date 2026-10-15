"use strict";
/**
 * Client for the privileged domain helper (scripts/gmweb-domain-helper.sh).
 *
 * This process stays unprivileged. It can only ask `sudo -n` to run the three
 * allowlisted helper subcommands; the helper re-validates everything and the
 * sudoers rule names the exact subcommands. No shell is ever involved: argv is
 * passed as an array, the environment is minimal, and output is size-capped,
 * parsed as one JSON line and sanitised before it can reach an API response.
 */
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { normalizeHostname, serviceIds } = require("./domainStore");

const DEFAULT_HELPER = "/usr/local/sbin/gmweb-domain-helper";
const PROBE_TTL_MS = 60_000;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Stable helper error codes -> HTTP-ish classes for the routes. */
const CLIENT_ERRORS = new Set(["INVALID_HOSTNAME", "INVALID_SERVICE", "INVALID_EMAIL", "USAGE"]);
const CONFLICTS = new Set(["SERVER_NAME_IN_USE", "FOREIGN_FILE", "NOT_APPLIED", "BUSY"]);

function sanitise(text, max = 300) {
  return String(text ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\/(?:etc|var|root|home|usr|opt)\/\S*/g, "[path]")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

function createHelperClient(options = {}) {
  const {
    helperPath = process.env.DOMAIN_HELPER_PATH || DEFAULT_HELPER,
    sudoPath = "sudo",
    enabled = process.env.DOMAIN_APPLY_ENABLED !== "false",
    acmeEmail = process.env.DOMAIN_ACME_EMAIL || "",
    timeoutMs = 300_000,
    platform = process.platform,
    exec = execFile,
    exists = (p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } },
    now = Date.now,
  } = options;

  let chain = Promise.resolve();
  let probeCache = null;

  function runRaw(args, timeout) {
    return new Promise((resolve) => {
      exec(sudoPath, ["-n", ...args], {
        timeout, maxBuffer: 64 * 1024, windowsHide: true, shell: false,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      }, (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
    });
  }

  /** Is the helper installed AND permitted by sudoers? Cached briefly. */
  async function probe({ force = false } = {}) {
    if (!enabled) return { available: false, reason: "DISABLED" };
    if (platform !== "linux") return { available: false, reason: "UNSUPPORTED_PLATFORM" };
    if (!force && probeCache && now() - probeCache.at < PROBE_TTL_MS) return probeCache.value;
    let value;
    if (!exists(helperPath)) {
      value = { available: false, reason: "HELPER_NOT_INSTALLED" };
    } else {
      const { error } = await runRaw(["-l", helperPath, "apply", "probe.invalid", "main-web"], 10_000);
      value = error ? { available: false, reason: "SUDO_NOT_PERMITTED" } : { available: true, reason: null };
    }
    probeCache = { at: now(), value };
    return value;
  }

  /** Serialised, time-limited call. Resolves {ok, code, message, status}; never throws. */
  function run(action, args = []) {
    const job = chain.then(async () => {
      const state = await probe();
      if (!state.available) return { ok: false, code: "HELPER_UNAVAILABLE", message: describe(state.reason), status: 409 };
      const { error, stdout } = await runRaw([helperPath, action, ...args], timeoutMs);
      let parsed = null;
      try { parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() || ""); } catch { /* handled below */ }
      if (parsed && typeof parsed === "object" && typeof parsed.ok === "boolean") {
        if (parsed.ok && !error) return { ok: true, code: null, message: null, status: 200 };
        const code = /^[A-Z_]{3,40}$/.test(String(parsed.code)) ? parsed.code : "HELPER_FAILED";
        return { ok: false, code, message: sanitise(parsed.message),
          status: CLIENT_ERRORS.has(code) ? 400 : CONFLICTS.has(code) ? 409 : 502 };
      }
      if (error && error.killed) return { ok: false, code: "HELPER_TIMEOUT", message: "The helper timed out.", status: 504 };
      return { ok: false, code: "HELPER_FAILED", message: "The helper returned no usable result.", status: 502 };
    });
    chain = job.catch(() => {});
    return job;
  }

  function checkHost(hostname) {
    const result = normalizeHostname(hostname);
    return result.ok ? result.normalized : null;
  }

  return {
    probe,
    async capability() {
      const state = await probe();
      return {
        canVerifyDns: true,
        canVerifyRouting: true,
        canConfigureProxy: state.available,
        canIssueCertificate: state.available,
        canRenewCertificate: state.available,
        helper: state.reason,
        reason: state.available ? null : describe(state.reason),
      };
    },
    apply(hostname, serviceId) {
      const host = checkHost(hostname);
      if (!host || !serviceIds().includes(serviceId)) return Promise.resolve({ ok: false, code: "INVALID_INPUT", message: "Invalid hostname or service.", status: 400 });
      return run("apply", [host, serviceId]);
    },
    issue(hostname) {
      const host = checkHost(hostname);
      if (!host) return Promise.resolve({ ok: false, code: "INVALID_INPUT", message: "Invalid hostname.", status: 400 });
      const email = EMAIL.test(acmeEmail) ? [acmeEmail] : [];
      return run("issue", [host, ...email]);
    },
    remove(hostname) {
      const host = checkHost(hostname);
      if (!host) return Promise.resolve({ ok: false, code: "INVALID_INPUT", message: "Invalid hostname.", status: 400 });
      return run("remove", [host]);
    },
  };
}

function describe(reason) {
  switch (reason) {
    case "DISABLED": return "Applying domains is disabled (DOMAIN_APPLY_ENABLED=false).";
    case "UNSUPPORTED_PLATFORM": return "Applying domains is only supported on Linux hosts.";
    case "HELPER_NOT_INSTALLED": return "The privileged domain helper is not installed. Run scripts/install-domain-helper.sh as root.";
    case "SUDO_NOT_PERMITTED": return "The helper is installed but sudo does not allow this user to run it. Re-run scripts/install-domain-helper.sh.";
    default: return "The privileged domain helper is unavailable.";
  }
}

module.exports = { createHelperClient, sanitise, DEFAULT_HELPER };
