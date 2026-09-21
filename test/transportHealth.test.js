"use strict";
// Transport health: ONE authoritative snapshot for every endpoint.
//
// Regression suite for the production contradiction
//
//     Delivery:      Phone ready
//     Device bridge: No device
//
// which came from building "Delivery" out of the ACTIVE transport while
// building "Device bridge" out of the direct-PUSH android client. In pull mode
// the bridge is AndroidOutbox and the push client is not even part of the path.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { AndroidOutbox } = require("../src/androidOutbox");
const { createTransportHealth, STATE, REASON } = require("../src/transportHealth");

const NOW = Date.parse("2026-09-14T12:00:00Z");
const clock = () => NOW;

function makeClient({ transport = "android", pullMode = true, outbox = null } = {}) {
  return { name: transport, pullMode, outbox };
}

function androidClientStub({ configured = false, paired = false, reason = "not_configured" } = {}) {
  return { configured, readyState: async () => ({ paired, reason }) };
}

function chromeStub({ paired = false } = {}) {
  return { statusForDashboard: async () => ({ paired, transport: "chrome" }) };
}

function health(overrides = {}) {
  return createTransportHealth({
    client: overrides.client,
    chromeClient: overrides.chromeClient || chromeStub(),
    androidClient: overrides.androidClient || androidClientStub(),
    deviceKeyStore: { configured: overrides.deviceKeyConfigured !== false },
    gatewayTelemetry: overrides.gatewayTelemetry || null,
    now: overrides.now || clock,
    env: overrides.env || {}
  });
}

test("case 1: android+pull with a recent device pull is ready and CONNECTED", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: clock, livenessMs: 90000 } });
  outbox.lastPullAt = NOW - 5_000;                       // the phone polled 5s ago
  const snapshot = await health({ client: makeClient({ outbox }) }).snapshot();

  assert.equal(snapshot.activeTransport, "android");
  assert.equal(snapshot.mode, "pull");
  assert.equal(snapshot.configured, true);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.state, STATE.CONNECTED);
  assert.equal(snapshot.reason, null);
  assert.equal(snapshot.lastPullAgeMs, 5000);
  assert.equal(snapshot.livenessMs, 90000);
  // The bridge can never say "no device" while the snapshot says ready: the
  // dashboard derives BOTH cards from this one object.
  assert.equal(snapshot.ready, true);
});

test("case 2: an unconfigured/unreachable PUSH client cannot contaminate pull health", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: clock, livenessMs: 90000 } });
  outbox.lastPullAt = NOW - 1_000;
  const snapshot = await health({
    client: makeClient({ outbox }),
    // Exactly the production state: the direct-push client has no URL/key.
    androidClient: androidClientStub({ configured: false, paired: false, reason: "not_configured" })
  }).snapshot();

  assert.equal(snapshot.ready, true, "the pull bridge decides");
  assert.equal(snapshot.state, STATE.CONNECTED);
  // The push client is still reported — as a clearly separate diagnostic.
  assert.equal(snapshot.alternatives.androidPush.configured, false);
  assert.equal(snapshot.alternatives.androidPush.ready, false);
  assert.equal(snapshot.alternatives.androidPush.reason, REASON.ANDROID_GATEWAY_NOT_CONFIGURED);
});

test("case 3: pull older than the liveness window is STALE, not unconfigured", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: clock, livenessMs: 90000 } });
  outbox.lastPullAt = NOW - 100_000;                     // outside the window
  const snapshot = await health({ client: makeClient({ outbox }) }).snapshot();

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.state, STATE.STALE);
  assert.equal(snapshot.reason, REASON.NO_RECENT_DEVICE_PULL);
  assert.equal(snapshot.configured, true, "a configured device that went quiet is not 'unconfigured'");
  assert.equal(snapshot.lastPullAgeMs, 100000);
});
test("stale pull reports queue risk and keeps active polls distinct from devices", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: clock, livenessMs: 90000 } });
  outbox.lastPullAt = NOW - 100_000;
  const offered = outbox.offer("request-health", { to: "+10000000000", text: "synthetic" });
  const snapshot = await health({
    client: makeClient({ outbox }),
    gatewayTelemetry: { snapshot: () => ({ activeLongPolls: 0, distinctDevices: 2 }) }
  }).snapshot();
  assert.equal(snapshot.operationalReason, REASON.TASK_WAITING_NO_DEVICE);
  assert.equal(snapshot.activePolls, 0);
  assert.equal(snapshot.distinctDevices, 2);
  outbox.acknowledge("request-health", false, { outcome: "superseded" });
  await offered;
});

test("case 3b: no device key at all is UNCONFIGURED with its own reason", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: clock, livenessMs: 90000 } });
  const snapshot = await health({ client: makeClient({ outbox }), deviceKeyConfigured: false }).snapshot();

  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.state, STATE.UNCONFIGURED);
  assert.equal(snapshot.reason, REASON.DEVICE_KEY_NOT_CONFIGURED);
});

test("case 4: an open long-poll is liveness even with no prior pull timestamp", async () => {
  const outbox = new AndroidOutbox({ hooks: { now: clock, livenessMs: 90000 } });
  assert.equal(outbox.lastPullAt, 0, "precondition: never pulled");
  const pending = outbox.take(1000);                     // the phone is long-polling now
  const snapshot = await health({ client: makeClient({ outbox }) }).snapshot();

  assert.equal(snapshot.waitingPhones, 1);
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.state, STATE.CONNECTED);
  await pending;                                          // let the poll time out cleanly
});

test("case 5: android PUSH mode takes readiness from AndroidGatewayClient", async () => {
  const snapshot = await health({
    client: makeClient({ transport: "android", pullMode: false, outbox: null }),
    androidClient: androidClientStub({ configured: true, paired: true, reason: null })
  }).snapshot();

  assert.equal(snapshot.mode, "push");
  assert.equal(snapshot.ready, true);
  assert.equal(snapshot.state, STATE.CONNECTED);

  const down = await health({
    client: makeClient({ transport: "android", pullMode: false, outbox: null }),
    androidClient: androidClientStub({ configured: true, paired: false, reason: "unreachable" })
  }).snapshot();
  assert.equal(down.ready, false);
  assert.equal(down.state, STATE.PUSH_UNREACHABLE);
  assert.equal(down.reason, REASON.ANDROID_GATEWAY_UNREACHABLE);
});

test("case 6: the chrome transport still reports chrome status", async () => {
  const paired = await health({
    client: makeClient({ transport: "chrome", pullMode: true, outbox: new AndroidOutbox() }),
    chromeClient: chromeStub({ paired: true })
  }).snapshot();
  assert.equal(paired.activeTransport, "chrome");
  assert.equal(paired.mode, null);
  assert.equal(paired.ready, true);
  assert.equal(paired.state, STATE.CONNECTED);

  const unpaired = await health({
    client: makeClient({ transport: "chrome", pullMode: true, outbox: new AndroidOutbox() }),
    chromeClient: chromeStub({ paired: false })
  }).snapshot();
  assert.equal(unpaired.ready, false);
  assert.equal(unpaired.state, STATE.NOT_PAIRED);
  assert.equal(unpaired.reason, REASON.CHROME_NOT_PAIRED);
});

test("case 6b: a failing chrome probe is UNKNOWN, never a silent 'connected'", async () => {
  const snapshot = await health({
    client: makeClient({ transport: "chrome" }),
    chromeClient: { statusForDashboard: async () => { throw new Error("browser gone"); } }
  }).snapshot();
  assert.equal(snapshot.ready, false);
  assert.equal(snapshot.state, STATE.UNKNOWN);
  assert.equal(snapshot.reason, REASON.CHROME_PROBE_FAILED);
});

test("case 7: both admin endpoints build their transport view from THIS provider", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  const overviewStart = server.indexOf('app.get("/admin/overview"');
  const transportStart = server.indexOf('app.get("/admin/transport"');
  assert.ok(overviewStart !== -1 && transportStart > overviewStart, "both routes must exist");

  const overviewBody = server.slice(overviewStart, transportStart);
  assert.ok(overviewBody.includes("transportHealth.snapshot()"), "/admin/overview uses the snapshot");
  assert.ok(!overviewBody.includes("androidClient.readyState()"),
    "/admin/overview must NOT consult the push client directly");

  const transportBody = server.slice(transportStart, transportStart + 4000);
  assert.ok(transportBody.includes("transportHealth.snapshot()"), "/admin/transport uses the snapshot");
  assert.ok(transportBody.includes("transportHealth.android()"), "/admin/transport asks the provider for android health");
  assert.ok(!transportBody.includes("androidClient.readyState()"),
    "/admin/transport must NOT consult the push client directly");
});

test("the pull liveness threshold is configurable and owned by one place", () => {
  const fast = new AndroidOutbox({ hooks: { now: clock, livenessMs: 1000 } });
  assert.equal(fast.livenessMs, 1000);
  const fromEnv = new AndroidOutbox({ hooks: { now: clock }, livenessMs: undefined });
  assert.ok(fromEnv.livenessMs > 0);

  const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.js"), "utf8");
  // The old rule lived in server.js as `(now - lastPullAt) < 90000`. The only
  // 90_000 that may remain there is the unrelated /send?wait=true timeout.
  assert.equal((server.match(/90000/g) || []).length, 1, "no liveness magic number in server.js");
  assert.ok(server.includes("waitForJob(job, 90000)"), "the remaining one is the wait=true timeout");
  assert.ok(!server.includes("lastPullAt) < 90000"), "the old inline liveness rule is gone");
  const outbox = fs.readFileSync(path.join(__dirname, "..", "src", "androidOutbox.js"), "utf8");
  assert.ok(outbox.includes("ANDROID_PULL_LIVENESS_MS"), "the threshold is env-configurable");
});
