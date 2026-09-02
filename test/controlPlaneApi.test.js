"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
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
      eventStore: new EventStore(db),
      accountId: "test-account",
      // Test auth stub: request header X-Test-Agent-Role simulates the
      // server's real authorizeAgent (signature → {deviceId, role}).
      linkedSessions: require("../src/linkedSessions"),
      authorizeAgent: (request) => {
        const role = request.headers["x-test-agent-role"];
        const deviceId = request.headers["x-test-agent-device"] || "test-agent";
        return role ? { deviceId, role } : null;
      },
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
    // SECURITY: without agent auth (browser/anonymous) trust POST is 403.
    const anon = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(1) });
    assert.equal(anon.statusCode, 403);

    const H = { "x-test-agent-role": "PRIMARY_TRUST_AGENT", "x-test-agent-device": "trust-root-device" };
    const ok1 = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(1), headers: H });
    assert.equal(ok1.json().applied, true);

    const gap = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(3), headers: H });
    assert.equal(gap.json().applied, false);
    assert.equal(gap.json().reason, "sequence_gap");

    const ok2 = await app.inject({ method: "POST", url: "/api/v1/trust/statements", payload: mk(2), headers: H });
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

  test("event batch upload: partial ACK with per-account serverSequences (PR-09)", async () => {
    const up = await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: {
        sourceDeviceId: "android-1",
        events: [
          { eventId: `evt-${Date.now()}-1`, type: "MESSAGE_CREATED", conversationId: "conv-x", payload: Buffer.from("p1").toString("base64") },
          { eventId: `evt-${Date.now()}-2`, type: "THREAD_READ", payload: Buffer.from("p2").toString("base64") },
        ],
      },
    });
    assert.equal(up.statusCode, 200);
    const body = up.json();
    assert.equal(body.accepted.length, 2);
    // LOCK 10: per-account monotonic — first upload to this test account starts at 1
    assert.deepEqual(body.accepted.map((a) => a.serverSequence), [1, 2]);
  });

  test("duplicate eventId in a later batch ACKs nothing new and consumes no sequence", async () => {
    // The suite shares ONE store; anchor expectations to the CURRENT max
    // sequence instead of absolute numbers.
    const before = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=1000" });
    const maxSeqBefore = before.json().events.reduce((m, e) => Math.max(m, e.sequence), 0);

    const eventId = `evt-dup-${Date.now()}`;
    const p1 = Buffer.from("payload-one").toString("base64");
    const p2 = Buffer.from("payload-two").toString("base64");
    const first = await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: { events: [{ eventId, type: "T", payload: p1 }] },
    });
    const firstSeq = first.json().accepted[0].serverSequence;
    assert.equal(firstSeq, maxSeqBefore + 1);

    const second = await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: {
        events: [
          { eventId, type: "T", payload: p1 }, // redelivery
          { eventId: `${eventId}-new`, type: "T", payload: p2 },
        ],
      },
    });
    const body = second.json();
    assert.equal(body.accepted.length, 1);
    assert.equal(body.duplicates, 1);
    // LOCK 10: the dup consumed NO sequence — the new event lands exactly one
    // above its predecessor with no gap in between.
    assert.equal(body.accepted[0].serverSequence, firstSeq + 1);
    const store = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=1000" });
    const seqs = store.json().events.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1] + 1, "sequences stay contiguous (no gaps)");
    }
  });

  test("GET /api/v1/sync returns ciphertext events with cursor pagination", async () => {
    const sync = await app.inject({
      method: "GET", url: "/api/v1/sync?after=0&limit=2",
    });
    assert.equal(sync.statusCode, 200);
    const page = sync.json();
    assert.equal(page.events.length, 2);
    assert.equal(page.hasMore, true);
    const page2 = await app.inject({
      method: "GET", url: `/api/v1/sync?after=${page.nextCursor}&limit=10`,
    });
    const rest = page2.json();
    assert.equal(rest.hasMore, false);
    for (const ev of [...page.events, ...rest.events]) {
      // payload must be valid base64 (opaque envelope)
      assert.ok(Buffer.from(ev.ciphertext, "base64").length > 0);
    }
  });
});
