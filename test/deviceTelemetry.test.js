"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const Fastify = require("fastify");
const { DeviceTelemetryStore } = require("../src/deviceTelemetry");
const { TrustRegistry } = require("../src/trustRegistry");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

test("telemetry keeps history and returns the latest device snapshot", () => {
  const db = new Database(":memory:");
  const store = new DeviceTelemetryStore(db);
  store.upsert({ deviceId: "phone", timestamp: 1, battery: { level: 20 } }, "PRIMARY_TRUST_AGENT");
  store.upsert({ deviceId: "phone", timestamp: 2, battery: { level: 80 } }, "PRIMARY_TRUST_AGENT");
  assert.equal(store.get("phone").battery.level, 80);
  db.prepare("UPDATE device_telemetry_history SET received_at=0 WHERE observed_at=1").run();
  assert.equal(store.cleanup(31 * 86400000), 1);
  db.close();
});

test("telemetry ingestion requires the bound agent and matching device id", async t => {
  const db = new Database(":memory:");
  const store = new DeviceTelemetryStore(db);
  const app = Fastify();
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db), commandEngine: {}, eventStore: {}, accountId: "default",
    authorizeAgent: request => request.authenticatedAgentId
      ? { deviceId: request.authenticatedAgentId, role: "PRIMARY_TRUST_AGENT" } : null,
    linkedSessions: null, deviceTelemetryStore: store,
  });
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.headers["x-test-agent"]) request.authenticatedAgentId = String(request.headers["x-test-agent"]);
    done();
  });
  t.after(async () => { await app.close(); db.close(); });
  const payload = { deviceId: "phone", timestamp: Date.now(), sync: { outboxDepth: 27 } };
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/agent/device-telemetry", payload })).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/agent/device-telemetry", payload,
    headers: { "x-test-agent": "other" } })).statusCode, 403);
  const ok = await app.inject({ method: "POST", url: "/api/v1/agent/device-telemetry", payload,
    headers: { "x-test-agent": "phone" } });
  assert.equal(ok.statusCode, 200, ok.payload);
  assert.equal(store.get("phone").sync.outboxDepth, 27);
});
