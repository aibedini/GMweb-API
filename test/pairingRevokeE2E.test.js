"use strict";
// Phase 2 — Issue 6 end-to-end revocation test (server contract):
//   1. Android Primary (phone) approves a browser pairing → linked cookie.
//   2. Phone posts DEVICE_REVOKED through /api/v1/agent/trust/statements.
//   3. The linked session dies (cookie no longer resolves).
//   4. GET /api/v1/trust/revoked-devices lists the device.
//   5. The browser's next /api/v1/sync is rejected (401/403).
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const fixture = require("./pairingFixture");
const pairing = require("../src/pairingSessions");
const linkedSessions = require("../src/linkedSessions");
const pairingGate = require("../src/pairingGate");
const { AgentAuthService } = require("../src/agentAuth");
const { registerPairingRoutes } = require("../src/pairingRoutes");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");

const PHONE = "phone-primary";
const WEB = "web-e2e-revoke";
const spki = (pair) => pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const keyPair = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function agentHeaders(pair, method, url, rawBody, ts = Date.now()) {
  const canonical = `${method}\n${url}\n${crypto.createHash("sha256").update(rawBody).digest("hex")}\nX-AGENT-TS:${ts}\n`;
  const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return { "content-type": "application/json", "x-agent-auth": `${PHONE}:${sig}`, "x-agent-ts": String(ts) };
}

describe("pairingRevokeE2E", () => {
  let app;
  let svc;
  let db;
  let phone;
  let browser;

  before(async () => {
    app = Fastify({ logger: false });
    await app.register(require("@fastify/cookie"));
    const defaultParser = app.getDefaultJsonParser("error", "error");
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      req.rawBody = Buffer.from(String(body || ""), "utf8");
      defaultParser(req, body, done);
    });

    db = new Database(":memory:");
    require("../src/pairingDb").configure(db);
    svc = new AgentAuthService(db);
    phone = keyPair();
    browser = keyPair();
    svc.registerIdentity({
      deviceId: PHONE,
      forcePrimary: true,
      publicKeys: { signing: spki(phone), trustRoot: fixture.rootPublicKey },
    });

    app.addHook("preHandler", (request, reply, done) => {
      pairingGate(svc, request, reply, done);
    });
    // Minimal replication of the server.js requireToken linked-cookie gate so
    // the "revoked browser cannot /sync" contract is asserted at the HTTP level.
    app.addHook("preHandler", (request, reply, done) => {
      const path = String(request.url || "").split("?")[0];
      const isSync = request.method === "GET" && path === "/api/v1/sync";
      const isRevoked = request.method === "GET" && path === "/api/v1/trust/revoked-devices";
      if (!isSync && !isRevoked) return done();
      if (request.headers["x-master-token"] === "test-master") return done();
      const token = request.cookies ? request.cookies[linkedSessions.COOKIE_NAME] : "";
      if (!linkedSessions.resolve(token)) {
        reply.code(401).send({ error: "unauthorized", reason: "linked_session_required" });
        return;
      }
      return done();
    });

    registerPairingRoutes(app, { agentAuthService: svc, config: {} });
    registerControlPlaneRoutes(app, {
      trustRegistry: new TrustRegistry(db),
      commandEngine: new CommandEngine(db),
      eventStore: new EventStore(db),
      accountId: "default",
      linkedSessions,
      authorizeAgent: (request) => {
        const auth = svc.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
        return auth.ok ? { deviceId: auth.deviceId, role: svc.getRole(auth.deviceId) } : null;
      },
    });
    await app.ready();
  });

  after(async () => {
    await app.close();
    db.close();
  });

  test("approve → linked cookie → DEVICE_REVOKED → session dead, endpoint lists it, /sync rejected", async () => {
    pairing._reset();
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: WEB,
          webSigningPublicKey: spki(browser),
          webEncryptionPublicKey: spki(keyPair()),
          ephemeralPublicKey: spki(keyPair()),
          nonce: "nonce-revoke",
        },
      })
    ).json();
    const certificateJson = fixture.certificate(created.pairingSessionId);

    const approveBody = JSON.stringify({
      pairingSessionId: created.pairingSessionId,
      certificate: certificateJson,
      deviceId: WEB,
      transcriptHash: pairing.hashOf(pairing.getSession(created.pairingSessionId)),
      trustRootPublicKey: fixture.rootPublicKey,
    });
    const approveUrl = "/api/v1/pairing/approve";
    const approveRes = await app.inject({
      method: "POST", url: approveUrl, payload: approveBody,
      headers: agentHeaders(phone, "POST", approveUrl, approveBody),
    });
    assert.equal(approveRes.statusCode, 200, approveRes.payload);

    // Web consumes the approval (POST /approve → GET /status burns it into a challenge).
    const statusRes = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/status?pairingSessionId=${encodeURIComponent(created.pairingSessionId)}&pollSecret=${encodeURIComponent(created.pollSecret)}`,
    });
    assert.equal(statusRes.statusCode, 200, statusRes.payload);
    assert.equal(statusRes.json().state, "APPROVED");

    const challenge = pairing.peekChallenge(created.pollSecret);
    const challengeSignature = crypto.sign(
      "sha256",
      pairing.challengeCanonical(WEB, challenge.challenge, challenge.webOrigin, challenge.issuedAt,
        created.pairingSessionId, challenge.apiOrigin),
      { key: browser.privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64");
    const complete = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/complete",
      payload: {
        pairingSessionId: created.pairingSessionId,
        pollSecret: created.pollSecret,
        deviceId: WEB,
        challenge: challenge.challenge,
        signature: challengeSignature,
        certificate: certificateJson,
      },
    });
    assert.equal(complete.statusCode, 200, complete.payload);
    const cookie = complete.cookies.find((c) => c.name === linkedSessions.COOKIE_NAME);
    assert.ok(cookie, "linked session cookie must be issued");
    assert.ok(linkedSessions.resolve(cookie.value), "session live before revocation");

    // Sync is allowed while the session is live.
    const syncBefore = await app.inject({
      method: "GET", url: "/api/v1/sync",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.ok([200, 204].includes(syncBefore.statusCode), `sync before revoke: ${syncBefore.statusCode}`);

    // Phone revokes the browser (DEVICE_REVOKED trust statement, seq 1).
    const statement = {
      statementId: crypto.randomUUID(),
      operation: "DEVICE_REVOKED",
      deviceId: WEB,
      accountId: "default",
      trustSequence: 1,
      issuedAt: Date.now(),
    };
    const canonicalStatement = JSON.stringify(statement);
    statement.rootSignature = crypto.sign("sha256", Buffer.from(canonicalStatement), fixture.root.privateKey).toString("base64");

    const revokeBody = JSON.stringify({ statement });
    const revokeUrl = "/api/v1/agent/trust/statements";
    const revoke = await app.inject({
      method: "POST", url: revokeUrl, payload: revokeBody,
      headers: agentHeaders(phone, "POST", revokeUrl, revokeBody),
    });
    assert.equal(revoke.statusCode, 200, revoke.payload);
    assert.equal(revoke.json().applied, true);

    // 1) Session is dead.
    assert.equal(linkedSessions.resolve(cookie.value), null, "linked session must be revoked");
    // 2) Browser probe returns authenticated:false.
    const probe = await app.inject({
      method: "GET", url: "/api/v1/linked-session",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(probe.json().authenticated, false);
    // 3) Revoked-devices endpoint: dead linked cookie is 401 (auth matrix);
    //    the master path lists the device.
    const revokedDeadCookie = await app.inject({
      method: "GET", url: "/api/v1/trust/revoked-devices",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.equal(revokedDeadCookie.statusCode, 401, revokedDeadCookie.payload);
    const revoked = await app.inject({
      method: "GET", url: "/api/v1/trust/revoked-devices",
      headers: { "x-master-token": "test-master" },
    });
    assert.equal(revoked.statusCode, 200, revoked.payload);
    assert.deepEqual(
      revoked.json().revoked.map((r) => ({ deviceId: r.deviceId, reason: r.reason })),
      [{ deviceId: WEB, reason: "DEVICE_REVOKED" }],
    );
    // 4) The revoked browser's next /sync is rejected.
    const syncAfter = await app.inject({
      method: "GET", url: "/api/v1/sync",
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.ok([401, 403].includes(syncAfter.statusCode), `sync after revoke: ${syncAfter.statusCode}`);
  });
});

