"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

// Standalone fastify instance with injected deps — no Redis, no browser, no
// server.js import. This IS the modular-monolith boundary paying off: the
// control plane is testable in isolation (ADR-004 "independent CI").

describe("Phase 2 control plane HTTP API", () => {
  let app;

  before(async () => {
    app = Fastify({ logger: false });
    const db = new Database(":memory:");
    registerControlPlaneRoutes(app, {
      trustRegistry: new TrustRegistry(db),
      commandEngine: new CommandEngine(db),
      accountId: "test-account",
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test("POST /api/v1/commands returns 202 with a durable commandId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/commands",
      payload: {
        type: "SEND_SMS",
        payload: Buffer.from(JSON.stringify({ phone: "+989120000000", body: "ping" })).toString("base64"),
        idempotencyKey: `idem-${Date.now()}-a`,
        targetAgentId: "test-agent",
      },
    });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.match(body.commandId, /^cmd_/);
    assert.equal(body.state, "QUEUED");
    assert.equal(body.created, true);
  });

  test("idempotency replay returns the original commandId with created=false", async () => {
    const key = `idem-${Date.now()}-b`;
    const first = await app.inject({
      method: "POST", url: "/api/v1/commands",
      payload: { type: "SEND_SMS", payload: Buffer.from("x").toString("base64"), idempotencyKey: key },
    });
    const second = await app.inject({
      method: "POST", url: "/api/v1/commands",
      payload: { type: "SEND_SMS", payload: Buffer.from("y").toString("base64"), idempotencyKey: key },
    });
    assert.equal(first.statusCode, 202);
    assert.equal(second.statusCode, 202);
    assert.equal(second.json().created, false);
    assert.equal(second.json().commandId, first.json().commandId);
  });

  test("claim → accept → execute → complete lifecycle over HTTP", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/v1/commands",
      payload: {
        type: "SEND_SMS",
        payload: Buffer.from(JSON.stringify({ phone: "+98913", body: "lifecycle" })).toString("base64"),
        idempotencyKey: `idem-${Date.now()}-c`,
        targetAgentId: "lifecycle-agent",
      },
    });
    const { commandId } = create.json();

    const claim = await app.inject({
      method: "POST", url: "/api/v1/agent/commands/claim",
      payload: { agentId: "lifecycle-agent" },
    });
    assert.equal(claim.statusCode, 200);
    const claimed = claim.json().commands.find((c) => c.id === commandId);
    assert.ok(claimed, "claimed row present");
    assert.equal(claimed.state, "DELIVERED_TO_AGENT");

    for (const state of ["ACCEPTED", "EXECUTING", "COMPLETED"]) {
      const s = await app.inject({
        method: "POST", url: `/api/v1/agent/commands/${commandId}/status`,
        payload: { state, result: `at ${state}` },
      });
      assert.equal(s.statusCode, 200, `${state} → ${s.statusCode}`);
    }
    const final = await app.inject({ method: "GET", url: `/api/v1/commands/${commandId}` });
    assert.equal(final.json().state, "COMPLETED");
  });

  test("illegal transition gets 409 and the state stays intact", async () => {
    const create = await app.inject({
      method: "POST", url: "/api/v1/commands",
      payload: {
        type: "SEND_SMS", payload: Buffer.from("x").toString("base64"),
        idempotencyKey: `idem-${Date.now()}-d`, targetAgentId: "guard-agent",
      },
    });
    const { commandId } = create.json();
    await app.inject({ method: "POST", url: "/api/v1/agent/commands/claim", payload: { agentId: "guard-agent" } });
    // jump straight to COMPLETED without ACCEPTED/EXECUTING
    const jump = await app.inject({
      method: "POST", url: `/api/v1/agent/commands/${commandId}/status`,
      payload: { state: "COMPLETED" },
    });
    assert.equal(jump.statusCode, 409);
    const g = await app.inject({ method: "GET", url: `/api/v1/commands/${commandId}` });
    assert.equal(g.json().state, "DELIVERED_TO_AGENT");
  });

  test("trust statements: monotonic relay, gap rejection, cursor listing", async () => {
    const mk = (n) => ({
      statement: { trustSequence: n, statementId: `s${n}`, operation: "DEVICE_APPROVED", deviceId: "d1", rootSignature: `sig${n}` },
    });
    const ok1 = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(1) });
    assert.equal(ok1.json().applied, true);

    const gap = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(3) });
    assert.equal(gap.json().applied, false);
    assert.equal(gap.json().reason, "sequence_gap");

    const ok2 = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(2) });
    assert.equal(ok2.json().applied, true);

    const list = await app.inject({ method: "GET", url: "/api/v1/trust/statements?after=0" });
    assert.deepEqual(list.json().statements.map((s) => s.trustSequence), [1, 2]);
  });

  test("trust snapshot 404 before any snapshot exists", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/trust/snapshot" });
    assert.equal(res.statusCode, 404);
  });

  test("empty payload is rejected with 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/v1/commands",
      payload: { type: "SEND_SMS", payload: "", idempotencyKey: `idem-${Date.now()}-e` },
    });
    assert.equal(res.statusCode, 400);
  });
});
