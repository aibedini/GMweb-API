"use strict";

/**
 * PUBLIC_WEB_ORIGIN deployment preflight.
 *
 * Regression coverage for the production incident: `gmweb-api.service` was written with only
 * `Environment= NODE_ENV=production` and no `EnvironmentFile`, the `.env` templates omitted
 * PUBLIC_WEB_ORIGIN / PUBLIC_API_ORIGIN entirely, and the activation paths restarted the API
 * without validating either. ADR-007 fails closed, so the service entered a restart loop.
 *
 * Every filesystem interaction runs against a temporary root, so no production server, real
 * systemd, or reverse proxy is required.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const PREFLIGHT = path.join(ROOT, "scripts", "publicOriginPreflight.js");
const {
  validatePublicOrigin,
  resolvePublicOrigin,
  apiOriginCanReplace,
} = require("../scripts/lib/publicOrigin.js");
const systemd = require("../scripts/lib/systemdEnvironment.js");

/** The unit file BOTH installers wrote in production, before this change. */
const LEGACY_UNIT = [
  "[Unit]",
  "Description=GMweb HTTP bridge",
  "After=network.target",
  "",
  "[Service]",
  "Type=simple",
  "User=gmweb",
  "WorkingDirectory=/opt/gmweb-api",
  "Environment=NODE_ENV=production",
  "Environment=TZ=Asia/Tehran",
  "ExecStart=/usr/bin/npm start",
  "Restart=always",
  "RestartSec=5",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

function makeWorld({ unit = LEGACY_UNIT, env = null, port = 3030 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-origin-"));
  const appDir = path.join(root, "opt", "gmweb-api");
  fs.mkdirSync(path.join(root, "etc", "systemd", "system"), { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(root, "etc", "systemd", "system", "gmweb-api.service"), unit);
  if (env !== null) fs.writeFileSync(path.join(appDir, ".env"), env);
  return { root, appDir, port };
}

function runPreflight(world, args = []) {
  const argv = [
    PREFLIGHT,
    "--app-dir", world.appDir,
    "--systemd-root", world.root,
    ...args,
  ];
  try {
    const stdout = execFileSync(process.execPath, argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(world.port) },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout || "", stderr: error.stderr || "" };
  }
}

function runPreflightJson(world, args = []) {
  const result = runPreflight(world, [...args, "--json"]);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { ...result, json: parsed };
}

/**
 * Run the preflight with stdin, keeping stdout and stderr separate. The interactive prompt
 * writes to stderr precisely so it cannot corrupt `--json` on stdout, and that separation is
 * part of what these tests check.
 */
function spawnPreflight(world, args, input) {
  const argv = [PREFLIGHT, "--app-dir", world.appDir, "--systemd-root", world.root, ...args];
  const result = require("node:child_process").spawnSync(process.execPath, argv, {
    encoding: "utf8",
    input,
    env: { ...process.env, PORT: String(world.port) },
  });
  return { code: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

const cleanup = (world) => fs.rmSync(world.root, { recursive: true, force: true });
const readEnv = (world) => systemd.readEnvFileValues(path.join(world.appDir, ".env"));
const dropin = (world) => systemd.dropinPath(world.root);

// ===========================================================================
// 1. A valid PUBLIC_WEB_ORIGIN already exists
// ===========================================================================
test("a valid PUBLIC_WEB_ORIGIN already present is accepted and left alone", () => {
  const world = makeWorld({
    env: "NODE_ENV=production\nAPI_TOKEN=tok\nPUBLIC_WEB_ORIGIN=https://chat.gmweb.net\nPUBLIC_API_ORIGIN=https://api.gmweb.net\n",
  });
  try {
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.origin, "https://chat.gmweb.net");
    assert.equal(result.json.env_file_value, "https://chat.gmweb.net");
    assert.equal(result.json.systemd_propagation_ok, true);
    // The existing valid value must not be rewritten.
    assert.equal(readEnv(world).PUBLIC_WEB_ORIGIN, "https://chat.gmweb.net");
    assert.equal(readEnv(world).PUBLIC_API_ORIGIN, "https://api.gmweb.net");
    assert.equal(result.json.api_origin_derived, false);
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 2. Value exists in .env but is NOT propagated into the systemd service
//     (the historical production state)
// ===========================================================================
test("a value in .env that systemd does not load is detected as BROKEN propagation and repaired", () => {
  const world = makeWorld({
    env: "NODE_ENV=production\nAPI_TOKEN=tok\nPUBLIC_WEB_ORIGIN=https://chat.gmweb.net\nPUBLIC_API_ORIGIN=https://chat.gmweb.net\n",
  });
  try {
    // Before: the unit has no EnvironmentFile, so the service cannot see the value.
    const before = systemd.effectiveServiceEnvironment(world.root);
    assert.equal(before.environment.PUBLIC_WEB_ORIGIN, undefined,
      "the legacy unit must NOT expose the value, which is the incident");

    const checkOnly = runPreflightJson(world, ["--non-interactive", "--check-only"]);
    assert.equal(checkOnly.code, 0, checkOnly.stderr);
    assert.equal(checkOnly.json.systemd_propagation_ok, false,
      "--check-only must report the propagation defect");
    assert.equal(fs.existsSync(dropin(world)), false, "--check-only must not write");

    const fixed = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(fixed.json.systemd_propagation_ok, true);
    assert.equal(fixed.json.systemd_will_reload, true,
      "installing a drop-in requires a daemon-reload");

    // After: systemd now delivers the value to the process.
    const after = systemd.effectiveServiceEnvironment(world.root);
    assert.equal(after.environment.PUBLIC_WEB_ORIGIN, "https://chat.gmweb.net");
    assert.match(fs.readFileSync(dropin(world), "utf8"), /EnvironmentFile=-.*\.env/);
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 3. Missing value can be discovered from authoritative configuration
// ===========================================================================
test("a missing origin is discovered from the authoritative public vhost", () => {
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=tok\n" });
  try {
    const nginxDir = path.join(world.root, "etc", "nginx", "sites-enabled");
    fs.mkdirSync(nginxDir, { recursive: true });
    fs.writeFileSync(path.join(nginxDir, "gmweb.conf"), [
      "server {",
      "  listen 80;",
      "  server_name plain.example.net;",
      "}",
      "server {",
      "  listen 443 ssl;",
      "  server_name gmweb.example.net;",
      "  location / { proxy_pass http://127.0.0.1:3030; }",
      "}",
      "",
    ].join("\n"));

    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.origin, "https://gmweb.example.net");
    assert.match(result.json.source, /reverse-proxy/);
    // Discovered values must be persisted so the next run is stable.
    assert.equal(readEnv(world).PUBLIC_WEB_ORIGIN, "https://gmweb.example.net");
  } finally {
    cleanup(world);
  }
});

test("a plain :80 vhost is not an acceptable HTTPS origin", () => {
  const world = makeWorld({ env: "NODE_ENV=production\n" });
  try {
    const nginxDir = path.join(world.root, "etc", "nginx", "sites-enabled");
    fs.mkdirSync(nginxDir, { recursive: true });
    fs.writeFileSync(path.join(nginxDir, "gmweb.conf"), "server {\n  listen 80;\n  server_name only-http.example.net;\n}\n");
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 1, "nothing discoverable and no explicit value must refuse");
    assert.equal(result.json, null);
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 4. PUBLIC_API_ORIGIN differs from PUBLIC_WEB_ORIGIN
// ===========================================================================
test("a differing PUBLIC_API_ORIGIN is preserved, not overwritten", () => {
  const world = makeWorld({
    env: "NODE_ENV=production\nPUBLIC_WEB_ORIGIN=https://web.gmweb.net\nPUBLIC_API_ORIGIN=https://api.gmweb.net\n",
  });
  try {
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.origin, "https://web.gmweb.net");
    assert.equal(result.json.api_origin, "https://api.gmweb.net");
    assert.equal(readEnv(world).PUBLIC_API_ORIGIN, "https://api.gmweb.net",
      "an explicit API origin on a different host must never be rewritten");
    assert.ok(result.json.notes.some((n) => /differ/i.test(n)),
      "the differing hosts must be stated, because both are bound into pairing transcripts");
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 5. Both origins equal, and the architecture confirms a shared origin
// ===========================================================================
test("a single-origin deployment derives PUBLIC_API_ORIGIN from the web origin", () => {
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=tok\n" });
  try {
    // Other config may already carry the web origin as the API origin for the same host.
    fs.writeFileSync(path.join(world.appDir, ".env"),
      "NODE_ENV=production\nPUBLIC_API_ORIGIN=https://chat.gmweb.net\n");
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.origin, "https://chat.gmweb.net");
    assert.equal(result.json.api_origin, "https://chat.gmweb.net");
    assert.match(result.json.source, /single-origin/);
    // Both keys must end up explicit: the application validates both and refuses to boot.
    assert.equal(readEnv(world).PUBLIC_WEB_ORIGIN, "https://chat.gmweb.net");
    assert.equal(readEnv(world).PUBLIC_API_ORIGIN, "https://chat.gmweb.net");
  } finally {
    cleanup(world);
  }
});

test("a derived API origin is written when only the web origin is given", () => {
  const world = makeWorld({ env: "NODE_ENV=production\n" });
  try {
    const result = runPreflightJson(world, ["--non-interactive", "--web-origin", "https://chat.gmweb.net"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.api_origin_derived, true);
    assert.equal(readEnv(world).PUBLIC_API_ORIGIN, "https://chat.gmweb.net",
      "PUBLIC_API_ORIGIN is fail-closed too, so fixing only the web origin would just move the crash");
  } finally {
    cleanup(world);
  }
});

test("the API origin is NOT reused when the deployment is not single-origin", () => {
  const result = resolvePublicOrigin({
    apiOrigin: "https://api.gmweb.net",
    singleOriginApp: false,
  });
  assert.equal(result.ok, false, "a non-single-origin deployment must not guess");
  assert.ok(result.notes.some((n) => /NOT reused/.test(n)));
});

// ===========================================================================
// 6. No origin can be discovered — interactive mode
// ===========================================================================
test("interactive fallback prompts, rejects bad input, and accepts a valid answer", () => {
  const world = makeWorld({ env: "NODE_ENV=production\n" });
  try {
    // Feed: empty, then a rejected scheme, then a path, then a good value. The prompt must
    // reject each bad one and allow a retry rather than giving up or looping forever.
    const input = "\nhttp://chat.gmweb.net\nhttps://chat.gmweb.net/app\nhttps://chat.gmweb.net\n";
    // The prompt is written to stderr so it never contaminates --json on stdout.
    const result = spawnPreflight(world, ["--interactive"], input);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /GMweb production configuration requires PUBLIC_WEB_ORIGIN\./);
    assert.match(result.stderr, /Could not safely determine the public HTTPS web origin\./);
    assert.match(result.stderr, /Enter the public web origin/);
    assert.match(result.stderr, /example: https:\/\/chat\.example\.com/);
    // Each rejection must explain itself, and the administrator must be able to retry.
    assert.match(result.stderr, /A value is required/);
    assert.match(result.stderr, /the scheme is "http"; production requires https/);
    assert.match(result.stderr, /must be an origin with no path/);
    assert.equal(readEnv(world).PUBLIC_WEB_ORIGIN, "https://chat.gmweb.net");
  } finally {
    cleanup(world);
  }
});

test("the interactive prompt never echoes or asks for secrets", () => {
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=super-secret-token-value\n" });
  try {
    const stdout = execFileSync(process.execPath, [
      PREFLIGHT, "--app-dir", world.appDir, "--systemd-root", world.root, "--interactive",
    ], {
      encoding: "utf8",
      input: "https://chat.gmweb.net\n",
      env: { ...process.env, PORT: String(world.port) },
    });
    assert.doesNotMatch(stdout, /super-secret-token-value/);
    assert.doesNotMatch(stdout, /password/i);
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 7. No origin can be discovered — non-interactive mode
// ===========================================================================
test("non-interactive mode fails with a nonzero status and never waits", () => {
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=tok\n" });
  try {
    const started = Date.now();
    const result = runPreflight(world, ["--non-interactive"]);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 1, "must exit 1 when nothing can be established");
    assert.ok(elapsed < 30000, `must not hang (took ${elapsed}ms)`);
    assert.match(result.stderr, /Refusing to continue/);
    assert.match(result.stderr, /nothing was restarted/);
    // It must not have invented a value.
    assert.equal(systemd.readEnvFileValue(path.join(world.appDir, ".env"), "PUBLIC_WEB_ORIGIN"), undefined);
    assert.equal(fs.existsSync(dropin(world)), false, "a failed preflight must not write a drop-in");
  } finally {
    cleanup(world);
  }
});

test("non-interactive mode with no .env at all still fails cleanly", () => {
  const world = makeWorld({ env: null });
  try {
    const result = runPreflight(world, ["--non-interactive"]);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /Refusing to continue/);
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 8. HTTP, localhost, malformed URLs and invalid hostnames are rejected
// ===========================================================================
test("invalid origins are rejected with a specific reason", () => {
  const rejected = [
    ["http://chat.gmweb.net", "not_https"],
    ["ftp://chat.gmweb.net", "not_https"],
    ["https://localhost", "localhost"],
    ["https://localhost:8443", "localhost"],
    ["https://127.0.0.1", "private_ip"],
    ["https://10.0.0.5", "private_ip"],
    ["https://192.168.1.10", "private_ip"],
    ["https://172.16.4.4", "private_ip"],
    ["https://169.254.1.1", "private_ip"],
    ["https://chat", "not_fully_qualified"],
    ["https://chat.internal", "reserved_hostname"],
    ["https://api.test", "reserved_hostname"],
    ["https://gmweb.invalid", "reserved_hostname"],
    ["https://box.local", "reserved_hostname"],
    ["https://svc.corp", "reserved_hostname"],
    ["https://chat.gmweb.net/app", "has_path"],
    ["https://chat.gmweb.net/?x=1", "has_query_or_fragment"],
    ["https://chat.gmweb.net#frag", "has_query_or_fragment"],
    ["https://user:pw@chat.gmweb.net", "has_credentials"],
    ["https://chat.gmweb.net:443:80", "malformed"],
    ["", "empty"],
    ["   ", "empty"],
    ["https://", "malformed"],
    ["chat.gmweb.net", "missing_scheme"],
    ["https://-bad.gmweb.net", "malformed_host"],
    ["https://bad-.gmweb.net", "malformed_host"],
    ["https://a..b.gmweb.net", "malformed_host"],
    ["https://exa mple.gmweb.net", "whitespace"],
    ["https://203.0.113.5", "private_ip"],
    ["https://[2001:db8::1]", "ip_literal"],
  ];
  for (const [value, reason] of rejected) {
    const result = validatePublicOrigin(value);
    assert.equal(result.ok, false, `${value} must be rejected`);
    assert.equal(result.reason, reason, `${value} -> expected ${reason}, got ${result.reason}`);
    assert.ok(result.message && result.message.length > 5, `${value} needs an actionable message`);
  }
});

test("valid origins are accepted and normalized consistently", () => {
  const accepted = [
    ["https://chat.gmweb.net", "https://chat.gmweb.net"],
    ["  https://chat.gmweb.net  ", "https://chat.gmweb.net"],
    // A single trailing slash is the one normalization the contract allows.
    ["https://chat.gmweb.net/", "https://chat.gmweb.net"],
    ["https://chat.gmweb.net:8443", "https://chat.gmweb.net:8443"],
    ["https://chat.gmweb.net:443", "https://chat.gmweb.net"],
    ["https://SUB.GMWEB.NET", "https://sub.gmweb.net"],
  ];
  for (const [input, expected] of accepted) {
    const result = validatePublicOrigin(input);
    assert.equal(result.ok, true, `${input} must be accepted: ${result.message || ""}`);
    assert.equal(result.origin, expected);
  }
});

test("rejected values never reach the environment file", () => {
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=tok\n" });
  try {
    for (const bad of ["http://chat.gmweb.net", "https://localhost", "https://chat.gmweb.net/x", "notaurl"]) {
      const result = runPreflight(world, ["--non-interactive", "--web-origin", bad]);
      assert.equal(result.code, 2, `${bad} should exit 2 (invalid), got ${result.code}`);
      assert.equal(systemd.readEnvFileValue(path.join(world.appDir, ".env"), "PUBLIC_WEB_ORIGIN"), undefined,
        `${bad} must not be written`);
    }
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 9. Conflicting configuration sources are handled safely
// ===========================================================================
test("an explicit valid origin wins and the rejected conflict is reported", () => {
  const result = resolvePublicOrigin({
    explicitWebOrigin: "https://explicit.gmweb.net",
    envFileWebOrigin: "https://file.gmweb.net",
    effectiveWebOrigin: "https://effective.gmweb.net",
  });
  assert.equal(result.ok, true);
  assert.equal(result.origin, "https://explicit.gmweb.net");
  assert.ok(result.conflict, "the conflict must be surfaced, not hidden");
  assert.equal(result.conflict.chosen, "https://explicit.gmweb.net");
  assert.equal(result.conflict.rejected, "https://file.gmweb.net");
});

test("the systemd effective value beats a file that says something else", () => {
  const result = resolvePublicOrigin({
    effectiveWebOrigin: "https://effective.gmweb.net",
    envFileWebOrigin: "https://file.gmweb.net",
  });
  assert.equal(result.origin, "https://effective.gmweb.net");
  assert.equal(result.propagation, true);
});

test("a same-host unusable web origin is corrected from the API origin, and the change is recorded", () => {
  const result = resolvePublicOrigin({
    envFileWebOrigin: "http://chat.gmweb.net",
    apiOrigin: "https://chat.gmweb.net",
    singleOriginApp: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.origin, "https://chat.gmweb.net");
  assert.ok(result.conflict, "the substitution must be visible");
  assert.equal(result.conflict.rejected, "http://chat.gmweb.net");
});

test("a different-host unusable web origin is NOT silently replaced", () => {
  const result = resolvePublicOrigin({
    envFileWebOrigin: "https://localhost",
    apiOrigin: "https://api.gmweb.net",
    singleOriginApp: true,
  });
  assert.equal(result.ok, false, "guessing here could point pairing at the wrong host");
  assert.ok(result.notes.some((n) => /NOT used to replace/.test(n)));
  assert.equal(apiOriginCanReplace({
    singleOriginApp: true,
    unusableWebOrigin: "https://localhost",
    apiOrigin: "https://api.gmweb.net",
  }), false);
});

test("an invalid value in .env is reported once, not once per source", () => {
  const result = resolvePublicOrigin({
    effectiveWebOrigin: "https://localhost",
    envFileWebOrigin: "https://localhost",
  });
  assert.equal(result.invalid.length, 1, "the same bad value must not be reported twice");
});

// ===========================================================================
// 10. Existing unrelated environment variables and systemd overrides are preserved
// ===========================================================================
test("unrelated env values, comments and operator drop-ins survive a run", () => {
  const world = makeWorld({
    env: [
      "NODE_ENV=production",
      "API_TOKEN=tok",
      "",
      "# an operator comment that must survive",
      "SEND_TIMEZONE=Asia/Tehran",
      "CORS_ORIGIN=https://other.example",
      "WEBHOOK_URL=",
      "",
    ].join("\n"),
  });
  try {
    const operatorDropin = path.join(systemd.dropinDir(world.root), "99-operator.conf");
    fs.mkdirSync(systemd.dropinDir(world.root), { recursive: true });
    fs.writeFileSync(operatorDropin, "[Service]\nMemoryMax=2G\nEnvironment=OPERATOR_SETTING=keep-me\n");
    const before = fs.readFileSync(operatorDropin, "utf8");
    const envBefore = fs.readFileSync(path.join(world.appDir, ".env"), "utf8");

    const result = runPreflightJson(world, ["--non-interactive", "--web-origin", "https://chat.gmweb.net"]);
    assert.equal(result.code, 0, result.stderr);

    const after = fs.readFileSync(path.join(world.appDir, ".env"), "utf8");
    assert.ok(after.includes("# an operator comment that must survive"), "comments preserved");
    assert.ok(after.includes("SEND_TIMEZONE=Asia/Tehran"), "unrelated value preserved");
    assert.ok(after.includes("CORS_ORIGIN=https://other.example"), "unrelated value preserved");
    assert.ok(after.includes("WEBHOOK_URL="), "an intentionally empty value is preserved");
    assert.ok(after.includes(`API_TOKEN=${readEnv(world).API_TOKEN}`), "the token line is untouched");
    assert.equal(fs.readFileSync(operatorDropin, "utf8"), before, "the operator drop-in is untouched");

    // The operator's override must still be part of the effective environment.
    const effective = systemd.effectiveServiceEnvironment(world.root);
    assert.equal(effective.environment.OPERATOR_SETTING, "keep-me");
    assert.equal(effective.environment.PUBLIC_WEB_ORIGIN, "https://chat.gmweb.net");
    assert.ok(envBefore.length > 0);
  } finally {
    cleanup(world);
  }
});

test("an existing valid value is not rewritten even when a drop-in is added", () => {
  const world = makeWorld({
    env: "PUBLIC_WEB_ORIGIN=https://chat.gmweb.net\nPUBLIC_API_ORIGIN=https://chat.gmweb.net\n",
  });
  try {
    const file = path.join(world.appDir, ".env");
    const before = fs.readFileSync(file, "utf8");
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(file, "utf8"), before, "a valid configuration must be byte-identical");
  } finally {
    cleanup(world);
  }
});

// ===========================================================================
// 11. Repeated runs do not duplicate entries or modify valid configuration
// ===========================================================================
test("repeated runs are idempotent", () => {
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=tok\n" });
  try {
    assert.equal(runPreflight(world, ["--non-interactive", "--web-origin", "https://chat.gmweb.net"]).code, 0);
    const envFile = path.join(world.appDir, ".env");
    const first = fs.readFileSync(envFile, "utf8");
    const firstDropin = fs.readFileSync(dropin(world), "utf8");

    for (let i = 0; i < 3; i += 1) {
      assert.equal(runPreflight(world, ["--non-interactive", "--web-origin", "https://chat.gmweb.net"]).code, 0);
    }
    assert.equal(fs.readFileSync(envFile, "utf8"), first, ".env must be unchanged");
    assert.equal(fs.readFileSync(dropin(world), "utf8"), firstDropin, "drop-in must be unchanged");
    assert.equal((first.match(/^PUBLIC_WEB_ORIGIN=/gm) || []).length, 1, "no duplicate keys");
    assert.equal((first.match(/^PUBLIC_API_ORIGIN=/gm) || []).length, 1, "no duplicate keys");
    assert.equal((firstDropin.match(/^EnvironmentFile=/gm) || []).length, 1, "no duplicate directives");

    // A duplicate key already in the file is collapsed to one, not appended to.
    fs.writeFileSync(envFile, `${first}PUBLIC_WEB_ORIGIN=https://duplicate.gmweb.net\n`);
    assert.equal(runPreflight(world, ["--non-interactive", "--web-origin", "https://chat.gmweb.net"]).code, 0);
    const collapsed = fs.readFileSync(envFile, "utf8");
    assert.equal((collapsed.match(/^PUBLIC_WEB_ORIGIN=/gm) || []).length, 1);
    assert.match(collapsed, /^PUBLIC_WEB_ORIGIN=https:\/\/chat\.gmweb\.net$/m);
  } finally {
    cleanup(world);
  }
});

test("setEnvFileValue replaces in place and preserves the file mode", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-env-"));
  try {
    const file = path.join(root, ".env");
    // Write then chmod explicitly: the process umask would otherwise strip bits from the
    // create mode, which says nothing about whether setEnvFileValue preserves the mode.
    fs.writeFileSync(file, "A=1\nPUBLIC_WEB_ORIGIN=  'https://old.gmweb.net'  \nB=2\n");
    fs.chmodSync(file, 0o600);
    const result = systemd.setEnvFileValue(file, "PUBLIC_WEB_ORIGIN", "https://new.gmweb.net");
    assert.equal(result.changed, true);
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /^PUBLIC_WEB_ORIGIN=https:\/\/new\.gmweb\.net$/m);
    assert.ok(text.includes("A=1") && text.includes("B=2"));
    assert.equal(text.split("\n").length, 4, "one line replaced in place, none added");
    // 0o600 matters: .env holds the API token. File modes are a POSIX concept and Node's
    // chmod is a no-op on Windows, so this half is only meaningful on a POSIX runner (CI is
    // Ubuntu). It is skipped rather than faked, so the assertion never claims coverage it
    // does not have.
    if (process.platform === "win32") {
      assert.ok(true, "file-mode preservation is verified on POSIX runners (CI: ubuntu-latest)");
    } else {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the file mode must be preserved");
    }
    assert.equal(systemd.setEnvFileValue(file, "PUBLIC_WEB_ORIGIN", "https://new.gmweb.net").changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// 12. Failed preflight prevents deployment activation and service restart
// ===========================================================================
test("quick-install validates BEFORE restarting the API and stops on failure", () => {
  const source = fs.readFileSync(path.join(ROOT, "install", "quick-install.sh"), "utf8");
  const startCore = source.slice(source.indexOf("start_core()"), source.indexOf("show_credentials()"));
  const preflightAt = startCore.indexOf("preflight_public_origin");
  const restartAt = startCore.indexOf("systemctl restart gmweb-api.service");
  assert.ok(preflightAt !== -1, "start_core must run the preflight");
  assert.ok(restartAt !== -1, "start_core must restart the API");
  assert.ok(preflightAt < restartAt, "the preflight MUST run before the API is restarted");
  assert.match(startCore, /preflight_public_origin \|\| return 1/,
    "a failed preflight must abort, not continue to the restart");
});

test("the update path validates BEFORE restarting and keeps the old version on failure", () => {
  const source = fs.readFileSync(path.join(ROOT, "install", "quick-install.sh"), "utf8");
  const update = source.slice(source.indexOf("update_app()"), source.indexOf("# ── 8. Uninstall"));
  const preflightAt = update.indexOf("preflight_public_origin");
  const restartAt = update.indexOf("systemctl restart gmweb-api");
  assert.ok(preflightAt !== -1 && restartAt !== -1);
  assert.ok(preflightAt < restartAt, "the update must validate before restarting");
  assert.match(update, /the API was NOT restarted/);
});

/** Actual `systemctl restart gmweb-api` INVOCATIONS, ignoring comments and echoed advice. */
function restartInvocations(source) {
  return source.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return false;
    // A diagnostic message that tells the operator to restart is not an activation path.
    if (/^echo\b/.test(trimmed) || /^printf\b/.test(trimmed)) return false;
    return /^systemctl\s+restart\s+gmweb-api/.test(trimmed);
  });
}

/**
 * The offset of the first actual preflight INVOCATION, ignoring comments and diagnostic lines
 * that merely mention the script path. Without this, a "run this to fix it" message appears to
 * be the preflight and the ordering assertion measures the wrong thing.
 */
function preflightInvocationAt(source) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    // Exclude the things that mention the script without running it: comments, the assignment
    // that defines its path, and the "run this to fix it" advice printed on failure. Anything
    // else that names it is an invocation, including `if ! node "$APP_DIR/scripts/..."`.
    if (t.startsWith("#")) continue;
    if (/^(echo|printf|warn|err)\b/.test(t)) continue;
    if (/^PREFLIGHT=/.test(t)) continue;
    if (t.includes("publicOriginPreflight.js") || /\$PREFLIGHT/.test(t)) {
      return lines.slice(0, i).join("\n").length;
    }
  }
  return -1;
}

test("ubuntu22 validates BEFORE restarting the API and never restarts it early", () => {
  const source = fs.readFileSync(path.join(ROOT, "install", "ubuntu22.sh"), "utf8");
  const preflightAt = preflightInvocationAt(source);
  assert.ok(preflightAt !== -1, "ubuntu22.sh must actually invoke the preflight");

  const restarts = restartInvocations(source);
  assert.equal(restarts.length, 1,
    `the API must be activated in exactly one place, after validation (found ${restarts.length})`);

  const restartAt = source.indexOf(restarts[0], preflightAt);
  assert.ok(restartAt > preflightAt, "the preflight MUST run before the API restart");
  assert.match(source, /Installation stopped BEFORE activating gmweb-api\.service/);
  assert.match(source, /systemctl daemon-reload\nsystemctl restart gmweb-api\.service/,
    "a drop-in requires daemon-reload before the restart");
});

test("deploy-gmweb.sh validates the origin instead of grepping .env", () => {
  const source = fs.readFileSync(path.join(ROOT, "deploy-gmweb.sh"), "utf8");
  // The old check was a bare grep. Comments may describe it; an executable line must not use it.
  const greps = source.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) return false;
    return /grep\s+-q\s+'?\^?PUBLIC_WEB_ORIGIN=/.test(trimmed);
  });
  assert.equal(greps.length, 0,
    `a grep for the key in .env proves nothing about what systemd passes to the process: ${greps.join(" | ")}`);

  const preflightAt = preflightInvocationAt(source);
  // NOTE: rollback() also restarts the service, and it is defined above the preflight. The
  // interesting restart is the ACTIVATION one, which must come after validation.
  const restartAt = source.indexOf("log \"Restarting the API\"");
  const promoteAt = source.indexOf("git merge --ff-only");
  assert.ok(preflightAt !== -1, "the deploy must invoke the preflight");
  assert.ok(restartAt !== -1, "the deploy must have an activation step");
  assert.ok(preflightAt < restartAt, "the preflight MUST run before the activation restart");
  assert.ok(preflightAt < promoteAt, "the preflight MUST run before anything is promoted");
});

test("both installer unit templates declare EnvironmentFile", () => {
  for (const installer of ["install/ubuntu22.sh", "install/quick-install.sh"]) {
    const source = fs.readFileSync(path.join(ROOT, installer), "utf8");
    assert.match(source, /EnvironmentFile=-\$APP_DIR\/\.env/,
      `${installer} must declare EnvironmentFile for the API unit`);
  }
});

test("both installer .env templates mention the required origins", () => {
  for (const installer of ["install/ubuntu22.sh", "install/quick-install.sh"]) {
    const source = fs.readFileSync(path.join(ROOT, installer), "utf8");
    assert.match(source, /^PUBLIC_WEB_ORIGIN=$/m, `${installer} must template PUBLIC_WEB_ORIGIN`);
    assert.match(source, /^PUBLIC_API_ORIGIN=$/m, `${installer} must template PUBLIC_API_ORIGIN`);
  }
});

// ===========================================================================
// 13. Successful deployment verifies service health
// ===========================================================================
test("deploy-gmweb.sh verifies active state, restart count and the process environment", () => {
  const source = fs.readFileSync(path.join(ROOT, "deploy-gmweb.sh"), "utf8");
  assert.match(source, /ActiveState/, "must check whether the unit is active");
  assert.match(source, /NRestarts/, "must detect a restart loop");
  assert.match(source, /journalctl -u gmweb-api\.service/, "must surface the journal on failure");
  assert.match(source, /\/proc\/\$MAIN_PID\/environ/, "must verify the RUNNING process, not just the file");
  assert.match(source, /PROCESS_ORIGIN/, "must compare the process value");
  assert.doesNotMatch(source, /echo[^\n]*\$PROCESS_ORIGIN/,
    "the process origin must never be echoed together with other environment content");
  assert.match(source, /api\/v1\/pairing\/session/, "must exercise the ADR-007 guarded route");
});

test("a restart-loop failure is reported as a failure, not as success", () => {
  const source = fs.readFileSync(path.join(ROOT, "deploy-gmweb.sh"), "utf8");
  assert.match(source, /RESTARTS_AFTER.*-gt.*RESTARTS_BEFORE/,
    "the restart delta must be compared");
  assert.match(source, /refusing to claim success/);
});

// ===========================================================================
// 14. Failed health verification triggers the supported rollback path
// ===========================================================================
test("post-activation failures roll back and pre-activation failures do not", () => {
  const source = fs.readFileSync(path.join(ROOT, "deploy-gmweb.sh"), "utf8");
  assert.match(source, /rollback\(\)/, "a rollback function must exist");
  assert.match(source, /git reset --hard "\$PREVIOUS_REVISION"/);
  assert.match(source, /ROLLBACK FAILED/, "a failed rollback must be reported, never swallowed");

  // PREVIOUS_REVISION is assigned only after the preflight, so an early failure cannot
  // attempt a rollback of something that was never promoted.
  const assignAt = source.indexOf('PREVIOUS_REVISION=$(git rev-parse HEAD)');
  const preflightAt = source.indexOf("publicOriginPreflight.js");
  assert.ok(assignAt > preflightAt, "PREVIOUS_REVISION must be captured after the preflight");

  // Every failure AFTER the promotion point must use rollback, not a bare exit. The pattern
  // is anchored so `curl --fail` is not mistaken for the `fail()` helper.
  const tail = source.slice(assignAt);
  const bareFails = (tail.match(/(?:^|[|;]\s*|\s)fail "/gm) || []).length;
  assert.equal(bareFails, 0,
    `no post-activation failure may bypass rollback; use rollback() instead of fail() (found ${bareFails})`);
  assert.ok((tail.match(/rollback "/g) || []).length >= 5,
    "the post-activation checks must all be wired to rollback");
});

// ===========================================================================
// Cross-cutting: the application contract this all serves
// ===========================================================================
test("config exposes the ADR-007 origins the call sites already read", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "config.js"), "utf8");
  assert.match(source, /publicWebOrigin:\s*process\.env\.PUBLIC_WEB_ORIGIN/);
  assert.match(source, /publicApiOrigin:\s*process\.env\.PUBLIC_API_ORIGIN/);
  assert.match(source, /dotenv\.config\(\{\s*path:\s*path\.join\(rootDir,\s*"\.env"\)/,
    "dotenv must not depend on the process working directory");
});

test("the discovery never claims to prove the application contract it depends on", () => {
  // ADR-007 binds BOTH origins into the pairing transcript, so the single-origin shortcut
  // must be a stated fact, never an assumption. Exercised end to end on a realistic
  // single-origin deployment: the API origin is present, no web origin is set anywhere, and
  // the correction is recorded in the notes rather than applied silently.
  const world = makeWorld({ env: "NODE_ENV=production\nAPI_TOKEN=tok\nPUBLIC_API_ORIGIN=https://chat.gmweb.net\n" });
  try {
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.origin, "https://chat.gmweb.net");
    assert.match(result.json.source, /single-origin/);
    assert.ok(result.json.notes.some((n) => /serves \/web, \/app and \/api\/v1 from one origin/.test(n)),
      "reusing the API origin must state why it is safe");
    assert.ok(result.json.single_origin_app === true,
      "the single-origin determination must be reported as evidence, not hidden");
  } finally {
    cleanup(world);
  }
});

test("a deployment whose public name is not the API host is not silently collapsed onto it", () => {
  // The web app is terminated on a different host from the API. There is no safe inference:
  // the preflight must stop rather than point pairing at the wrong origin.
  const world = makeWorld({
    env: "NODE_ENV=production\nPUBLIC_WEB_ORIGIN=https://localhost\nPUBLIC_API_ORIGIN=https://api.gmweb.net\n",
  });
  try {
    const result = runPreflightJson(world, ["--non-interactive"]);
    assert.equal(result.code, 2, `expected a refusal, got ${result.code}`);
    assert.equal(result.json, null, "nothing must be written");
    // The unusable value must be left exactly as the operator wrote it, for a human to fix.
    assert.equal(readEnv(world).PUBLIC_WEB_ORIGIN, "https://localhost");
    assert.equal(fs.existsSync(dropin(world)), false);
  } finally {
    cleanup(world);
  }
});
