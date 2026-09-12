"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

function encryptedPayload(event) {
  const b64 = length => Buffer.alloc(length, 7).toString("base64");
  const envelope = {
    v: event.cryptoVersion,
    kind: "message",
    eventId: event.eventId,
    type: event.type,
    conversationId: event.conversationId || "",
    iv: b64(12),
    ciphertext: b64(16),
  };
  if (event.cryptoVersion === 3) Object.assign(envelope, {
    historyWrapIv: b64(12), historyWrappedDek: b64(16),
    liveWrapIv: b64(12), liveWrappedDek: b64(16),
  });
  else Object.assign(envelope, { wrapIv: b64(12), wrappedDek: b64(16) });
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

// Standalone fastify instance with injected deps — no Redis, no browser, no
// server.js import. This IS the modular-monolith boundary paying off: the
// control plane is testable in isolation (ADR-004 "independent CI").

describe("Phase 2 control plane HTTP API", () => {
  let app;

  before(async () => {
    app = Fastify({ logger: false });
    app.addHook("preHandler", (request, _reply, done) => {
      if (request.headers["x-test-linked"]) request.linkedDevice = {
        deviceId: String(request.headers["x-test-linked"]),
        capabilities: ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "CONTACTS_READ"],
      };
      done();
    });
    const db = new Database(":memory:");
    const rateBuckets = new Map();
    registerControlPlaneRoutes(app, {
      trustRegistry: new TrustRegistry(db),
      commandEngine: new CommandEngine(db),
      eventStore: new EventStore(db),
      accountId: "test-account",
      // Test auth stub: request header X-Test-Agent-Role simulates the
      // server's real authorizeAgent (signature → {deviceId, role}).
      linkedSessions: require("../src/linkedSessions"),
      checkRateLimit: (_request, key, max) => {
        const count = (rateBuckets.get(key) || 0) + 1;
        rateBuckets.set(key, count);
        return { allowed: count <= max, retryAfterSeconds: 60 };
      },
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

  test("linked SEND_SMS requires encryption and is limited to ten per minute", async () => {
    const plain = await app.inject({ method: "POST", url: "/api/v1/commands",
      headers: { "x-test-linked": "rate-device" },
      payload: { type: "SEND_SMS", payload: Buffer.from("x").toString("base64"), cryptoVersion: 0 } });
    assert.equal(plain.statusCode, 400);
    for (let i = 0; i < 10; i += 1) {
      const response = await app.inject({ method: "POST", url: "/api/v1/commands",
        headers: { "x-test-linked": "rate-device" },
        payload: { type: "SEND_SMS", payload: Buffer.from("opaque").toString("base64"),
          encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1, idempotencyKey: `rate-${i}` } });
      assert.equal(response.statusCode, 202, response.body);
    }
    const limited = await app.inject({ method: "POST", url: "/api/v1/commands",
      headers: { "x-test-linked": "rate-device" },
      payload: { type: "SEND_SMS", payload: Buffer.from("opaque").toString("base64"),
        encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1, idempotencyKey: "rate-11" } });
    assert.equal(limited.statusCode, 429);
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
        (() => { const event = { eventId: `evt-${Date.now()}-1`, type: "MESSAGE_CREATED", conversationId: "conv-x", encoding: "envelope.v3", schemaVersion: 1, cryptoVersion: 3 }; return { ...event, payload: encryptedPayload(event) }; })(),
        (() => { const event = { eventId: `evt-${Date.now()}-2`, type: "THREAD_READ", encoding: "envelope.v3", schemaVersion: 1, cryptoVersion: 3 }; return { ...event, payload: encryptedPayload(event) }; })(),
        ],
      },
    });
    assert.equal(up.statusCode, 200);
    const body = up.json();
    assert.equal(body.accepted.length, 2);
    // LOCK 10: per-account monotonic — first upload to this test account starts at 1
    assert.deepEqual(body.accepted.map((a) => a.serverSequence), [1, 2]);
  });

  test("web sync ACK requires linked authorization and matching replica metadata", async () => {
    const headers = { "x-test-linked": "web-device" };
    const bootstrap = await app.inject({ method: "GET", url: "/api/v1/web/bootstrap", headers });
    assert.equal(bootstrap.statusCode, 200);
    const snapshot = bootstrap.json();
    const payload = {
      cursor: snapshot.highWatermark,
      replicaGeneration: snapshot.replicaGeneration,
      snapshotVersion: snapshot.snapshotVersion,
    };
    const denied = await app.inject({ method: "POST", url: "/api/v1/web/sync/ack", payload });
    assert.equal(denied.statusCode, 401);
    const mismatch = await app.inject({
      method: "POST", url: "/api/v1/web/sync/ack", headers,
      payload: { ...payload, replicaGeneration: "wrong-generation-id" },
    });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().error, "snapshot_required");
    const accepted = await app.inject({ method: "POST", url: "/api/v1/web/sync/ack", headers, payload });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().cursor, snapshot.highWatermark);
  });

  test("event ingest rejects plaintext, malformed, unknown, and oversized input", async () => {
    const valid = (overrides = {}) => {
      const event = {
      eventId: `secure-${Date.now()}-${Math.random()}`,
      type: "MESSAGE_CREATED",
      encoding: "envelope.v3",
      schemaVersion: 1,
      cryptoVersion: 3,
      ...overrides,
      };
      return { ...event, payload: overrides.payload ?? encryptedPayload(event) };
    };
    const post = events => app.inject({ method: "POST", url: "/api/v1/agent/events/batch", payload: { events } });

    const plaintext = await post([valid({ cryptoVersion: 0, encoding: "envelope.v1" })]);
    assert.equal(plaintext.statusCode, 400);
    assert.equal(plaintext.json().error, "encrypted_payload_required");
    assert.equal((await post([valid({ payload: "!!!!" })])).statusCode, 400);
    assert.equal((await post([valid({ eventId: "x".repeat(129) })])).statusCode, 400);
    assert.equal((await post([valid({ type: "UNKNOWN_DATA" })])).statusCode, 400);
    assert.equal((await post(Array.from({ length: 101 }, (_, index) => valid({ eventId: `many-${index}` })))).statusCode, 400);
    assert.equal((await post([valid({ payload: Buffer.alloc(64 * 1024 + 1).toString("base64") })])).statusCode, 400);
    const aggregate = Array.from({ length: 5 }, (_, index) => valid({
      eventId: `aggregate-${index}`,
      type: "KEYRING_ENTRY",
      payload: Buffer.alloc(110 * 1024, index).toString("base64"),
      encoding: "envelope.v2",
      cryptoVersion: 2,
    }));
    assert.equal((await post(aggregate)).statusCode, 400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/v1/agent/events/batch",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(810 * 1024), events: [] }),
    });
    assert.equal(oversized.statusCode, 413);
  });

  test("lost ACK redelivery returns original sequence without duplicating storage", async () => {
    // The suite shares ONE store; anchor expectations to the CURRENT max
    // sequence instead of absolute numbers.
    const before = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=1000" });
    const maxSeqBefore = before.json().events.reduce((m, e) => Math.max(m, e.sequence), 0);

    const eventId = `evt-dup-${Date.now()}`;
    const p1 = Buffer.from("payload-one").toString("base64");
    const p2 = Buffer.from("payload-two").toString("base64");
    const first = await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: { events: [{ eventId, type: "DEVICE_STATUS_CHANGED", payload: p1, encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 }] },
    });
    const firstSeq = first.json().accepted[0].serverSequence;
    assert.equal(firstSeq, maxSeqBefore + 1);

    const second = await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: {
        events: [
          { eventId, type: "DEVICE_STATUS_CHANGED", payload: p1, encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 }, // redelivery
          { eventId: `${eventId}-new`, type: "DEVICE_STATUS_CHANGED", payload: p2, encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 },
        ],
      },
    });
    const body = second.json();
    assert.equal(body.accepted.length, 2);
    assert.equal(body.duplicates, 1);
    // LOCK 10: the dup consumed NO sequence — the new event lands exactly one
    // above its predecessor with no gap in between.
    assert.equal(body.accepted[0].serverSequence, firstSeq);
    assert.equal(body.accepted[1].serverSequence, firstSeq + 1);
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

  test("linked sync diagnostics require READ_MESSAGES and return counts only", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/v1/linked-device/sync-diagnostics" });
    assert.equal(denied.statusCode, 403);
    const response = await app.inject({
      method: "GET", url: "/api/v1/linked-device/sync-diagnostics",
      headers: { "x-test-linked": "web-device" },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.total > 0);
    assert.ok(body.maxSequence > 0);
    assert.ok(Array.isArray(body.countsByType));
    assert.equal("ciphertext" in body, false);
    assert.equal(JSON.stringify(body).includes("eventId"), false);
    assert.equal(JSON.stringify(body).includes("aggregateId"), false);
  });

  test("linked key bootstrap returns only opaque grants and requires READ_MESSAGES", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/v1/linked-device/key-grants?after=0" });
    assert.equal(denied.statusCode, 403);
    await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: { events: [
        { eventId: `grant-${Date.now()}`, type: "KEY_GRANT", conversationId: "thread",
          payload: Buffer.from(JSON.stringify({ deviceId: "web-device", wrapped: "opaque" })).toString("base64"), encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 },
        { eventId: `other-grant-${Date.now()}`, type: "KEY_GRANT", conversationId: "thread",
          payload: Buffer.from(JSON.stringify({ deviceId: "other-device", wrapped: "opaque" })).toString("base64"), encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 },
      ] },
    });
    const response = await app.inject({
      method: "GET", url: "/api/v1/linked-device/key-grants?after=0&limit=1000",
      headers: { "x-test-linked": "web-device" },
    });
    assert.equal(response.statusCode, 200);
    const page = response.json();
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every(event => event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT"));
    assert.ok(page.events.every(event => typeof event.ciphertext === "string"));
    assert.ok(page.events.every(event => JSON.parse(Buffer.from(event.ciphertext, "base64")).deviceId === "web-device"));
  });

  test("linked key bootstrap returns only this browser's v2/v3 keys", async () => {
    const denied = await app.inject({ method: "GET", url: "/api/v1/linked-device/keyring" });
    assert.equal(denied.statusCode, 403);
    await app.inject({
      method: "POST", url: "/api/v1/agent/events/batch",
      payload: { events: [
        { eventId: `keyring-${Date.now()}`, type: "KEYRING_ENTRY", conversationId: "__account_keyring__",
          payload: Buffer.from(JSON.stringify({ deviceId: "web-device", keyId: "messages" })).toString("base64"), encoding: "envelope.v2", schemaVersion: 1, cryptoVersion: 2 },
        { eventId: `other-keyring-${Date.now()}`, type: "KEYRING_ENTRY", conversationId: "__account_keyring__",
          payload: Buffer.from(JSON.stringify({ deviceId: "other-device", keyId: "messages" })).toString("base64"), encoding: "envelope.v2", schemaVersion: 1, cryptoVersion: 2 },
        { eventId: `history-${Date.now()}`, type: "HISTORY_KEY_GRANT", conversationId: "__history_master__",
          payload: Buffer.from(JSON.stringify({ deviceId: "web-device", keyId: "history" })).toString("base64"),
          encoding: "envelope.v3", schemaVersion: 1, cryptoVersion: 3 },
      ] },
    });
    const response = await app.inject({
      method: "GET", url: "/api/v1/linked-device/keyring?limit=1000",
      headers: { "x-test-linked": "web-device" },
    });
    assert.equal(response.statusCode, 200);
    const page = response.json();
    assert.equal(page.hasMore, false);
    assert.ok(page.events.length > 0);
    assert.ok(page.events.every(event =>
      (event.type === "KEYRING_ENTRY" && event.cryptoVersion === 2) ||
      (event.type === "HISTORY_KEY_GRANT" && event.cryptoVersion === 3)));
    assert.ok(page.events.every(event => JSON.parse(Buffer.from(event.ciphertext, "base64")).deviceId === "web-device"));
  });
});
