"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { configure } = require("../src/pairingDb");
const linkedSessions = require("../src/linkedSessions");
const { EventStore } = require("../src/eventStore");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

test("linked browser presence is capability scoped and contains no session token", async () => {
  const db = new Database(":memory:");
  configure(db);
  const app = Fastify();
  app.addHook("preHandler", (request, _reply, done) => {
    if (request.headers["x-test-linked"]) request.linkedDevice = {
      deviceId: "browser-1", capabilities: request.headers["x-test-linked"] === "read" ? ["READ_MESSAGES"] : [],
    };
    done();
  });
  registerControlPlaneRoutes(app, { trustRegistry: new TrustRegistry(db),
    commandEngine: new CommandEngine(db), eventStore: new EventStore(db), accountId: "account",
    linkedSessions, authorizeAgent: () => null });
  try {
    await app.ready();
    const token = linkedSessions.issue("browser-1", ["READ_MESSAGES"]);
    linkedSessions.observe(token, "192.0.2.8", "Example Browser", true);
    const url = "/api/v1/linked-device/sessions";
    assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url, headers: { "x-test-linked": "none" } })).statusCode, 403);
    const result = await app.inject({ method: "GET", url, headers: { "x-test-linked": "read" } });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().sessions[0].ip, "192.0.2.8");
    assert.ok(result.json().sessions[0].lastDataAt);
    assert.equal(result.body.includes(token), false);
    assert.equal(result.body.includes("token_hash"), false);
    linkedSessions.revokeDevice("browser-1");
    const afterRevoke = await app.inject({ method: "GET", url, headers: { "x-test-linked": "read" } });
    assert.deepEqual(afterRevoke.json().sessions, []);
  } finally { await app.close(); db.close(); }
});
