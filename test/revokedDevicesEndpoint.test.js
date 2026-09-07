"use strict";
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

// Issue 6 (Phase 2): GET /api/v1/trust/revoked-devices diagnostic endpoint.
describe("GET /api/v1/trust/revoked-devices", () => {
  let app;
  let db;
  let trustRegistry;

  before(async () => {
    app = Fastify({ logger: false });
    db = new Database(":memory:");
    trustRegistry = new TrustRegistry(db);
    registerControlPlaneRoutes(app, {
      trustRegistry,
      commandEngine: new CommandEngine(db),
      eventStore: new EventStore(db),
      accountId: "acc1",
      linkedSessions: require("../src/linkedSessions"),
      authorizeAgent: (request) => {
        const role = request.headers["x-test-agent-role"];
        return role ? { deviceId: request.headers["x-test-agent-device"] || "test-agent", role } : null;
      },
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  test("empty registry lists no revoked devices", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/trust/revoked-devices" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { revoked: [] });
  });

  test("DEVICE_REVOKED statement appears in the revoked list; other ops do not", async () => {
    const apply = (statement) => trustRegistry.applyStatement({ accountId: "acc1", statement });
    assert.deepEqual(
      apply({ statementId: "s-approve", operation: "DEVICE_APPROVED", deviceId: "web-a", trustSequence: 1, rootSignature: "sig" }),
      { applied: true, trustSequence: 1 },
    );
    const revoked = apply({
      statementId: "s-revoke",
      operation: "DEVICE_REVOKED",
      deviceId: "web-a",
      trustSequence: 2,
      issuedAt: 1750000000000,
      rootSignature: "sig",
    });
    assert.equal(revoked.applied, true);

    const res = await app.inject({ method: "GET", url: "/api/v1/trust/revoked-devices" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      revoked: [
        {
          deviceId: "web-a",
          trustSequence: 2,
          revokedAt: 1750000000000,
          reason: "DEVICE_REVOKED",
        },
      ],
    });
  });
});
