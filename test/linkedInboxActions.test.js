"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { configure } = require("../src/pairingDb");
const sessions = require("../src/linkedSessions");
const { CommandEngine } = require("../src/commandEngine");
const { TrustRegistry } = require("../src/trustRegistry");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

test("self unlink removes this identity's sessions and rejects replay without revoking another browser", async t => {
  const db = new Database(":memory:"); configure(db);
  const app = Fastify();
  const engine = new CommandEngine(db);
  const audit = [];
  app.addHook("onResponse", (request, _reply, done) => { if (request._readAudit) audit.push(request._readAudit); done(); });
  app.decorateReply("clearCookie", function () { this.header("set-cookie", "gmweb_linked_session=; Path=/; Max-Age=0"); return this; });
  app.addHook("preHandler", (request, _reply, done) => {
    request.linkedDevice = sessions.resolve(request.headers["x-test-token"]);
    done();
  });
  // A REAL P-256 SPKI key: the command-key endpoint now refuses to serve a
  // malformed key (409) instead of handing the browser something unusable.
  const { generateKeyPairSync } = require("node:crypto");
  const spkiB64 = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .publicKey.export({ format: "der", type: "spki" }).toString("base64");
  registerControlPlaneRoutes(app, { commandEngine: engine, trustRegistry: new TrustRegistry(db),
    eventStore: {}, accountId: "a", linkedSessions: sessions, authorizeAgent: () => null,
    agentAuthService: { getPrimaryIdentity: () => ({ device_id: "phone", encryption_public_key: spkiB64 }) } });
  t.after(async () => { await app.close(); db.close(); });
  const own = sessions.issue("browser", ["MARK_READ"]);
  const secondSession = sessions.issue("browser", ["MARK_READ"]);
  const other = sessions.issue("other-browser", ["READ_MESSAGES"]);
  const key = await app.inject({ url: "/api/v1/linked-device/command-key", headers: { "x-test-token": own } });
  assert.equal(key.statusCode, 200);
  assert.equal(key.json().encryptionPublicKeyFormat, "spki-p256");
  assert.equal((await app.inject({ url: "/api/v1/linked-device/command-key", headers: { "x-test-token": other } })).statusCode, 403);
  const command = await app.inject({ method: "POST", url: "/api/v1/commands", headers: { "x-test-token": own },
    payload: { type: "MARK_THREAD_READ", payload: Buffer.from("encrypted").toString("base64"),
      idempotencyKey: "read-test", targetAgentId: "phone", encoding: "envelope.v1", schemaVersion: 1, cryptoVersion: 1 } });
  assert.equal(command.statusCode, 202, command.payload);
  const id = command.json().commandId;
  assert.equal(engine.get(id).sourceClientId, "browser");
  assert.equal(audit[0].action, "read_requested");
  assert.equal(audit[0].readerDeviceId, "browser");
  engine.claimForAgent("phone", { limit: 1 });
  for (const state of ["ACCEPTED", "EXECUTING", "COMPLETED"]) {
    const response = await app.inject({ method: "POST", url: `/api/v1/agent/commands/${id}/status`, payload: { state } });
    assert.equal(response.statusCode, 200, response.payload);
  }
  assert.equal(audit.at(-1).action, "read_completed");
  assert.equal(audit.at(-1).readerDeviceId, "browser");
  assert.equal(engine.get(id).state, "COMPLETED");
  assert.equal(new CommandEngine(db).get(id).sourceClientId, "browser", "reader identity survives engine restart");
  const deleted = await app.inject({ method: "DELETE", url: "/api/v1/linked-session", headers: { "x-test-token": own } });
  assert.equal(deleted.statusCode, 200);
  assert.match(deleted.headers["set-cookie"], /Max-Age=0/);
  assert.equal(sessions.resolve(own), null);
  assert.equal(sessions.resolve(secondSession), null);
  assert.ok(sessions.resolve(other));
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/linked-session", headers: { "x-test-token": own } })).statusCode, 401);
});

test("contact names match national, international and Persian digit numbers without changing messages", async () => {
  const { phoneKey, contactTitle, applyReadConfirmation, commandFeedback } = await import("../web/src/lib/inboxActions.ts");
  const names = new Map([[phoneKey("+989120000000"), "Test contact"]]);
  for (const number of ["09120000000", "+98 912 000 0000", "۰۰۹۸۹۱۲۰۰۰۰۰۰۰"]) {
    assert.equal(contactTitle({ title: number, preview: "synthetic" }, names).title, "Test contact");
  }
  const row = { lastSequence: 10, read: false, unreadCount: 2 };
  assert.equal(applyReadConfirmation(row, 10).unreadCount, 0);
  assert.equal(applyReadConfirmation({ ...row, lastSequence: 11 }, 10).unreadCount, 2);
  // The legacy simHelp() was removed from send gating; structured readiness
  // (deriveSendReadiness) now owns composer behaviour and is covered in
  // test/webComposerUi.test.js.
  assert.equal(typeof (await import("../web/src/lib/inboxActions.ts")).simHelp, "undefined",
    "simHelp must not come back as a send gate");
  assert.doesNotMatch(commandFeedback("SIM_STATE_UNAVAILABLE"), /SIM_STATE/);
});
