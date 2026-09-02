// E2E test: complete flow — approve → challenge → browser signature →
// linked session cookie → capability-scoped access.
process.env.NODE_ENV = "test";
process.env.DASHBOARD_ENABLED = "false";
process.env.GMWEB_API_TOKEN = "test-master-token";
process.env.PUBLIC_WEB_ORIGIN = "https://gmweb.example";

const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const Fastify = require("fastify");

// Pure pairing service (no redis).
const pairing = require("../src/pairingSessions");
const linkedSessions = require("../src/linkedSessions");
const { registerPairingRoutes } = require("../src/pairingRoutes");

function makeKey() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function sign(priv, data) {
  return crypto.sign("sha256", data, priv).toString("base64");
}

test("complete: challenge signature issues HttpOnly linked session with capability scope", async () => {
  const app = Fastify({ logger: false });
  await app.register(require("@fastify/cookie"));
  registerPairingRoutes(app, { publicWebOrigin: "https://gmweb.example" });

  // Simple gate to satisfy the approve route's agent auth requirement:
  // reuse the same composition trick as the E2E composition test.
  app.decorate("agentAuthService", null);
  // The approve route calls requireAgentSignature — for this test we focus
  // on /complete by building a session through the service directly.

  // 1. Create a session (like POST /pairing/session does).
  const created = pairing.createSession({
    version: 1, pairingSessionId: "ps-complete-1", webDeviceId: "web-c-1",
    webSigningPublicKey: "d2Vi", webEncryptionPublicKey: "d2Vi",
    ephemeralPublicKey: "ZXA=", nonce: "bmMgY2hhbGxlbmdl",
    expiresAt: Date.now() + 60000,
  }, { ip: "203.0.113.9", origin: "https://gmweb.example" });
  const ps = created.pairingSessionId || created.sessionId || created.id;
  const pollSecret = created.pollSecret;

  // 2. Approve it (as the Android agent service would, post-gate).
  pairing.approveSession(ps, {
    certificate: JSON.stringify({
      deviceId: "web-c-1",
      signingPublicKey: certPub,
      capabilities: ["READ_MESSAGES", "SEND_MESSAGES"],
    }),
    deviceId: "web-c-1",
    transcriptHash: "aa".repeat(32),
    trustRootPublicKey: "dHJ1c3Q=",
  });

  // 2b. Web consumes the certificate (normal flow) — the challenge must
  // SURVIVE consumption for the later /complete exchange.
  const consumed = pairing.consumeApproval(ps, pollSecret);
  assert.ok(consumed, "approval consumed");
  const taken = pairing.peekChallenge(pollSecret);
  assert.ok(taken && taken.challenge, "challenge survives consumption");

  // 4. Browser signs the canonical challenge with its private key.
  const canonical = pairing.challengeCanonical(
    taken.deviceId, taken.challenge, "https://gmweb.example", taken.issuedAt
  );
  const signature = sign(browserKeys.privateKey, canonical);

  // 5. POST /complete.
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/pairing/complete",
    payload: {
      pairingSessionId: ps, pollSecret, deviceId: taken.deviceId,
      challenge: taken.challenge, signature,
      certificate: taken.certificate,
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const setCookie = res.cookies.find((c) => c.name === linkedSessions.COOKIE_NAME);
  assert.ok(setCookie, "session cookie set");
  assert.equal(setCookie.httpOnly, true);
  assert.equal(setCookie.sameSite, "Strict");
  assert.equal(setCookie.secure, true);

  // 6. Session resolves with capability scope.
  const session = linkedSessions.resolve(setCookie.value);
  assert.ok(session);
  assert.deepEqual(session.capabilities.sort(), ["READ_MESSAGES", "SEND_MESSAGES"]);
  // 7. Challenge is single-use: a second complete burns nothing → 409.
  const res2 = await app.inject({
    method: "POST", url: "/api/v1/pairing/complete",
    payload: {
      pairingSessionId: ps, pollSecret, deviceId: taken.deviceId,
      challenge: taken.challenge, signature,
      certificate: taken.certificate,
    },
  });
  assert.ok([401, 409].includes(res2.statusCode), res2.body); // single-use enforced
});

// Browser keypair (operational signing key bound in the certificate).
const browserKeys = makeKey();
const spki = browserKeys.publicKey.export({ format: "der", type: "spki" });
const certPub = spki.toString("base64");
