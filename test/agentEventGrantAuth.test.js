"use strict";

/**
 * LDV-004 PR-D (§2.3 / §4.4.1) — control-key event batches are
 * PRIMARY_TRUST_AGENT-only.
 *
 * KEY_GRANT / KEYRING_ENTRY / HISTORY_KEY_GRANT / CONTACTS_KEY_GRANT carry
 * account and conversation key material. GMweb still relays them opaquely and
 * the phone's rootSignature remains the end-to-end cryptographic
 * authentication, but the relay must FAIL CLOSED when any other authenticated
 * agent tries to publish one. These tests pin the HTTP boundary:
 *
 *   - a LEGACY_AGENT batch with a control-key type is 403 before ingestion;
 *   - MESSAGE_CREATED batches from the same agent stay accepted;
 *   - the PRIMARY_TRUST_AGENT may publish control-key types;
 *   - the 403 body and the warning log never contain payload material.
 *
 * The harness mirrors server.js: exact raw-body capture (the canonical AgentAuth
 * string hashes the bytes the agent signed), one signature verification in a
 * global preHandler that binds request.authenticatedAgentId, and an
 * authorizeAgent() that only maps that bound id to its role — exactly like the
 * production helper, so the gate is not re-verifying the signature.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Writable } = require("node:stream");
const Database = require("better-sqlite3");
const Fastify = require("fastify");
const { AgentAuthService } = require("../src/agentAuth");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

const ACCOUNT = "grant-auth-account";
const PRIMARY = "primary-phone";
const LEGACY = "legacy-agent";
const BATCH = "/api/v1/agent/events/batch";
const BATCH_V2 = "/api/v1/agent/events/batch-v2";
const CONTROL_KEY_TYPES = ["KEY_GRANT", "KEYRING_ENTRY", "HISTORY_KEY_GRANT", "CONTACTS_KEY_GRANT"];

function makeKey() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function spki(pair) {
  return pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

// Several requests can share one millisecond; AgentAuth rejects a replayed
// (device, ts) pair, so hand every signature a strictly monotonic timestamp.
let lastTs = 0;
function nextTs() {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return lastTs;
}

/** Canonical AgentAuth string over method+path+raw body+ts (agentAuth.js). */
function agentHeaders(pair, deviceId, url, body, ts = nextTs()) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = `POST\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const signature = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return {
    "content-type": "application/json",
    "x-agent-auth": `${deviceId}:${signature}`,
    "x-agent-ts": String(ts),
  };
}

function makeApp({ captureLogs = false } = {}) {
  const logLines = [];
  const app = Fastify(captureLogs
    ? { logger: { level: "warn", stream: new Writable({
      write(chunk, _encoding, callback) { logLines.push(String(chunk)); callback(); },
    }) } }
    : { logger: false });

  const db = new Database(":memory:");
  require("../src/pairingDb").configure(db);
  const agentAuthService = new AgentAuthService(db);
  const primaryPair = makeKey();
  const legacyPair = makeKey();
  agentAuthService.registerIdentity({
    deviceId: PRIMARY, forcePrimary: true, publicKeys: { signing: spki(primaryPair) },
  });
  agentAuthService.registerIdentity({
    deviceId: LEGACY, publicKeys: { signing: spki(legacyPair) },
  });

  const eventStore = new EventStore(db);
  // Mirror server.js raw-body capture: the signature contract hashes the EXACT
  // bytes the agent sent, not a re-serialized body.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, JSON.parse(body.toString("utf8") || "{}")); } catch (error) { done(error); }
  });
  // Mirror the global /api/v1/agent/* gate: verify once, bind the device id.
  // CodeQL sees this test-only server's signature/role gate as authorization
  // and asks for a rate limit; the harness is in-process (fastify.inject, no
  // network listener) and the production routes declare the actual limit.
  // codeql[js/missing-rate-limiting]
  app.addHook("preHandler", (request, reply, done) => {
    const header = String(request.headers["x-agent-auth"] || "");
    if (!header) return done();
    const result = agentAuthService.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
    if (!result.ok) { reply.code(401).send({ error: "unauthorized" }); return; }
    request.authenticatedAgentId = result.deviceId;
    done();
  });

  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db),
    commandEngine: new CommandEngine(db),
    eventStore,
    accountId: ACCOUNT,
    linkedSessions: require("../src/linkedSessions"),
    agentAuthService,
    checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 1 }),
    // Same contract as server.js authorizeAgent(): the global gate already
    // verified this request, so the bound id is mapped to its role and the
    // signature is NOT verified a second time (which would trip replay).
    authorizeAgent: (request, rawBody) => {
      if (request.authenticatedAgentId) {
        return {
          deviceId: request.authenticatedAgentId,
          role: agentAuthService.getRole(request.authenticatedAgentId),
        };
      }
      const header = String(request.headers["x-agent-auth"] || "");
      if (!header) return null;
      const result = agentAuthService.verifyAgentHeader(request, rawBody);
      return result.ok
        ? { deviceId: result.deviceId, role: agentAuthService.getRole(result.deviceId) }
        : null;
    },
  });

  return { app, db, eventStore, primaryPair, legacyPair, logLines };
}

async function post(app, pair, deviceId, url, payload) {
  const body = JSON.stringify(payload);
  return app.inject({ method: "POST", url, payload: body, headers: agentHeaders(pair, deviceId, url, body) });
}

/** A control-key event with the crypto version the policy requires per type. */
function controlKeyEvent(type, { eventId = `evt-${crypto.randomUUID()}`, conversationId = "thread-control-key", payload } = {}) {
  const cryptoVersion = type === "KEYRING_ENTRY" ? 2 : type === "HISTORY_KEY_GRANT" ? 3 : 1;
  return {
    eventId,
    type,
    conversationId,
    payload: Buffer.from(JSON.stringify(payload || {
      deviceId: "ai-device", wrappedKey: "opaque-wrapped-key",
    })).toString("base64"),
    encoding: `envelope.v${cryptoVersion}`,
    schemaVersion: 1,
    cryptoVersion,
  };
}

/** MESSAGE_CREATED must carry a valid encrypted envelope for its type. */
function messageEvent(eventId = `msg-${crypto.randomUUID()}`) {
  const type = "MESSAGE_CREATED";
  const conversationId = "thread-message";
  const b64 = length => Buffer.alloc(length, 7).toString("base64");
  return {
    eventId,
    type,
    conversationId,
    encoding: "envelope.v3",
    schemaVersion: 1,
    cryptoVersion: 3,
    payload: Buffer.from(JSON.stringify({
      v: 3, kind: "message", eventId, type, conversationId,
      iv: b64(12), ciphertext: b64(16),
      historyWrapIv: b64(12), historyWrappedDek: b64(16),
      liveWrapIv: b64(12), liveWrappedDek: b64(16),
    })).toString("base64"),
  };
}

async function syncEvents(app) {
  const response = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=100" });
  assert.equal(response.statusCode, 200);
  return response.json().events;
}

test("LEGACY_AGENT KEY_GRANT batch is 403 and ingests nothing", async t => {
  const { app, db, eventStore, legacyPair } = makeApp();
  t.after(async () => { await app.close(); db.close(); });

  const response = await post(app, legacyPair, LEGACY, BATCH, {
    events: [controlKeyEvent("KEY_GRANT")],
  });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: "primary_trust_agent_required" });
  assert.equal(eventStore.highWatermark(ACCOUNT), 0);
  assert.deepEqual(await syncEvents(app), []);
});

test("every control-key type is rejected for LEGACY_AGENT on both batch routes", async t => {
  const { app, db, eventStore, legacyPair } = makeApp();
  t.after(async () => { await app.close(); db.close(); });

  for (const url of [BATCH, BATCH_V2]) {
    for (const type of CONTROL_KEY_TYPES) {
      const response = await post(app, legacyPair, LEGACY, url, {
        events: [controlKeyEvent(type)],
      });
      assert.equal(response.statusCode, 403, `${url} ${type}`);
      assert.deepEqual(response.json(), { error: "primary_trust_agent_required" }, `${url} ${type}`);
    }
  }
  // Mixed valid message traffic alongside a control-key event is a whole-batch
  // rejection: the grant attempt must not be laundered through a 200.
  const mixed = await post(app, legacyPair, LEGACY, BATCH, {
    events: [messageEvent(), controlKeyEvent("KEY_GRANT")],
  });
  assert.equal(mixed.statusCode, 403);
  assert.equal(eventStore.highWatermark(ACCOUNT), 0);
  assert.deepEqual(await syncEvents(app), []);
});

test("LEGACY_AGENT message batches are still accepted", async t => {
  const { app, db, legacyPair } = makeApp();
  t.after(async () => { await app.close(); db.close(); });

  const v1 = await post(app, legacyPair, LEGACY, BATCH, { events: [messageEvent()] });
  assert.equal(v1.statusCode, 200);
  assert.equal(v1.json().accepted.length, 1);

  const v2 = await post(app, legacyPair, LEGACY, BATCH_V2, { events: [messageEvent()] });
  assert.equal(v2.statusCode, 200);
  assert.deepEqual(v2.json().results.map(row => row.status), ["ACCEPTED"]);

  const stored = await syncEvents(app);
  assert.equal(stored.length, 2);
  assert.ok(stored.every(event => event.sourceDeviceId === LEGACY));
  assert.ok(stored.every(event => event.type === "MESSAGE_CREATED"));
  assert.equal(JSON.stringify(stored).includes("KEY_GRANT"), false);
});

test("PRIMARY_TRUST_AGENT may publish control-key events on both batch routes", async t => {
  const { app, db, eventStore, primaryPair } = makeApp();
  t.after(async () => { await app.close(); db.close(); });

  const v1 = await post(app, primaryPair, PRIMARY, BATCH, {
    events: [controlKeyEvent("KEY_GRANT")],
  });
  assert.equal(v1.statusCode, 200);
  assert.equal(v1.json().accepted.length, 1);

  const v2 = await post(app, primaryPair, PRIMARY, BATCH_V2, {
    events: [
      controlKeyEvent("KEYRING_ENTRY"),
      controlKeyEvent("HISTORY_KEY_GRANT"),
      controlKeyEvent("CONTACTS_KEY_GRANT"),
    ],
  });
  assert.equal(v2.statusCode, 200);
  assert.deepEqual(v2.json().results.map(row => row.status), ["ACCEPTED", "ACCEPTED", "ACCEPTED"]);

  assert.equal(eventStore.highWatermark(ACCOUNT), 4);
  const stored = await syncEvents(app);
  assert.deepEqual(stored.map(event => event.type).sort(),
    [...CONTROL_KEY_TYPES].sort());
  assert.ok(stored.every(event => event.sourceDeviceId === PRIMARY));
});

test("the 403 body and warning log never leak control-key payload material", async t => {
  const { app, db, legacyPair, logLines } = makeApp({ captureLogs: true });
  t.after(async () => { await app.close(); db.close(); });

  const secret = "SECRET-WRAPPED-KEY-MATERIAL-MUST-NOT-LEAK";
  const event = controlKeyEvent("KEY_GRANT", {
    payload: { deviceId: "ai-device", wrappedKey: secret },
  });
  const response = await post(app, legacyPair, LEGACY, BATCH, { events: [event] });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(Object.keys(response.json()), ["error"]);
  assert.equal(response.json().error, "primary_trust_agent_required");
  assert.equal(response.body.includes(secret), false);
  assert.equal(response.body.includes(event.payload), false);
  assert.equal(response.body.includes("wrappedKey"), false);

  // The rejection is observable without the payload: type + count + agent id.
  const logs = logLines.join("\n");
  assert.match(logs, /control-key event batch rejected before ingestion/);
  assert.match(logs, /KEY_GRANT/);
  assert.equal(logs.includes(secret), false);
  assert.equal(logs.includes(event.payload), false);
  assert.equal(logs.includes(event.eventId), false);
  assert.equal(logs.includes(event.conversationId), false);
});
