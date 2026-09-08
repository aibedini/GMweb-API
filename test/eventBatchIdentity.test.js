"use strict";
// P0 (scope doc §9/§26): EventStore.sourceDeviceId must come from the
// authenticated agent identity, never from a client-controlled body field.
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const Fastify = require("fastify");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

function makeApp(authenticatedDeviceId) {
  const db = new Database(":memory:");
  const eventStore = new EventStore(db);
  const app = Fastify();
  registerControlPlaneRoutes(app, {
    trustRegistry: null,
    commandEngine: {},
    eventStore,
    accountId: "default",
    authorizeAgent: request => (request.authenticatedAgentId
      ? { deviceId: request.authenticatedAgentId, role: "PRIMARY_TRUST_AGENT" } : null),
    linkedSessions: null,
    deviceTelemetryStore: null,
  });
  app.addHook("preHandler", (request, _reply, done) => {
    request.authenticatedAgentId = authenticatedDeviceId || null;
    done();
  });
  return { app, db, eventStore };
}

test("authenticated agent identity wins over a spoofed body sourceDeviceId", async t => {
  const { app, db } = makeApp("real-android-device");
  t.after(async () => { await app.close(); db.close(); });

  const up = await app.inject({
    method: "POST", url: "/api/v1/agent/events/batch",
    payload: {
      sourceDeviceId: "spoofed-device", // must be IGNORED
      events: [{ eventId: `evt-spoof-${Date.now()}`, type: "MESSAGE_CREATED", payload: Buffer.from("x").toString("base64") }],
    },
  });
  assert.equal(up.statusCode, 200);
  assert.equal(up.json().accepted.length, 1);

  const sync = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=10" });
  assert.equal(sync.statusCode, 200);
  const stored = sync.json().events[0];
  assert.equal(stored.sourceDeviceId, "real-android-device");
  assert.notEqual(stored.sourceDeviceId, "spoofed-device");
});

test("a shared-key caller with no bound identity stores null, not the body value", async t => {
  const { app, db } = makeApp(null); // no authenticated agent
  t.after(async () => { await app.close(); db.close(); });

  const up = await app.inject({
    method: "POST", url: "/api/v1/agent/events/batch",
    payload: {
      sourceDeviceId: "wannabe-device",
      events: [{ eventId: `evt-anon-${Date.now()}`, type: "THREAD_READ", payload: Buffer.from("y").toString("base64") }],
    },
  });
  assert.equal(up.statusCode, 200);
  const sync = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=10" });
  assert.equal(sync.json().events[0].sourceDeviceId, null);
});
