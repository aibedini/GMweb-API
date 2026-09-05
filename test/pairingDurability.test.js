const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { configure, db } = require("../src/pairingDb");
const pairing = require("../src/pairingSessions");
const linked = require("../src/linkedSessions");
const { TrustRegistry } = require("../src/trustRegistry");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const Fastify = require("fastify");

test("revocation HTTP route atomically clears sessions and unredeemed approvals", async t => {
  const database = new Database(":memory:");
  configure(database);
  const registry = new TrustRegistry(database);
  const app = Fastify();
  registerControlPlaneRoutes(app, { trustRegistry: registry, commandEngine: {}, eventStore: {},
    accountId: "default", authorizeAgent: () => ({ role: "PRIMARY_TRUST_AGENT" }), linkedSessions: linked });
  t.after(async () => { await app.close(); database.close(); configure(new Database(":memory:")); });
  const created = pairing.createSession({ webDeviceId: "web", webSigningPublicKey: "s",
    webEncryptionPublicKey: "e", ephemeralPublicKey: "p", nonce: "n" }, { ip: "ip", origin: "https://web.example" });
  pairing.approveSession(created.pairingSessionId, { certificate: "signed", deviceId: "web" });
  pairing.consumeApproval(created.pairingSessionId, created.pollSecret);
  const token = linked.issue("web", ["READ_MESSAGES"]);
  const result = await app.inject({ method: "POST", url: "/api/v1/agent/trust/statements", payload: {
    statementId: "revoke-1", trustSequence: 1, operation: "DEVICE_REVOKED", deviceId: "web", rootSignature: "signature" } });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().applied, true);
  assert.equal(linked.resolve(token), null);
  assert.equal(pairing.peekChallenge(created.pollSecret), null);
});

test("expired parked challenges cannot be consumed, and certificate expiry bounds linked session", () => {
  configure(new Database(":memory:"));
  const created = pairing.createSession({ webDeviceId: "web", webSigningPublicKey: "s",
    webEncryptionPublicKey: "e", ephemeralPublicKey: "p", nonce: "n" }, { ip: "ip", origin: "https://web.example" });
  pairing.approveSession(created.pairingSessionId, { certificate: "signed", deviceId: "web" });
  pairing.consumeApproval(created.pairingSessionId, created.pollSecret);
  db().prepare("UPDATE pairing_challenges SET expires_at = ?").run(Date.now() - 1);
  assert.equal(pairing.burnChallenge(created.pollSecret), false);
  assert.equal(pairing.peekChallenge(created.pollSecret), null);
  const token = linked.issue("web", ["READ_MESSAGES"], 7, Date.now() - 1);
  assert.equal(linked.resolve(token), null);
});
