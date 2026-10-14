"use strict";
// Environment-contract preflight.
//
// REGRESSION TEST for the 2026-10-14 incident: the updater promoted a release
// whose startup guard requires an explicit HTTPS PUBLIC_WEB_ORIGIN, the server's
// .env did not satisfy it, and the API crash-looped 2581 times. Every later
// update then failed at the QUEUE gate, blaming the queue for a service-start
// problem. The candidate must now be rejected BEFORE any restart.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const { parseEnvFile, checkEnvironment } = require("../scripts/preflight-env.js");
const SCRIPT = path.join(__dirname, "..", "scripts", "preflight-env.js");

const BASE = { NODE_ENV: "production", API_TOKEN: "x".repeat(43),
  PUBLIC_WEB_ORIGIN: "https://gmweb.example.nip.io", PUBLIC_API_ORIGIN: "https://gmweb.example.nip.io" };

test("a production env with explicit HTTPS origins passes", () => {
  assert.deepEqual(checkEnvironment(BASE), []);
});

test("the exact incident configuration is rejected", () => {
  // Missing PUBLIC_WEB_ORIGIN while NODE_ENV=production (from systemd) — this is
  // what produced "refusing to start".
  const problems = checkEnvironment({ NODE_ENV: "production", API_TOKEN: "x" });
  assert.equal(problems.length >= 1, true);
  assert.match(problems.join(" "), /PUBLIC_WEB_ORIGIN is not set/);
  assert.match(problems.join(" "), /ADR-007/);
});

test("a non-HTTPS origin is rejected in production", () => {
  const problems = checkEnvironment({ ...BASE, PUBLIC_WEB_ORIGIN: "http://gmweb.example" });
  assert.match(problems.join(" "), /not an HTTPS URL/);
});

test("an origin with a path is rejected", () => {
  const problems = checkEnvironment({ ...BASE, PUBLIC_WEB_ORIGIN: "https://gmweb.example/web" });
  assert.match(problems.join(" "), /ORIGIN only/);
});

test("NODE_ENV=production governs even when the origins are fine", () => {
  // Development is not held to the HTTPS contract, so a dev box is not blocked.
  assert.deepEqual(checkEnvironment({ NODE_ENV: "development", API_TOKEN: "x" }), []);
});

test("a missing API_TOKEN is rejected — the updater could not health-check", () => {
  const problems = checkEnvironment({ ...BASE, API_TOKEN: "" });
  assert.match(problems.join(" "), /API_TOKEN is not set/);
});

test("checkEnvironment never includes a secret value in its output", () => {
  const secret = "SUPER-SECRET-TOKEN-VALUE";
  const text = checkEnvironment({ ...BASE, API_TOKEN: secret,
    PUBLIC_WEB_ORIGIN: "http://x" }).join(" ");
  assert.equal(text.includes(secret), false, "a problem message must never echo the token");
});

test("parseEnvFile reads keys, ignores comments, and strips quotes", () => {
  const parsed = parseEnvFile([
    "# comment", "", "A=1", 'B="two"', "C='three'", "D=a=b", "  E = 5  ", "malformed",
  ].join("\n"));
  assert.equal(parsed.A, "1");
  assert.equal(parsed.B, "two");
  assert.equal(parsed.C, "three");
  assert.equal(parsed.D, "a=b", "only the first = splits");
  assert.equal(parsed.E, "5");
  assert.equal("malformed" in parsed, false);
});

test("the CLI exits non-zero on an incompatible environment and touches nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-preflight-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "NODE_ENV=production\nAPI_TOKEN=abc\n");
  let code = 0;
  let stderr = "";
  try {
    execFileSync("node", [SCRIPT, "--app-dir", dir, "--env-file", envFile, "--service", "no-such.service"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    code = error.status;
    stderr = String(error.stderr || "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 1, "must fail closed");
  assert.match(stderr, /PUBLIC_WEB_ORIGIN/);
  assert.match(stderr, /live service was NOT touched/i);
  assert.equal(stderr.includes("abc"), false, "the token value must not be printed");
});

test("the CLI exits zero for a compatible environment", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-preflight-ok-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, `NODE_ENV=production\nAPI_TOKEN=${"x".repeat(43)}\n`
    + "PUBLIC_WEB_ORIGIN=https://a.example\nPUBLIC_API_ORIGIN=https://a.example\n");
  let code = 0;
  try {
    execFileSync("node", [SCRIPT, "--app-dir", dir, "--env-file", envFile, "--service", "no-such.service"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) { code = error.status; } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(code, 0);
});

test("the updater actually invokes the preflight before promotion", () => {
  // Static wiring assertion: the gate must exist in the fast path, so a future
  // refactor cannot silently drop it.
  const menu = fs.readFileSync(path.join(__dirname, "..", "scripts", "gmweb-menu.sh"), "utf8");
  assert.match(menu, /preflight-env\.js.*--app-dir/s, "preflight must be invoked");
  assert.match(menu, /Candidate is not compatible with the current environment/);
});

test("the updater classifies queue failures instead of blaming the queue", () => {
  const menu = fs.readFileSync(path.join(__dirname, "..", "scripts", "gmweb-menu.sh"), "utf8");
  assert.match(menu, /queue_snapshot_diagnosis\(\)/);
  assert.match(menu, /API_UNREACHABLE/);
  assert.match(menu, /This is a SERVICE problem, not a queue problem\./);
  // The `waiting` count must have its own branch, not fall through to `active`.
  assert.match(menu, /process\.argv\[1\] === "waiting"/);
});

test("the API token is never echoed to the terminal", () => {
  const menu = fs.readFileSync(path.join(__dirname, "..", "scripts", "gmweb-menu.sh"), "utf8");
  assert.equal(/echo "API token: \$new_token"/.test(menu), false,
    "rotate_api_token must not print the token");
  assert.match(menu, /deliberately NOT echoed/);
});
