"use strict";
// Live Android runtime metadata.
//
// Production bug this fixes: the Android app version was learned ONLY from
// device_telemetry_history, so when telemetry stalled GMweb kept reporting
// 3.4.17 from Sep 30 while the running APK was newer. Runtime metadata now
// comes from the authenticated command poll the phone already performs.
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const Fastify = require("fastify");
const { AgentRuntimeStore, normalizeAgentRuntime, RUNTIME_WRITE_INTERVAL_MS, MAX_COMMAND_TYPES } =
  require("../src/agentRuntime");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const { DeviceTelemetryStore } = require("../src/deviceTelemetry");
const { AgentActivityStore, derivePhonePresence, deriveTelemetryFreshness } = require("../src/agentActivity");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { TrustRegistry } = require("../src/trustRegistry");

const NOW = 1_800_000_000_000;
const DEVICE = "8238ea53dd4bb0f0";
const newDb = () => new Database(":memory:");

const RUNTIME = {
  protocolVersion: 1, appVersionName: "3.4.22", appVersionCode: 129,
  commandTypes: ["SEND_SMS", "MARK_THREAD_READ", "REFRESH_DEVICE_TELEMETRY"],
};

// ------------------------------------------------------------- validation

test("runtime validation is bounded and drops junk", () => {
  assert.equal(normalizeAgentRuntime(null), null);
  assert.equal(normalizeAgentRuntime("nope"), null);
  assert.equal(normalizeAgentRuntime({}), null, "nothing usable creates no row");
  assert.equal(normalizeAgentRuntime({ appVersionName: "   " }), null);

  const bounded = normalizeAgentRuntime({
    appVersionName: "x".repeat(500), appVersionCode: -1, protocolVersion: 99_999,
    commandTypes: ["A", "A", 7, "", "y".repeat(500), ...Array.from({ length: 80 }, (_, i) => `C${i}`)],
  });
  assert.equal(bounded.appVersionName.length, 64, "version name is capped");
  assert.equal(bounded.appVersionCode, null, "negative version code rejected");
  assert.equal(bounded.protocolVersion, null, "unbounded protocol rejected");
  assert.equal(bounded.commandTypes.includes("A"), true);
  assert.equal(bounded.commandTypes.filter((t) => t === "A").length, 1, "de-duplicated");
  assert.equal(bounded.commandTypes.length <= MAX_COMMAND_TYPES, true);
  assert.equal(bounded.commandTypes.includes("y".repeat(500)), false);

  // Absent commandTypes stays [] — distinct from "no runtime reported at all".
  assert.deepEqual(normalizeAgentRuntime({ appVersionName: "1.0" }).commandTypes, []);
});

// ------------------------------------------------------------- store

test("runtime is persisted, survives restart, and reports server receipt time", () => {
  const db = newDb();
  const store = new AgentRuntimeStore(db);
  assert.equal(store.get(DEVICE), null);

  assert.equal(store.record(DEVICE, RUNTIME, "COMMAND_POLL", NOW), true, "first write persists");
  const stored = store.get(DEVICE);
  assert.equal(stored.appVersionName, "3.4.22");
  assert.equal(stored.appVersionCode, 129);
  assert.equal(stored.receivedAt, NOW, "server receipt time");
  assert.equal(stored.source, "COMMAND_POLL");
  assert.deepEqual(stored.commandTypes, RUNTIME.commandTypes);

  // A fresh instance (process restart) sees the durable row.
  const reopened = new AgentRuntimeStore(db);
  assert.equal(reopened.get(DEVICE).appVersionName, "3.4.22");
  assert.deepEqual(reopened.get(DEVICE).commandTypes, RUNTIME.commandTypes);
  db.close();
});

test("unchanged polls are coalesced but a metadata change persists immediately", () => {
  const db = newDb();
  const store = new AgentRuntimeStore(db);
  store.record(DEVICE, RUNTIME, "COMMAND_POLL", NOW);

  // Same metadata inside the throttle window: exact in memory, no write.
  assert.equal(store.record(DEVICE, RUNTIME, "COMMAND_POLL", NOW + 1_000), false);
  assert.equal(store.get(DEVICE).receivedAt, NOW + 1_000, "in-memory view stays exact");
  assert.equal(db.prepare("SELECT last_runtime_at FROM agent_runtime").get().last_runtime_at, NOW);

  // A real change persists IMMEDIATELY, even inside the window.
  assert.equal(store.record(DEVICE, { ...RUNTIME, appVersionName: "3.4.23" }, "COMMAND_POLL", NOW + 2_000), true);
  assert.equal(store.get(DEVICE).appVersionName, "3.4.23");
  assert.equal(db.prepare("SELECT app_version_name FROM agent_runtime").get().app_version_name, "3.4.23");

  // Unchanged again, past the window: persisted.
  assert.equal(store.record(DEVICE, { ...RUNTIME, appVersionName: "3.4.23" }, "COMMAND_POLL",
    NOW + 2_000 + RUNTIME_WRITE_INTERVAL_MS + 1), true);
  db.close();
});

test("a malformed or absent runtime never creates or corrupts a row", () => {
  const db = newDb();
  const store = new AgentRuntimeStore(db);
  assert.equal(store.record(DEVICE, {}, "COMMAND_POLL", NOW), false);
  assert.equal(store.record(DEVICE, undefined, "COMMAND_POLL", NOW), false);
  assert.equal(store.record(null, RUNTIME, "COMMAND_POLL", NOW), false, "no device id");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_runtime").get().n, 0);

  store.record(DEVICE, RUNTIME, "COMMAND_POLL", NOW);
  assert.equal(store.record(DEVICE, "garbage", "COMMAND_POLL", NOW + 1), false);
  assert.equal(store.get(DEVICE).appVersionName, "3.4.22", "existing row untouched");
  db.close();
});

test("supports() is a fresh, live-only answer", () => {
  const db = newDb();
  const store = new AgentRuntimeStore(db);
  store.record(DEVICE, RUNTIME, "COMMAND_POLL", NOW);
  assert.equal(store.supports(DEVICE, "REFRESH_DEVICE_TELEMETRY", NOW), true);
  assert.equal(store.supports(DEVICE, "SOMETHING_ELSE", NOW), false);
  // A stale runtime snapshot must not authorise a command the phone may no
  // longer support.
  assert.equal(store.supports(DEVICE, "REFRESH_DEVICE_TELEMETRY", NOW + 10 * 60_000), false);
  assert.equal(store.supports("unknown", "REFRESH_DEVICE_TELEMETRY", NOW), false);
  db.close();
});

// ------------------------------------------------------------- claim route

function claimHarness() {
  const db = newDb();
  const store = new AgentRuntimeStore(db);
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => {
    // Emulates the global /api/v1/agent/* AgentAuth gate.
    if (request.headers["x-test-agent"]) request.authenticatedAgentId = String(request.headers["x-test-agent"]);
    done();
  });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db), commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db), accountId: "a", linkedSessions: require("../src/linkedSessions"),
    authorizeAgent: (request) => request.authenticatedAgentId
      ? { deviceId: request.authenticatedAgentId, role: "PRIMARY_TRUST_AGENT" } : null,
    agentRuntimeStore: store,
  });
  return { app, db, store };
}

test("an authenticated claim records live runtime metadata", async (t) => {
  const { app, db, store } = claimHarness();
  t.after(async () => { await app.close(); db.close(); });
  const res = await app.inject({ method: "POST", url: "/api/v1/agent/commands/claim",
    headers: { "x-test-agent": DEVICE }, payload: { agentId: DEVICE, limit: 25, runtime: RUNTIME } });
  assert.equal(res.statusCode, 200, res.payload);
  const stored = store.get(DEVICE);
  assert.equal(stored.appVersionName, "3.4.22");
  assert.equal(stored.appVersionCode, 129);
  assert.deepEqual(stored.commandTypes, RUNTIME.commandTypes);
});

test("an UNAUTHENTICATED claim cannot write runtime metadata", async (t) => {
  const { app, db, store } = claimHarness();
  t.after(async () => { await app.close(); db.close(); });
  const res = await app.inject({ method: "POST", url: "/api/v1/agent/commands/claim",
    payload: { agentId: DEVICE, runtime: RUNTIME } });
  assert.equal(res.statusCode, 200);
  assert.equal(store.get(DEVICE), null, "unauthenticated runtime is never trusted");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_runtime").get().n, 0);
});

test("runtime is keyed by the AUTHENTICATED device, not the body's claim", async (t) => {
  const { app, db, store } = claimHarness();
  t.after(async () => { await app.close(); db.close(); });
  await app.inject({ method: "POST", url: "/api/v1/agent/commands/claim",
    headers: { "x-test-agent": DEVICE }, payload: { agentId: "some-other-phone", runtime: RUNTIME } });
  assert.equal(store.get(DEVICE).appVersionName, "3.4.22");
  assert.equal(store.get("some-other-phone"), null, "cannot spoof another device's runtime");
});

test("an older client that omits runtime still claims normally", async (t) => {
  const { app, db, store } = claimHarness();
  t.after(async () => { await app.close(); db.close(); });
  const res = await app.inject({ method: "POST", url: "/api/v1/agent/commands/claim",
    headers: { "x-test-agent": DEVICE }, payload: { agentId: DEVICE, limit: 25 } });
  assert.equal(res.statusCode, 200, res.payload);
  assert.deepEqual(res.json().commands, []);
  assert.equal(store.get(DEVICE), null);
});

// ------------------------------------------------------------- status route

test("status reports runtime separately and never presents telemetry as current", async (t) => {
  const db = newDb();
  const runtimeStore = new AgentRuntimeStore(db);
  const telemetryStore = new DeviceTelemetryStore(db);
  const activityStore = new AgentActivityStore(db);

  // Stale telemetry from the OLD app, live runtime from the NEW one.
  const receivedAt = Date.now() - 3 * 86_400_000;
  db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DEVICE, receivedAt, "PRIMARY_TRUST_AGENT",
      JSON.stringify({ deviceId: DEVICE, timestamp: receivedAt, app: { versionName: "3.4.17" } }), receivedAt);
  runtimeStore.record(DEVICE, RUNTIME, "COMMAND_POLL");
  activityStore.record(DEVICE, "COMMAND_POLL");

  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => { request.linkedDevice = { deviceId: "browser" }; done(); });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db), commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db), accountId: "a", authorizeAgent: () => null,
    linkedSessions: require("../src/linkedSessions"),
    deviceTelemetryStore: telemetryStore, agentActivityStore: activityStore, agentRuntimeStore: runtimeStore,
    derivePhonePresence, deriveTelemetryFreshness,
    agentAuthService: { getPrimaryIdentity: () => ({ device_id: DEVICE }) },
  });
  t.after(async () => { await app.close(); db.close(); });

  const body = (await app.inject({ url: "/api/v1/linked-device/status" })).json();
  assert.equal(body.phone.state, "ONLINE");
  assert.equal(body.telemetry.state, "OLD");
  assert.equal(body.runtime.appVersionName, "3.4.22", "live running version");
  assert.deepEqual(body.runtime.commandTypes, RUNTIME.commandTypes);
  assert.equal(body.telemetry.reportedAppVersion, "3.4.17", "historical value is labelled");
  // The deprecated derived field prefers runtime and says which it used.
  assert.equal(body.phone.appVersion, "3.4.22");
  assert.equal(body.phone.appVersionSource, "RUNTIME");
  assert.equal(body.phone.appVersionIsFallback, false);
});

test("status falls back to telemetry for appVersion and flags it as a fallback", async (t) => {
  const db = newDb();
  const telemetryStore = new DeviceTelemetryStore(db);
  const activityStore = new AgentActivityStore(db);
  const receivedAt = Date.now() - 3 * 86_400_000;
  db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DEVICE, receivedAt, "PRIMARY_TRUST_AGENT",
      JSON.stringify({ deviceId: DEVICE, timestamp: receivedAt, app: { versionName: "3.4.17" } }), receivedAt);
  activityStore.record(DEVICE, "COMMAND_POLL");

  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => { request.linkedDevice = { deviceId: "browser" }; done(); });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db), commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db), accountId: "a", authorizeAgent: () => null,
    linkedSessions: require("../src/linkedSessions"),
    deviceTelemetryStore: telemetryStore, agentActivityStore: activityStore,
    agentRuntimeStore: new AgentRuntimeStore(db),
    derivePhonePresence, deriveTelemetryFreshness,
    agentAuthService: { getPrimaryIdentity: () => ({ device_id: DEVICE }) },
  });
  t.after(async () => { await app.close(); db.close(); });

  const body = (await app.inject({ url: "/api/v1/linked-device/status" })).json();
  assert.equal(body.runtime.appVersionName, null, "no live runtime yet");
  assert.deepEqual(body.runtime.commandTypes, []);
  assert.equal(body.phone.appVersion, "3.4.17");
  assert.equal(body.phone.appVersionSource, "TELEMETRY_FALLBACK");
  assert.equal(body.phone.appVersionIsFallback, true, "UI can mark it STALE SOURCE");
});
