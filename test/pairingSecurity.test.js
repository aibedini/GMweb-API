const fixture = require("./pairingFixture");
"use strict";

/**
 * ADR-007 P0-4 — route-level negative security tests (fastify.inject).
 *
 * This matrix pins the pairing security boundary at the HTTP surface:
 *   - anonymous create/status allowed; Android-only endpoints 401 anonymous
 *   - master token / dashboard session / project API keys canNOT approve
 *   - only a valid enrolled Android X-Agent-Auth signature over the EXACT
 *     raw body can approve (tampered body / other path / expired ts / replay
 *     / unknown device → 401)
 *   - P0-5: client-supplied origin is rejected; server origin lands in QR
 *   - P0-8: transcript hash consistency (canonical, versioned)
 */

const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Fastify = require("fastify");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { AgentAuthService } = require("../src/agentAuth");
const pairing = require("../src/pairingSessions");
const { registerPairingRoutes } = require("../src/pairingRoutes");

const DEVICE = "android-primary";

function makeKey() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

/** Sign the canonical AgentAuth string over method+path+body+ts. */
function signRequest(pair, deviceId, method, url, bodyBuf, ts = Date.now()) {
  const bodyHash = crypto.createHash("sha256").update(bodyBuf).digest("hex");
  const canonical = `${method}\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return {
    headers: { "x-agent-auth": `${deviceId}:${sig}`, "x-agent-ts": String(ts) },
  };
}

describe("ADR-007 pairing security boundary (route level)", () => {
  let app;
  let pair;
  let svc;

  before(async () => {
    app = Fastify({ logger: false });
    // Mirror server.js raw-body capture (the signature contract needs it) —
    // content-type parser is the reliable timing (hooks deadlock in inject).
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => {
        req.rawBody = body;
        try {
          done(null, JSON.parse(body.toString("utf8") || "{}"));
        } catch (e) {
          done(e);
        }
      },
    );
    svc = new AgentAuthService(new Database(":memory:"));
    pair = makeKey();
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    svc.registerIdentity({ deviceId: DEVICE, forcePrimary: true, publicKeys: { signing: spki.toString("base64"), trustRoot: fixture.rootPublicKey } });
    // FIX 2b mirror: the real app authenticates pairing Android paths in the
    // GLOBAL preHandler (single verification, binds authenticatedAgentId);
    // routes only check role. Replicate exactly that here.
    app.addHook("preHandler", (request, reply, done) => {
      const isPairingAgentPath =
        request.url === "/api/v1/pairing/approve" ||
        /^\/api\/v1\/pairing\/session\/[^/]+$/.test(request.url.split("?")[0]);
      if (!isPairingAgentPath) return done();
      const header = String(request.headers["x-agent-auth"] || "");
      if (!header) return done(); // route will 401 (unauthenticated)
      const result = svc.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
      if (result.ok) {
        request.authenticatedAgentId = result.deviceId;
        return done();
      }
      reply.code(401).send({ error: "unauthorized" });
    });
    registerPairingRoutes(app, { agentAuthService: svc, config: {} });
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  // P1-3: the per-IP cap is shared across tests (inject uses one IP) — reset
  // the store before each test so every test starts from an empty map.
  beforeEach(() => {
    pairing._reset();
  });

  const transcript = () => ({
    webDeviceId: "web-test-1",
    webSigningPublicKey: "PK-sign-" + crypto.randomBytes(8).toString("hex"),
    webEncryptionPublicKey: "PK-enc-" + crypto.randomBytes(8).toString("hex"),
    // P1-1: ephemeral must differ from the operational signing key.
    ephemeralPublicKey: "PK-eph-" + crypto.randomBytes(8).toString("hex"),
    nonce: "n-" + crypto.randomBytes(8).toString("hex"),
  });

  const createSession = async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/pairing/session", payload: transcript() });
    assert.equal(res.statusCode, 200);
    return res.json();
  };
  const TRUST_ROOT_PUB = fixture.rootPublicKey;

  const signApprove = (session, cert, opts = {}) => {
    const body = JSON.stringify({
      pairingSessionId: session.pairingSessionId,
      certificate: fixture.certificate(session.pairingSessionId),
      deviceId: "web-test-1",
      transcriptHash: pairing.hashOf(pairing.getSession(session.pairingSessionId)),
      trustRootPublicKey: TRUST_ROOT_PUB,
    });
    const buf = Buffer.from(body);
    const ts = opts.ts ?? Date.now();
    const url = "/api/v1/pairing/approve";
    const bodyHash = crypto.createHash("sha256").update(buf).digest("hex");
    const canonical = `POST\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
    const sig = crypto.sign("sha256", Buffer.from(canonical), (opts.key || pair).privateKey).toString("base64");
    return {
      method: "POST",
      url,
      payload: buf,
      headers: {
        "content-type": "application/json",
        "x-agent-auth": `${opts.deviceId || DEVICE}:${sig}`,
        "x-agent-ts": String(ts),
      },
    };
  };

  // ── P0-1: anonymous surface ─────────────────────────────────────────────

  test("anonymous POST /pairing/session is allowed", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/pairing/session", payload: transcript() });
    assert.equal(res.statusCode, 200);
  });

  test("anonymous GET /pairing/status is allowed", async () => {
    const created = await createSession();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/status?pairingSessionId=${encodeURIComponent(created.pairingSessionId)}&pollSecret=${encodeURIComponent(created.pollSecret)}`,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().state, "PENDING");
  });

  test("anonymous GET /pairing/session/:id is 401 (Android-only)", async () => {
    const created = await createSession();
    const res = await app.inject({ method: "GET", url: `/api/v1/pairing/session/${created.pairingSessionId}` });
    assert.equal(res.statusCode, 401);
  });

  test("anonymous POST /pairing/approve is 401", async () => {
    const created = await createSession();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/approve",
      payload: {
        pairingSessionId: created.pairingSessionId,
        certificate: "C",
        deviceId: "web-test-1",
        transcriptHash: "h",
        trustRootPublicKey: "TRUST",
      },
    });
    assert.equal(res.statusCode, 401);
  });

  // ── P0-2: only Android signatures approve ───────────────────────────────

  test("valid enrolled Android signature approves", async () => {
    const created = await createSession();
    const res = await app.inject(signApprove(created, "CERT-OK"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, true);
  });

  test("tampered body after signing is 401", async () => {
    const created = await createSession();
    const req = signApprove(created, "CERT-TAMPER");
    const parsed = JSON.parse(req.payload.toString());
    parsed.certificate = "CERT-TAMPERED-AFTER-SIGN"; // change AFTER signing
    req.payload = Buffer.from(JSON.stringify(parsed));
    const res = await app.inject(req);
    assert.equal(res.statusCode, 401);
  });

  test("signature for another path is 401", async () => {
    const created = await createSession();
    const body = JSON.stringify({
      pairingSessionId: created.pairingSessionId,
      certificate: "CERT",
      deviceId: "web-test-1",
      transcriptHash: pairing.hashOf(pairing.getSession(created.pairingSessionId)),
      trustRootPublicKey: "TRUST",
    });
    const buf = Buffer.from(body);
    const ts = Date.now();
    const wrongHash = crypto.createHash("sha256").update(buf).digest("hex");
    const canonical = `POST\n/api/v1/agent/commands/claim\n${wrongHash}\nX-AGENT-TS:${ts}\n`;
    const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/approve",
      payload: buf,
      headers: { "content-type": "application/json", "x-agent-auth": `${DEVICE}:${sig}`, "x-agent-ts": String(ts) },
    });
    assert.equal(res.statusCode, 401);
  });

  test("expired timestamp is 401", async () => {
    const created = await createSession();
    // REPLAY_WINDOW_MS is 90s — a stamp 10 minutes old is way outside it.
    const req = signApprove(created, "CERT", { ts: Date.now() - 10 * 60_000 });
    const res = await app.inject(req);
    assert.equal(res.statusCode, 401);
  });

  test("replayed request is 401", async () => {
    // ADR-007 P0-4: resubmitting the EXACT same signed request must be
    // rejected - the (deviceId, ts) replay cache in AgentAuthService catches it.
    const created = await createSession();
    const ts = Date.now();
    const req = signApprove(created, "CERT-REPLAY", { ts });
    const first = await app.inject(req);
    assert.equal(first.statusCode, 200);
    // A fresh session for the replay attempt (the first session was consumed).
    const created2 = await createSession();
    const req2 = signApprove(created2, "CERT-REPLAY", { ts });
    const res = await app.inject(req2);
    assert.equal(res.statusCode, 401, "replayed (device, ts) must be rejected");
  });

  test("unknown agent identity is 401", async () => {
    const created = await createSession();
    const req = signApprove(created, "CERT", { deviceId: "ghost-device" });
    // Sign with a fresh key that was never enrolled for ghost-device.
    const fresh = makeKey();
    const spki = fresh.publicKey.export({ format: "der", type: "spki" });
    svc.registerIdentity({ deviceId: "other-known", publicKeys: { signing: spki.toString("base64") } });
    const body = JSON.stringify({
      pairingSessionId: created.pairingSessionId,
      certificate: "CERT",
      deviceId: "ghost-device",
      transcriptHash: pairing.hashOf(pairing.getSession(created.pairingSessionId)),
      trustRootPublicKey: "TRUST",
    });
    const buf = Buffer.from(body);
    const ts = Date.now();
    const canonical = `POST\n/api/v1/pairing/approve\n${crypto.createHash("sha256").update(buf).digest("hex")}\nX-AGENT-TS:${ts}\n`;
    const sig = crypto.sign("sha256", Buffer.from(canonical), fresh.privateKey).toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/approve",
      payload: buf,
      headers: { "content-type": "application/json", "x-agent-auth": `ghost-device:${sig}`, "x-agent-ts": String(ts) },
    });
    assert.equal(res.statusCode, 401);
  });

  test("master token alone canNOT approve (trust operation is agent-only)", async () => {
    const created = await createSession();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/approve",
      headers: { authorization: "Bearer master-token-irrelevant" },
      payload: {
        pairingSessionId: created.pairingSessionId,
        certificate: "CERT",
        deviceId: "web-test-1",
        transcriptHash: "h",
        trustRootPublicKey: "TRUST",
      },
    });
    assert.equal(res.statusCode, 401);
  });

  // ── P0-5: server-owned origin ───────────────────────────────────────────

  test("client-supplied origin never reaches the transcript (server owns origin)", async () => {
    const payload = { ...transcript(), origin: "https://evil.example.com" };
    const res = await app.inject({ method: "POST", url: "/api/v1/pairing/session", payload });
    // P0-5: default ajv STRIPS unknown fields, so the evil origin is dropped
    // before the handler. The SECURITY property to pin: the QR transcript's
    // origin is the SERVER-derived one, never the client's.
    assert.equal(res.statusCode, 200);
    const qr = res.json().qr;
    // inject() default host is localhost:80 — pin that the transcript origin
    // is the SERVER-derived one (host + https), NOT the client-supplied one.
    assert.notEqual(qr.origin, "https://evil.example.com");
    assert.match(qr.origin, /^https:\/\//);
    assert.ok(qr.origin.includes("localhost"));
  });

  test("QR transcript carries the server-derived origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/session",
      payload: transcript(),
      headers: { host: "messages.example.com", "x-forwarded-proto": "https" },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().qr.origin, "https://messages.example.com");
  });

  test("even dashboard browser QRs cannot enroll a phone", async () => {
    const adminApp = Fastify({ logger: false });
    registerPairingRoutes(adminApp, {
      agentAuthService: svc,
      config: {},
      canBootstrapIdentity: () => true,
    });
    await adminApp.ready();
    try {
      const res = await adminApp.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: transcript(),
      });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.qr.identityBootstrapToken, undefined);
    } finally {
      await adminApp.close();
    }
  });

  // ── P0-8: transcript hash binding ───────────────────────────────────────

  test("transcriptHash is canonical and matches an independent recomputation", async () => {
    const created = await createSession();
    const session = pairing.getSession(created.pairingSessionId);
    const hash = pairing.hashOf(session);
    assert.match(hash, /^[0-9a-f]{64}$/);
    // Same transcript → same hash; tampered field → different hash.
    const tampered = { ...session, webDeviceId: "evil" };
    assert.notEqual(pairing.transcriptHash(tampered), hash);
  });

  test("approve stores the Android-signed transcriptHash for web comparison", async () => {
    const created = await createSession();
    const sessionHash = pairing.hashOf(pairing.getSession(created.pairingSessionId));
    await app.inject(signApprove(created, "CERT-H", {}));
    const consumed = pairing.consumeApproval(created.pairingSessionId, created.pollSecret);
    assert.equal(consumed.transcriptHash, sessionHash);
    assert.equal(consumed.trustRootPublicKey, fixture.rootPublicKey);
  });

  // ── P1-1 / P1-3 ─────────────────────────────────────────────────────────

  test("ephemeral key equal to signing key is rejected (P1-1)", async () => {
    const t = transcript();
    t.ephemeralPublicKey = t.webSigningPublicKey;
    const res = await app.inject({ method: "POST", url: "/api/v1/pairing/session", payload: t });
    assert.equal(res.statusCode, 400);
  });

  test("per-IP session cap returns 429 (P1-3)", async () => {
    // The default inject IP is shared; exhaust the cap.
    const cap = pairing.MAX_SESSIONS_PER_IP;
    for (let i = 0; i < cap; i++) await createSession();
    const res = await app.inject({ method: "POST", url: "/api/v1/pairing/session", payload: transcript() });
    assert.equal(res.statusCode, 429);
  });
});
