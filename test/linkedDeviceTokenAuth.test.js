"use strict";

/**
 * XR-GA-008 / `xr-ga-008-device-token` — device-token transport tests.
 *
 * These exercise the REAL authorization decision (`src/linkedDeviceAuth.js`,
 * the module server.js delegates its linked-session branch to) and the REAL
 * routes (`pairingRoutes`, `controlPlaneRoutes`) against an in-memory control
 * plane. server.js itself is not required here because loading it opens the
 * production control-plane DB and BullMQ sockets; its linked-session branch is
 * a two-line call to the module under test.
 *
 * The harness below mirrors the ONE remaining production rule these paths
 * depend on: after the linked-device gate declines to handle a request, only a
 * master Bearer token is accepted. A `Device` header is consumed by the gate in
 * every case (valid, invalid or out of scope), so it can never reach that
 * fallback.
 */

process.env.NODE_ENV = "test";
process.env.DASHBOARD_ENABLED = "false";
process.env.GMWEB_API_TOKEN = "test-master-token";
process.env.PUBLIC_WEB_ORIGIN = "https://gmweb.example";
process.env.PUBLIC_API_ORIGIN = "https://api.example";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const Database = require("better-sqlite3");

const { configure } = require("../src/pairingDb");
const pairing = require("../src/pairingSessions");
const linkedSessions = require("../src/linkedSessions");
const { registerPairingRoutes } = require("../src/pairingRoutes");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const { EventStore } = require("../src/eventStore");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { AndroidOutbox } = require("../src/androidOutbox");
const { registerGatewayRoutes } = require("../src/gatewayRoutes");
const { AI_AGENT, WEB_PWA } = require("../src/devicePolicy");
const {
  authorizeLinkedSession,
  deviceTokenFromAuthorization,
  linkedSessionPathAllowed,
} = require("../src/linkedDeviceAuth");

const ACCOUNT = "account-token";
const MASTER = "test-master-token";
const AI_CAPS = Object.freeze(["READ_MESSAGES", "AI_SUGGEST"]);
const WEB_CAPS = Object.freeze(["READ_MESSAGES", "SEND_MESSAGES"]);
const COOKIE = linkedSessions.COOKIE_NAME;

const browserKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const signingPublicKey = browserKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64");

let db;
beforeEach(() => {
  db = new Database(":memory:");
  configure(db);
  pairing._reset();
});
afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
});

function logCapture() {
  const lines = [];
  return { lines, stream: { write(chunk) { lines.push(String(chunk)); } } };
}

async function makePairingApp({ loggerStream } = {}) {
  const app = Fastify(loggerStream
    ? { logger: { level: "info", stream: loggerStream } }
    : { logger: false });
  // Mirrors server.js: routes opt in via config.rateLimit and the plugin is
  // registered with global:false. Keeps the in-process app on the production
  // contract (and visible to static analysis) without throttling tests.
  app.register(require("@fastify/rate-limit"), { global: false });
  await app.register(require("@fastify/cookie"));
  registerPairingRoutes(app, {
    agentAuthService: {
      listIdentities: () => [],
      getRole: () => null,
      getIdentity: () => null,
    },
    config: {
      publicWebOrigin: "https://gmweb.example",
      publicApiOrigin: "https://api.example",
    },
  });
  await app.ready();
  return app;
}

async function makeLinkedApp({ loggerStream } = {}) {
  const eventStore = new EventStore(db);
  const app = Fastify(loggerStream
    ? { logger: { level: "info", stream: loggerStream } }
    : { logger: false });
  // Same opt-in-only rate limiter as server.js (see makePairingApp).
  app.register(require("@fastify/rate-limit"), { global: false });
  await app.register(require("@fastify/cookie"));
  app.addHook("preHandler", (request, reply, done) => {
    const access = authorizeLinkedSession(request, reply);
    if (access === "denied") return;
    if (access === "allowed") return done();
    // server.js continues with the normal auth ladder after "none". For the
    // linked-device paths that can only be the master Bearer token; project
    // API keys / admin sessions are not part of this harness.
    if (String(request.headers.authorization || "") === `Bearer ${MASTER}`) return done();
    reply.code(401).send({ error: "unauthorized" });
  });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db),
    commandEngine: new CommandEngine(db),
    eventStore,
    accountId: ACCOUNT,
    authorizeAgent: () => null,
    checkRateLimit: () => ({ allowed: true, retryAfterSeconds: 1 }),
  });
  // Present so the device-token gate is exercised against a real /gateway
  // route; its own key check must never be reached with a Device header.
  registerGatewayRoutes(app, {
    outbox: new AndroidOutbox(),
    checkDeviceKey: () => false,
    isPullModeActive: () => false,
  });
  await app.ready();
  return { app, eventStore };
}

/**
 * Drive the real pairing flow up to a signed /complete request. The certificate
 * is what Android would sign; only the link-session challenge signature is
 * verified by /complete.
 */
function prepareComplete({ deviceType, deviceId, capabilities }) {
  pairing._reset();
  const created = pairing.createSession({
    version: 1,
    pairingSessionId: `ps-${deviceId}`,
    webDeviceId: deviceId,
    webSigningPublicKey: "d2ViLXNpZ25pbmc=",
    webEncryptionPublicKey: "d2ViLWVuY3J5cHRpb24=",
    ephemeralPublicKey: "ZXBoZW1lcmFs",
    nonce: "bm9uY2U=",
    deviceType,
  }, { ip: "203.0.113.9", origin: "https://gmweb.example", apiOrigin: "https://api.example" });
  const ps = created.pairingSessionId;
  const pollSecret = created.pollSecret;
  pairing.approveSession(ps, {
    certificate: JSON.stringify({
      protocol: "GMweb-Pairing-v1",
      accountId: "default",
      deviceId,
      deviceType,
      signingPublicKey,
      encryptionPublicKey: "d2ViLWVuY3J5cHRpb24=",
      capabilities,
      historyGrant: deviceType === AI_AGENT ? "FROM_NOW_ON" : "FULL_HISTORY",
      trustSequence: 1,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 86400000,
      pairingSessionId: ps,
    }),
    deviceId,
    transcriptHash: "aa".repeat(32),
    trustRootPublicKey: "dHJ1c3Q=",
  });
  pairing.consumeApproval(ps, pollSecret);
  const taken = pairing.peekChallenge(pollSecret);
  assert.ok(taken, "challenge parked");
  const canonical = pairing.challengeCanonical(
    taken.deviceId, taken.challenge, taken.webOrigin, taken.issuedAt, ps, taken.apiOrigin
  );
  const signature = crypto.sign("sha256", canonical, {
    key: browserKeys.privateKey, dsaEncoding: "ieee-p1363",
  }).toString("base64");
  return {
    ps,
    pollSecret,
    payload: {
      pairingSessionId: ps,
      pollSecret,
      deviceId: taken.deviceId,
      challenge: taken.challenge,
      signature,
      certificate: taken.certificate,
    },
  };
}

function seedGrant(eventStore, deviceId, tag) {
  const result = eventStore.ingestBatch({
    accountId: ACCOUNT,
    sourceDeviceId: "primary-phone",
    events: [{
      eventId: `grant-${tag}-${deviceId}`,
      type: "KEY_GRANT",
      conversationId: `thread-${tag}`,
      payload: Buffer.from(JSON.stringify({ deviceId, wrapped: "opaque", tag })),
      encoding: "envelope.v1",
      schemaVersion: 1,
      cryptoVersion: 1,
    }],
  });
  assert.equal(result.results[0].status, "ACCEPTED");
}

function issueToken(deviceId, capabilities, deviceType = AI_AGENT, expiresAt = Date.now() + 86400000) {
  return linkedSessions.issue(deviceId, capabilities, 1, expiresAt, deviceType);
}

function deviceHeader(token) {
  return { authorization: `Device ${token}` };
}

function cookieHeader(token) {
  return { cookie: `${COOKIE}=${token}` };
}

describe("pairing completion token issuance", () => {
  test("AI_AGENT complete returns the session token, sets no cookie, and resolves to that device", async () => {
    const capture = logCapture();
    const app = await makePairingApp({ loggerStream: capture.stream });
    try {
      const { payload } = prepareComplete({
        deviceType: AI_AGENT, deviceId: "ai-token-1", capabilities: [...AI_CAPS],
      });
      const res = await app.inject({ method: "POST", url: "/api/v1/pairing/complete", payload });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.ok, true);
      assert.equal(body.deviceId, "ai-token-1");
      assert.equal(body.deviceType, AI_AGENT);
      assert.deepEqual([...body.capabilities].sort(), ["AI_SUGGEST", "READ_MESSAGES"]);
      assert.match(body.token, /^[0-9a-f]{64}$/, "token is a random 32-byte hex credential");
      assert.equal(res.cookies.find((cookie) => cookie.name === COOKIE), undefined,
        "an AI_AGENT native client must not receive a browser cookie");

      const session = linkedSessions.resolve(body.token);
      assert.ok(session, "the returned token resolves");
      assert.equal(session.deviceId, "ai-token-1");
      assert.equal(session.deviceType, AI_AGENT);
      assert.deepEqual([...session.capabilities].sort(), ["AI_SUGGEST", "READ_MESSAGES"]);

      // The raw token is never persisted (registry stores only the hash) and
      // never appears in a log line.
      const serialized = JSON.stringify(db.prepare("SELECT * FROM linked_sessions").all());
      assert.equal(serialized.includes(body.token), false, "raw token must not be stored");
      assert.equal(db.prepare("SELECT token_hash FROM linked_sessions WHERE device_id = ?")
        .get("ai-token-1").token_hash,
      crypto.createHash("sha256").update(body.token).digest("hex"));
      assert.equal(capture.lines.join("\n").includes(body.token), false, "token must not be logged");
    } finally {
      linkedSessions.revokeDevice("ai-token-1");
      await app.close();
    }
  });

  test("WEB_PWA complete returns no token and keeps the HttpOnly Secure Strict cookie", async () => {
    const app = await makePairingApp();
    try {
      const { payload } = prepareComplete({
        deviceType: WEB_PWA, deviceId: "web-token-1", capabilities: [...WEB_CAPS],
      });
      const res = await app.inject({ method: "POST", url: "/api/v1/pairing/complete", payload });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal("token" in body, false, "browser completions must never receive the token");
      const setCookie = res.cookies.find((cookie) => cookie.name === COOKIE);
      assert.ok(setCookie, "WEB_PWA still gets the linked-session cookie");
      assert.equal(setCookie.httpOnly, true);
      assert.equal(setCookie.sameSite, "Strict");
      assert.equal(setCookie.secure, true);
      const session = linkedSessions.resolve(setCookie.value);
      assert.equal(session.deviceId, "web-token-1");
      assert.equal(session.deviceType, WEB_PWA);
      assert.deepEqual([...session.capabilities].sort(), ["READ_MESSAGES", "SEND_MESSAGES"]);
    } finally {
      linkedSessions.revokeDevice("web-token-1");
      await app.close();
    }
  });

  test("the token permits only an AI_AGENT capability set (registration is unchanged)", async () => {
    assert.throws(
      () => issueToken("ai-bad", ["READ_MESSAGES", "SEND_MESSAGES"]),
      (error) => error.code === "device_registration_rejected",
    );
  });
});

describe("Authorization: Device <token> on the linked-device read path", () => {
  test("parses only the Device scheme (Bearer keeps the normal auth ladder)", () => {
    assert.equal(deviceTokenFromAuthorization("Device abc123"), "abc123");
    assert.equal(deviceTokenFromAuthorization("device abc123"), "abc123");
    assert.equal(deviceTokenFromAuthorization("Device    abc123  "), "abc123");
    assert.equal(deviceTokenFromAuthorization("Bearer abc123"), null);
    assert.equal(deviceTokenFromAuthorization("Basic abc123"), null);
    assert.equal(deviceTokenFromAuthorization("Device"), "");
    assert.equal(deviceTokenFromAuthorization("Device    "), "");
    assert.equal(deviceTokenFromAuthorization(""), null);
    assert.equal(deviceTokenFromAuthorization(undefined), null);
  });

  test("GET key-grants, GET sync and POST sync/ack work with a device token", async () => {
    const capture = logCapture();
    const { app, eventStore } = await makeLinkedApp({ loggerStream: capture.stream });
    const tokenA = issueToken("ai-a", [...AI_CAPS]);
    try {
      seedGrant(eventStore, "ai-a", "a");
      const headers = deviceHeader(tokenA);

      const grants = await app.inject({ method: "GET", url: "/api/v1/linked-device/key-grants?after=0", headers });
      assert.equal(grants.statusCode, 200, grants.body);
      assert.ok(grants.json().events.length > 0);
      assert.ok(grants.json().events.every((event) =>
        JSON.parse(Buffer.from(event.ciphertext, "base64")).deviceId === "ai-a"));

      const sync = await app.inject({ method: "GET", url: "/api/v1/sync?after=0&limit=100", headers });
      assert.equal(sync.statusCode, 200, sync.body);
      assert.ok(sync.json().events.length > 0);

      const ack = await app.inject({
        method: "POST", url: "/api/v1/sync/ack", headers,
        payload: { device_id: "ai-a", sync_event_ids: ["evt-1", "evt-2"] },
      });
      assert.equal(ack.statusCode, 200, ack.body);
      assert.deepEqual(ack.json(), { ok: true, accepted: 2, durable: false });

      // Presence is observed with the token HASH, never the raw credential.
      const presenceRows = db.prepare("SELECT * FROM linked_session_presence").all();
      assert.equal(presenceRows.length, 1);
      assert.equal(presenceRows[0].token_hash,
        crypto.createHash("sha256").update(tokenA).digest("hex"));
      assert.equal(JSON.stringify(presenceRows).includes(tokenA), false);
      assert.equal(capture.lines.join("\n").includes(tokenA), false, "token must not be logged");
    } finally {
      linkedSessions.revokeDevice("ai-a");
      await app.close();
    }
  });

  test("device A cannot read device B's grants and cannot acknowledge as B", async () => {
    const { app, eventStore } = await makeLinkedApp();
    const tokenA = issueToken("ai-a", [...AI_CAPS]);
    const tokenB = issueToken("ai-b", [...AI_CAPS]);
    try {
      seedGrant(eventStore, "ai-a", "a");
      seedGrant(eventStore, "ai-b", "b");

      const own = await app.inject({
        method: "GET", url: "/api/v1/linked-device/key-grants?after=0", headers: deviceHeader(tokenA),
      });
      assert.equal(own.statusCode, 200, own.body);
      const ownDeviceIds = own.json().events.map((event) =>
        JSON.parse(Buffer.from(event.ciphertext, "base64")).deviceId);
      assert.ok(ownDeviceIds.length > 0);
      assert.equal(ownDeviceIds.includes("ai-b"), false, "device B grants must not leak to A");
      assert.equal(ownDeviceIds.every((id) => id === "ai-a"), true);

      // A query parameter can never select another device.
      const queryParam = await app.inject({
        method: "GET",
        url: "/api/v1/linked-device/key-grants?after=0&device_id=ai-b&deviceId=ai-b",
        headers: deviceHeader(tokenA),
      });
      assert.equal(queryParam.statusCode, 200, queryParam.body);
      assert.deepEqual(queryParam.json(), own.json());

      // Sync is the account-scoped replica page; a query parameter must not
      // change its scope, and ack binds to the session device.
      const syncPlain = await app.inject({
        method: "GET", url: "/api/v1/sync?after=0&limit=100", headers: deviceHeader(tokenA),
      });
      const syncWithParam = await app.inject({
        method: "GET", url: "/api/v1/sync?after=0&limit=100&device_id=ai-b", headers: deviceHeader(tokenA),
      });
      assert.equal(syncPlain.statusCode, 200);
      assert.equal(syncWithParam.statusCode, 200);
      assert.deepEqual(syncWithParam.json(), syncPlain.json());

      const ackAsB = await app.inject({
        method: "POST", url: "/api/v1/sync/ack", headers: deviceHeader(tokenA),
        payload: { device_id: "ai-b", sync_event_ids: ["evt-b"] },
      });
      assert.equal(ackAsB.statusCode, 403, ackAsB.body);
      assert.equal(ackAsB.json().error, "device_mismatch");

      // B's own token still reads only B.
      const bGrants = await app.inject({
        method: "GET", url: "/api/v1/linked-device/key-grants?after=0", headers: deviceHeader(tokenB),
      });
      assert.equal(bGrants.statusCode, 200);
      assert.ok(bGrants.json().events.every((event) =>
        JSON.parse(Buffer.from(event.ciphertext, "base64")).deviceId === "ai-b"));
    } finally {
      linkedSessions.revokeDevice("ai-a");
      linkedSessions.revokeDevice("ai-b");
      await app.close();
    }
  });

  test("missing, invalid, expired and revoked tokens are 401 invalid_device_token", async () => {
    const { app } = await makeLinkedApp();
    const active = issueToken("ai-active", [...AI_CAPS]);
    const expired = issueToken("ai-expired", [...AI_CAPS], AI_AGENT, Date.now() - 60_000);
    const revoked = issueToken("ai-revoked", [...AI_CAPS]);
    linkedSessions.revokeDevice("ai-revoked");
    const invalid = crypto.randomBytes(32).toString("hex");
    try {
      for (const url of ["/api/v1/linked-device/key-grants", "/api/v1/sync", "/api/v1/linked-device/keyring"]) {
        const missing = await app.inject({ method: "GET", url });
        assert.equal(missing.statusCode, 401, `${url} without a credential must be 401`);
        for (const [label, token] of [["invalid", invalid], ["expired", expired], ["revoked", revoked]]) {
          const res = await app.inject({ method: "GET", url, headers: deviceHeader(token) });
          assert.equal(res.statusCode, 401, `${label} token on ${url}: ${res.body}`);
          assert.equal(res.json().error, "invalid_device_token", `${label} token on ${url}`);
        }
      }
      const ack = await app.inject({
        method: "POST", url: "/api/v1/sync/ack",
        headers: deviceHeader(invalid), payload: { sync_event_ids: ["x"] },
      });
      assert.equal(ack.statusCode, 401);
      assert.equal(ack.json().error, "invalid_device_token");
      assert.equal(linkedSessions.resolve(active).deviceId, "ai-active", "active token still works");
    } finally {
      linkedSessions.revokeDevice("ai-active");
      linkedSessions.revokeDevice("ai-expired");
      await app.close();
    }
  });

  test("a device token never authorizes admin, gateway or API-key paths", async () => {
    const { app } = await makeLinkedApp();
    const token = issueToken("ai-a", [...AI_CAPS]);
    try {
      // Real gateway route: the Device header is consumed by the linked gate
      // and must not reach the gateway key check.
      const gateway = await app.inject({ method: "GET", url: "/gateway/ping", headers: deviceHeader(token) });
      assert.equal(gateway.statusCode, 401, gateway.body);

      // Agent API: refused by the linked whitelist, never by agent signature
      // auth and never by an API key.
      const agent = await app.inject({
        method: "GET", url: "/api/v1/agent/replication-capabilities", headers: deviceHeader(token),
      });
      assert.equal(agent.statusCode, 403, agent.body);
      assert.equal(agent.json().error, "capability_denied");

      // Admin API path (starts with /api/v1/ but is not whitelisted).
      const adminApi = await app.inject({ method: "GET", url: "/api/v1/admin/sync-stats", headers: deviceHeader(token) });
      assert.equal(adminApi.statusCode, 403);
      assert.equal(adminApi.json().error, "capability_denied");

      // Non-/api/v1 admin path: the gate itself must deny before any admin
      // authentication can run. Exercised directly because the harness has no
      // dashboard route; the decision is the production function.
      const request = {
        url: "/admin/overview", method: "GET", headers: deviceHeader(token),
        cookies: {}, ip: "127.0.0.1",
      };
      let status;
      let payload;
      const reply = {
        code(value) { status = value; return this; },
        send(value) { payload = value; return this; },
      };
      assert.equal(authorizeLinkedSession(request, reply), "denied");
      assert.equal(status, 401);
      assert.equal(payload.error, "unauthorized");
      assert.equal(request.linkedDevice, undefined, "no binding is created for a non-API path");

      // A valid cookie is not an admin credential either.
      const cookieToken = issueToken("web-a", [...WEB_CAPS], WEB_PWA);
      const adminWithCookie = await app.inject({ method: "GET", url: "/gateway/ping", headers: cookieHeader(cookieToken) });
      assert.equal(adminWithCookie.statusCode, 401);
      linkedSessions.revokeDevice("web-a");
    } finally {
      linkedSessions.revokeDevice("ai-a");
      await app.close();
    }
  });

  test("a valid cookie keeps winning, and its scope is unchanged", async () => {
    const { app, eventStore } = await makeLinkedApp();
    const cookieToken = issueToken("web-cookie", [...WEB_CAPS], WEB_PWA);
    const foreignToken = issueToken("ai-foreign", [...AI_CAPS]);
    try {
      seedGrant(eventStore, "web-cookie", "web");
      seedGrant(eventStore, "ai-foreign", "ai");

      // Valid cookie + invalid Device header: the cookie branch decides.
      const grants = await app.inject({
        method: "GET", url: "/api/v1/linked-device/key-grants?after=0",
        headers: { ...cookieHeader(cookieToken), authorization: "Device not-a-real-token" },
      });
      assert.equal(grants.statusCode, 200, grants.body);
      assert.ok(grants.json().events.every((event) =>
        JSON.parse(Buffer.from(event.ciphertext, "base64")).deviceId === "web-cookie"));

      const sync = await app.inject({
        method: "GET", url: "/api/v1/sync?after=0&limit=100", headers: cookieHeader(cookieToken),
      });
      assert.equal(sync.statusCode, 200);

      // Out-of-scope path for a linked cookie is still 403 capability_denied.
      const outOfScope = await app.inject({
        method: "GET", url: "/api/v1/linked-device/contacts/events", headers: cookieHeader(cookieToken),
      });
      assert.equal(outOfScope.statusCode, 403);
      assert.equal(outOfScope.json().error, "capability_denied");

      // Expired cookie: no credential reaches the route (401 in production's
      // auth ladder; the harness' master-only fallback is the same outcome).
      const expiredCookie = issueToken("web-expired", [...WEB_CAPS], WEB_PWA, Date.now() - 60_000);
      const expired = await app.inject({
        method: "GET", url: "/api/v1/linked-device/key-grants", headers: cookieHeader(expiredCookie),
      });
      assert.equal(expired.statusCode, 401);
    } finally {
      linkedSessions.revokeDevice("web-cookie");
      linkedSessions.revokeDevice("ai-foreign");
      await app.close();
    }
  });

  test("an AI_AGENT token keeps the SUGGESTIONS_READY capability and nothing else", async () => {
    const { app } = await makeLinkedApp();
    const token = issueToken("ai-suggest", [...AI_CAPS]);
    const envelope = {
      payload: Buffer.from("opaque-envelope-ciphertext").toString("base64"),
      encoding: "envelope.v1",
      schemaVersion: 1,
      cryptoVersion: 1,
    };
    try {
      const allowed = await app.inject({
        method: "POST", url: "/api/v1/commands", headers: deviceHeader(token),
        payload: { type: "SUGGESTIONS_READY", idempotencyKey: "ai-token-suggest", targetAgentId: "phone", ...envelope },
      });
      assert.equal(allowed.statusCode, 202, allowed.body);

      const refused = await app.inject({
        method: "POST", url: "/api/v1/commands", headers: deviceHeader(token),
        payload: { type: "SEND_SMS", idempotencyKey: "ai-token-send", ...envelope },
      });
      assert.equal(refused.statusCode, 403, refused.body);
      assert.equal(refused.json().error, "command_type_not_allowed_for_device");
    } finally {
      linkedSessions.revokeDevice("ai-suggest");
      await app.close();
    }
  });

  test("the whitelist adds exactly POST /api/v1/sync/ack for READ_MESSAGES", () => {
    const read = { capabilities: ["READ_MESSAGES"] };
    assert.equal(linkedSessionPathAllowed(read, "GET", "/api/v1/sync"), true);
    assert.equal(linkedSessionPathAllowed(read, "POST", "/api/v1/sync/ack"), true);
    assert.equal(linkedSessionPathAllowed(read, "POST", "/api/v1/web/sync/ack"), true);
    assert.equal(linkedSessionPathAllowed(read, "GET", "/api/v1/sync/ack"), false);
    assert.equal(linkedSessionPathAllowed(read, "POST", "/api/v1/sync"), false);
    assert.equal(linkedSessionPathAllowed(read, "POST", "/api/v1/linked-device/key-grants"), false);
    assert.equal(linkedSessionPathAllowed({ capabilities: [] }, "POST", "/api/v1/sync/ack"), false);
    assert.equal(linkedSessionPathAllowed({ capabilities: ["AI_SUGGEST"] }, "GET", "/api/v1/sync"), false);
    // AI_AGENT keeps exactly READ_MESSAGES + AI_SUGGEST; no extra capability is
    // needed for the ack route.
    assert.deepEqual([...AI_CAPS], ["READ_MESSAGES", "AI_SUGGEST"]);
  });
});
