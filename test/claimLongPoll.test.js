"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const { ClaimWaiters, clampWaitMs } = require("../src/claimWaiters");
const { AgentAuthService } = require("../src/agentAuth");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}

function makeHarness({ waiters = new ClaimWaiters({ recheckMs: 100 }), runtimeStore = undefined, activityStore = undefined } = {}) {
  const db = new Database(":memory:");
  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, _reply, done) => {
    const agentId = request.headers["x-test-agent"];
    if (agentId) request.authenticatedAgentId = String(agentId);
    done();
  });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db),
    commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db),
    accountId: "a",
    authorizeAgent: (request) => request.authenticatedAgentId
      ? { deviceId: request.authenticatedAgentId, role: "PRIMARY_TRUST_AGENT" }
      : null,
    linkedSessions: require("../src/linkedSessions"),
    agentRuntimeStore: runtimeStore,
    agentActivityStore: activityStore,
    claimWaiters: waiters,
  });
  return { app, db, waiters };
}

/**
 * Harness with REAL AgentAuthService verification and the same exact-byte
 * body capture src/server.js installs.
 */
function makeSignedHarness() {
  const db = new Database(":memory:");
  const app = Fastify({ logger: false });
  const auth = new AgentAuthService(db);
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  auth.registerIdentity({
    deviceId: "phone",
    publicKeys: { signing: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") },
  });

  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    req.rawBody = Buffer.from(body, "utf8");
    defaultJsonParser(req, body, done);
  });

  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db),
    commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db),
    accountId: "a",
    authorizeAgent: (request, rawBody) => {
      if (request.authenticatedAgentId) {
        return { deviceId: request.authenticatedAgentId, role: "PRIMARY_TRUST_AGENT" };
      }
      const result = auth.verifyAgentHeader(request, rawBody);
      return result.ok ? { deviceId: result.deviceId, role: "PRIMARY_TRUST_AGENT" } : null;
    },
    linkedSessions: require("../src/linkedSessions"),
    claimWaiters: new ClaimWaiters({ recheckMs: 100 }),
  });
  return { app, db, pair };
}

function headersFor(agentId) {
  return agentId ? { "x-test-agent": String(agentId) } : {};
}

function claim(app, { agentId = "phone", waitMs, auth = "phone", runtime } = {}) {
  let url = "/api/v1/agent/commands/claim";
  if (waitMs !== undefined) url += `?waitMs=${encodeURIComponent(String(waitMs))}`;
  const payload = { agentId, limit: 25 };
  if (runtime) payload.runtime = runtime;
  return app.inject({ method: "POST", url, headers: headersFor(auth), payload });
}

async function createCommand(app, { agentId = "phone", key = `key-${crypto.randomUUID()}` } = {}) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/commands",
    payload: {
      type: "SEND_SMS",
      payload: Buffer.from("opaque").toString("base64"),
      idempotencyKey: key,
      targetAgentId: agentId,
    },
  });
  assert.equal(response.statusCode, 202, response.payload);
  return response.json();
}

describe("claim long-poll waitMs", () => {
  test("clampWaitMs treats absent, invalid, zero and negative values as no wait", () => {
    assert.equal(clampWaitMs(undefined), 0);
    assert.equal(clampWaitMs(null), 0);
    assert.equal(clampWaitMs(""), 0);
    assert.equal(clampWaitMs("abc"), 0);
    assert.equal(clampWaitMs(-5), 0);
    assert.equal(clampWaitMs(0), 0);
    assert.equal(clampWaitMs(1.5), 0);
    assert.equal(clampWaitMs(25000), 25000);
    assert.equal(clampWaitMs(999999), 25000);
    assert.equal(clampWaitMs("999999"), 25000);
  });

  test("shutdown resolves held waiters with the normal empty result", async () => {
    const waiters = new ClaimWaiters({ recheckMs: 100 });
    const pending = waiters.wait("phone", 5000, () => []);
    await waitFor(() => waiters.size === 1, "waiter registration");
    waiters.shutdown();
    const result = await pending;
    assert.deepEqual(result.commands, []);
    assert.equal(result.reason, "shutdown");
    assert.equal(waiters.size, 0);
  });

  test("Fastify onClose resolves a held claim request", async () => {
    const { app, db, waiters } = makeHarness();
    const pending = claim(app, { agentId: "phone", waitMs: 5000 });
    await waitFor(() => waiters.size === 1, "waiter registration");
    await app.close();
    const response = await pending;
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { commands: [] });
    assert.equal(waiters.size, 0);
    db.close();
  });

  test("no waitMs keeps the old immediate empty response", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const started = Date.now();
    const response = await claim(app, { agentId: "phone" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { commands: [] });
    assert.ok(Date.now() - started < 750, "no waitMs must not hold the request");
    assert.equal(waiters.size, 0);
  });

  test("waitMs returns an already queued command immediately", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const created = await createCommand(app, { agentId: "phone" });
    const started = Date.now();
    const response = await claim(app, { agentId: "phone", waitMs: 2000 });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().commands.length, 1);
    assert.equal(response.json().commands[0].id, created.commandId);
    assert.ok(Date.now() - started < 500, "a claimable command must not wait");
    assert.equal(waiters.size, 0);
  });

  test("a command created after the wait starts wakes the request promptly", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const started = Date.now();
    const pending = claim(app, { agentId: "phone", waitMs: 3000 });
    await waitFor(() => waiters.size === 1, "first waiter registration");
    await delay(300);
    const created = await createCommand(app, { agentId: "phone" });
    const response = await pending;
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().commands.length, 1);
    assert.equal(response.json().commands[0].id, created.commandId);
    assert.ok(Date.now() - started < 1500, "wake must happen well before the deadline");
    assert.equal(waiters.size, 0);
  });

  test("waitMs expires with the normal empty response", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const started = Date.now();
    const response = await claim(app, { agentId: "phone", waitMs: 150 });
    const elapsed = Date.now() - started;
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { commands: [] });
    assert.ok(elapsed >= 100, `expected a held response, got ${elapsed}ms`);
    assert.ok(elapsed < 1500, `expected a prompt timeout, got ${elapsed}ms`);
    assert.equal(waiters.size, 0);
  });

  test("a held claim refreshes presence when the hold ends", async (t) => {
    const records = [];
    const activityStore = { record: (deviceId, source) => records.push({ deviceId, source }) };
    const { app, db, waiters } = makeHarness({ activityStore });
    t.after(async () => { await app.close(); db.close(); });
    const pending = claim(app, { agentId: "phone", waitMs: 120 });
    await waitFor(() => waiters.size === 1, "waiter registration");
    assert.deepEqual(records, [], "the close-time refresh must happen after the hold");
    const response = await pending;
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { commands: [] });
    assert.deepEqual(records, [{ deviceId: "phone", source: "COMMAND_POLL" }]);
  });

  test("invalid waitMs values are immediate and never register a waiter", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    for (const value of ["abc", "-5", "0", "1.5", ""]) {
      const started = Date.now();
      const response = await claim(app, { agentId: "phone", waitMs: value });
      assert.equal(response.statusCode, 200, `waitMs=${value}: ${response.payload}`);
      assert.deepEqual(response.json(), { commands: [] }, `waitMs=${value}`);
      assert.ok(Date.now() - started < 750, `waitMs=${value} must not wait`);
      assert.equal(waiters.size, 0, `waitMs=${value} must not register`);
    }
  });

  test("a second waiter for the same agent replaces the older one", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const first = claim(app, { agentId: "phone", waitMs: 5000 });
    await waitFor(() => waiters.size === 1, "first waiter registration");
    const second = claim(app, { agentId: "phone", waitMs: 5000 });
    const firstResponse = await first;
    assert.equal(firstResponse.statusCode, 200);
    assert.deepEqual(firstResponse.json(), { commands: [] }, "replaced waiter gets the normal empty body");
    await waitFor(() => waiters.size === 1, "replacement registration");
    const created = await createCommand(app, { agentId: "phone" });
    const secondResponse = await second;
    assert.equal(secondResponse.statusCode, 200);
    assert.equal(secondResponse.json().commands[0].id, created.commandId);
    assert.equal(waiters.size, 0);
  });

  test("two concurrent claimers receive the one command exactly once", async (t) => {
    const { app, db } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const created = await createCommand(app, { agentId: "phone" });
    const [first, second] = await Promise.all([
      claim(app, { agentId: "phone" }),
      claim(app, { agentId: "phone" }),
    ]);
    const counts = [first.json().commands.length, second.json().commands.length].sort();
    assert.deepEqual(counts, [0, 1]);
    const claimed = [...first.json().commands, ...second.json().commands];
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, created.commandId);
  });

  test("waiters for different agents do not wake each other", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const other = claim(app, { agentId: "phone-b", waitMs: 500 });
    await waitFor(() => waiters.size === 1, "other agent waiter registration");
    const target = claim(app, { agentId: "phone-a", waitMs: 1000 });
    await waitFor(() => waiters.size === 2, "target agent waiter registration");
    const created = await createCommand(app, { agentId: "phone-a" });
    const targetResponse = await target;
    assert.equal(targetResponse.json().commands[0].id, created.commandId);
    const otherResponse = await other;
    assert.deepEqual(otherResponse.json(), { commands: [] });
    assert.equal(waiters.size, 0);
  });

  test("unauthenticated callers ignore waitMs", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const started = Date.now();
    const response = await claim(app, { agentId: "phone", waitMs: 5000, auth: null });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { commands: [] });
    assert.ok(Date.now() - started < 750);
    assert.equal(waiters.size, 0);
  });

  test("an idempotent replay (created:false) does not wake a waiter", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    const key = "replay-key";
    await createCommand(app, { agentId: "phone", key });
    const consumed = await claim(app, { agentId: "phone" });
    assert.equal(consumed.json().commands.length, 1);

    const pending = claim(app, { agentId: "phone", waitMs: 1000 });
    await waitFor(() => waiters.size === 1, "waiter registration");
    const replay = await createCommand(app, { agentId: "phone", key });
    assert.equal(replay.created, false);
    await delay(200);
    assert.equal(waiters.size, 1, "a replay must not resolve the waiter");

    const fresh = await createCommand(app, { agentId: "phone" });
    const response = await pending;
    assert.equal(response.json().commands[0].id, fresh.commandId);
    assert.equal(waiters.size, 0);
  });

  test("the waiter cap makes new requests immediate", async (t) => {
    const waiters = new ClaimWaiters({ maxWaiters: 1, recheckMs: 100 });
    const { app, db } = makeHarness({ waiters });
    t.after(async () => { await app.close(); db.close(); });
    const first = claim(app, { agentId: "phone", waitMs: 2000 });
    await waitFor(() => waiters.size === 1, "first waiter registration");

    const started = Date.now();
    const second = await claim(app, { agentId: "phone-2", waitMs: 2000 });
    assert.equal(second.statusCode, 200);
    assert.deepEqual(second.json(), { commands: [] });
    assert.ok(Date.now() - started < 750, "over-cap requests must not wait");
    assert.equal(waiters.size, 1);

    const created = await createCommand(app, { agentId: "phone" });
    const firstResponse = await first;
    assert.equal(firstResponse.json().commands[0].id, created.commandId);
    assert.equal(waiters.size, 0);
  });

  test("runtime metadata is recorded once, at request start", async (t) => {
    let records = 0;
    const runtimeStore = { record: () => { records += 1; } };
    const { app, db, waiters } = makeHarness({ runtimeStore });
    t.after(async () => { await app.close(); db.close(); });
    const runtime = { appVersionName: "3.4.22", appVersionCode: 129, commandTypes: ["SEND_SMS"] };
    const pending = claim(app, { agentId: "phone", waitMs: 1000, runtime });
    await waitFor(() => waiters.size === 1, "waiter registration");
    await createCommand(app, { agentId: "phone" });
    await pending;
    assert.equal(records, 1, "the wake path must not record runtime again");
  });

  test("a client disconnect releases the waiter", async (t) => {
    const { app, db, waiters } = makeHarness();
    t.after(async () => { await app.close(); db.close(); });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    const body = JSON.stringify({ agentId: "phone", limit: 25 });
    const request = http.request({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/api/v1/agent/commands/claim?waitMs=5000",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-test-agent": "phone",
      },
    });
    request.on("error", () => {});
    request.write(body);
    request.end();
    await waitFor(() => waiters.size === 1, "waiter registration before disconnect");
    request.destroy();
    await waitFor(() => waiters.size === 0, "waiter release after disconnect");
  });

  test("a near-edge timestamp survives a held claim without end-of-hold re-verification", async (t) => {
    const { app, db, pair } = makeSignedHarness();
    t.after(async () => { await app.close(); db.close(); });
    const body = JSON.stringify({ agentId: "phone", limit: 25 });
    // 89 s old at START. Re-verifying the same bytes at the end of the hold
    // would put them outside the 90 s window (and trip the nonce ledger).
    const ts = Date.now() - 89_000;
    const bodyHash = crypto.createHash("sha256").update(Buffer.from(body)).digest("hex");
    const canonical = `POST\n/api/v1/agent/commands/claim\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
    const signature = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
    const started = Date.now();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/agent/commands/claim?waitMs=1500",
      headers: {
        "content-type": "application/json",
        "x-agent-auth": `phone:${signature}`,
        "x-agent-ts": String(ts),
      },
      payload: body,
    });
    const elapsed = Date.now() - started;
    assert.equal(response.statusCode, 200, response.payload);
    assert.deepEqual(response.json(), { commands: [] });
    assert.ok(elapsed >= 1200, `expected a held request, got ${elapsed}ms`);
    assert.ok(elapsed < 5000, `expected the hold to end, got ${elapsed}ms`);
  });
});
