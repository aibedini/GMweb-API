"use strict";
// REFRESH_DEVICE_TELEMETRY rides the EXISTING durable encrypted command channel.
// No parallel transport, no plaintext downgrade, no duplicate on replay.
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const Fastify = require("fastify");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { TrustRegistry } = require("../src/trustRegistry");

function harness({ capabilities = ["READ_MESSAGES"] } = {}) {
  const db = new Database(":memory:");
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.headers["x-test-linked"]) request.linkedDevice = { deviceId: "browser", capabilities };
    done();
  });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db), commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db), accountId: "a",
    authorizeAgent: () => null, linkedSessions: require("../src/linkedSessions"),
  });
  return { app, db };
}

const envelope = (overrides = {}) => ({
  type: "REFRESH_DEVICE_TELEMETRY",
  payload: Buffer.from("opaque-encrypted-envelope").toString("base64"),
  idempotencyKey: `refresh-${Math.random().toString(36).slice(2)}`,
  targetAgentId: "phone", cryptoVersion: 1, encoding: "envelope.v1", schemaVersion: 1,
  ...overrides,
});

// Case 5
test("a linked browser cannot submit REFRESH_DEVICE_TELEMETRY as plaintext", async t => {
  const { app, db } = harness();
  t.after(async () => { await app.close(); db.close(); });
  for (const downgrade of [
    { cryptoVersion: 0 }, { cryptoVersion: 2 },
    { encoding: "plaintext" }, { schemaVersion: 0 },
  ]) {
    const res = await app.inject({ method: "POST", url: "/api/v1/commands",
      headers: { "x-test-linked": "1" }, payload: envelope(downgrade) });
    assert.equal(res.statusCode, 400, JSON.stringify(downgrade));
    assert.equal(res.json().error, "encrypted_command_required");
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commands").get().n, 0, "nothing was persisted");
});

// Case 6
test("an encrypted REFRESH_DEVICE_TELEMETRY is accepted and durable", async t => {
  const { app, db } = harness();
  t.after(async () => { await app.close(); db.close(); });
  const body = envelope();
  const res = await app.inject({ method: "POST", url: "/api/v1/commands",
    headers: { "x-test-linked": "1" }, payload: body });
  assert.equal(res.statusCode, 202, res.payload);
  const row = db.prepare("SELECT type, state, target_agent_id, crypto_version, encoding FROM commands").get();
  assert.equal(row.type, "REFRESH_DEVICE_TELEMETRY");
  assert.equal(row.target_agent_id, "phone");
  assert.equal(row.crypto_version, 1);
  assert.equal(row.encoding, "envelope.v1");
});

// Case 7
test("replaying the same idempotency key yields the same command, not a duplicate", async t => {
  const { app, db } = harness();
  t.after(async () => { await app.close(); db.close(); });
  const body = envelope({ idempotencyKey: "stable-refresh-key" });
  const first = await app.inject({ method: "POST", url: "/api/v1/commands",
    headers: { "x-test-linked": "1" }, payload: body });
  const second = await app.inject({ method: "POST", url: "/api/v1/commands",
    headers: { "x-test-linked": "1" }, payload: body });
  assert.equal(first.statusCode, 202);
  assert.equal(second.statusCode, 202);
  assert.equal(first.json().commandId, second.json().commandId, "same durable command");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commands").get().n, 1, "no duplicate row");
});

test("refreshing device telemetry requires the read capability", async t => {
  const { app, db } = harness({ capabilities: [] });
  t.after(async () => { await app.close(); db.close(); });
  const res = await app.inject({ method: "POST", url: "/api/v1/commands",
    headers: { "x-test-linked": "1" }, payload: envelope() });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, "read_messages_capability_required");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM commands").get().n, 0);
});

test("telemetry carries capabilities.commandTypes through, bounded and defensively", async t => {
  const db = new Database(":memory:");
  const { DeviceTelemetryStore } = require("../src/deviceTelemetry");
  const store = new DeviceTelemetryStore(db);
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.headers["x-test-agent"]) request.authenticatedAgentId = String(request.headers["x-test-agent"]);
    done();
  });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db), commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db), accountId: "a",
    authorizeAgent: request => request.authenticatedAgentId
      ? { deviceId: request.authenticatedAgentId, role: "PRIMARY_TRUST_AGENT" } : null,
    linkedSessions: null, deviceTelemetryStore: store,
  });
  t.after(async () => { await app.close(); db.close(); });

  const post = payload => app.inject({ method: "POST", url: "/api/v1/agent/device-telemetry",
    headers: { "x-test-agent": "phone" }, payload: { deviceId: "phone", timestamp: Date.now(), ...payload } });

  // Valid list is preserved, duplicates and junk dropped.
  assert.equal((await post({ capabilities: { commandTypes: ["SEND_SMS", "SEND_SMS", 7, "", "REFRESH_DEVICE_TELEMETRY"] } })).statusCode, 200);
  assert.deepEqual(store.get("phone").capabilities.commandTypes, ["SEND_SMS", "REFRESH_DEVICE_TELEMETRY"]);

  // Over-long entries and oversized lists are bounded, never fatal.
  const long = "x".repeat(500);
  const many = Array.from({ length: 80 }, (_, i) => `CMD_${i}`);
  assert.equal((await post({ capabilities: { commandTypes: [long, ...many] } })).statusCode, 200);
  const bounded = store.get("phone").capabilities.commandTypes;
  assert.equal(bounded.length <= 32, true);
  assert.equal(bounded.includes(long), false);

  // Absent capabilities stay absent (older clients are unaffected).
  assert.equal((await post({ battery: { level: 50 } })).statusCode, 200);
  assert.equal(store.get("phone").capabilities, undefined);
  assert.equal(store.get("phone").battery.level, 50, "rest of the payload survives");

  // A malformed shape is dropped rather than stored as truth.
  assert.equal((await post({ capabilities: { commandTypes: "not-an-array" } })).statusCode, 200);
  assert.equal(store.get("phone").capabilities, undefined);
});
