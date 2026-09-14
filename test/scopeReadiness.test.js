"use strict";
// Project-key scope diagnostics + readiness agreement.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_KEY_SCOPES, DEFAULT_PROJECT_KEY_SCOPES, normalizeProjectKeyScopes, requiredProjectKeyScope } = require("../src/projectKeyScopes");
const { createTransportHealth, STATE, REASON } = require("../src/transportHealth");
const { AndroidOutbox } = require("../src/androidOutbox");

const SERVER = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
const NOW = Date.parse("2026-09-14T12:00:00Z");

test("case 30: a missing sms.invalidate scope is observable and performs nothing", () => {
  assert.equal(requiredProjectKeyScope("POST", "/send/invalidate"), "sms.invalidate");
  // The 403 carries the machine-readable requirement, so a consumer can tell
  // "your key lacks a capability" from "your key is wrong".
  const at = SERVER.indexOf("project_scope_denied");
  assert.ok(at !== -1, "the scope denial must exist");
  assert.ok(SERVER.slice(at - 200, at + 200).includes("requiredScope"), "403 must name the required scope");
  // ...and the route is unreachable for such a key: the check runs in the
  // global preHandler before any handler body.
  const hookAt = SERVER.indexOf("requiredProjectKeyScope(request.method, request.url)");
  const routeAt = SERVER.indexOf('app.post("/send/invalidate"');
  assert.ok(hookAt !== -1 && hookAt < routeAt, "the scope gate runs before the route");
});

test("case 31: SMS consumer defaults include lifecycle invalidation", () => {
  assert.ok(PROJECT_KEY_SCOPES.includes("sms.invalidate"));
  assert.ok(DEFAULT_PROJECT_KEY_SCOPES.includes("sms.invalidate"),
    "a key created without an explicit scope list can invalidate after a renewal");
});

test("case 32: an explicitly-scoped key is NEVER auto-expanded", () => {
  const chained = normalizeProjectKeyScopes(["sms.send", "sms.status", "sms.cancel", "sms.capacity"]);
  assert.equal(chained.includes("sms.invalidate"), false,
    "least privilege: adding a capability stays an explicit operator action");
  assert.deepEqual(chained, ["sms.send", "sms.status", "sms.cancel", "sms.capacity"]);
  assert.equal(normalizeProjectKeyScopes(["not.a.scope"]).length, 0);
});

test("case 32b: the operator diagnostic reports the gap without broadening anything", () => {
  assert.ok(SERVER.includes('app.get("/admin/project-key-diagnostics"'), "the diagnostic endpoint exists");
  const at = SERVER.indexOf('app.get("/admin/project-key-diagnostics"');
  const body = SERVER.slice(at, at + 3000);
  assert.ok(body.includes("missingInvalidationScope"));
  assert.ok(body.includes("can sms.send but lacks sms.invalidate"));
  assert.equal(/apiKeyStore\.(update|create)\b/.test(body), false, "the diagnostic must be read-only");
});

function androidPullHealth({ lastPullAgeMs, waitingPhones = 0, deviceKey = true }) {
  const outbox = new AndroidOutbox({ hooks: { now: () => NOW, livenessMs: 90000 } });
  if (lastPullAgeMs !== null) outbox.lastPullAt = NOW - lastPullAgeMs;
  return createTransportHealth({
    client: { name: "android", pullMode: true, outbox },
    chromeClient: { statusForDashboard: async () => ({ paired: false }) },
    androidClient: { configured: false, readyState: async () => ({ paired: false, reason: "not_configured" }) },
    deviceKeyStore: { configured: deviceKey },
    now: () => NOW,
    env: {}
  });
}

test("case 33: /ready and /admin/transport report the SAME truth when connected", async () => {
  const health = await androidPullHealth({ lastPullAgeMs: 5000 }).snapshot();
  assert.equal(health.ready, true);
  assert.equal(health.state, STATE.CONNECTED);
  // /ready answers from this object, so the two endpoints cannot disagree.
  assert.ok(SERVER.includes("const health = await transportHealth.snapshot();"));
  const readyAt = SERVER.indexOf('app.get("/ready"');
  assert.ok(SERVER.slice(readyAt, readyAt + 1500).includes("transportHealth.snapshot()"),
    "/ready must consume the canonical snapshot");
});

test("case 34: a stale phone is stale EVERYWHERE (never ready in one place only)", async () => {
  const health = await androidPullHealth({ lastPullAgeMs: 100000 }).snapshot();
  assert.equal(health.ready, false);
  assert.equal(health.state, STATE.STALE);
  assert.equal(health.reason, REASON.NO_RECENT_DEVICE_PULL);
  // /ready answers 503 from the same field.
  const readyAt = SERVER.indexOf('app.get("/ready"');
  const body = SERVER.slice(readyAt, readyAt + 1500);
  assert.ok(body.includes("if (!health.ready) reply.code(503)"));
});

test("case 35: the old PUSH client cannot make pull mode ready", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: () => NOW, livenessMs: 90000 } });
  const health = createTransportHealth({
    client: { name: "android", pullMode: true, outbox },
    chromeClient: { statusForDashboard: async () => ({ paired: true }) },
    // A perfectly reachable push client.
    androidClient: { configured: true, readyState: async () => ({ paired: true }) },
    deviceKeyStore: { configured: true },
    now: () => NOW,
    env: {}
  });
  const snapshot = await health.snapshot();
  assert.equal(snapshot.ready, false, "no pull, no waiter: pull mode is not ready");
  assert.equal(snapshot.state, STATE.STALE);
  assert.equal(snapshot.alternatives.androidPush.ready, true, "reported separately, never authoritative");
});

test("pull liveness is configurable and single-sourced", () => {
  const fast = new AndroidOutbox({ hooks: { now: () => NOW, livenessMs: 1000 } });
  assert.equal(fast.livenessMs, 1000);
  assert.equal((SERVER.match(/90000/g) || []).length, 1, "no liveness magic number re-declared in server.js");
});
