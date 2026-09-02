/**
 * PAIRING-E2E-CLOSURE — full-app composition test: server.js global hooks
 * (requireToken) + AgentAuth + identity route + pairingRoutes mounted
 * together, exercising the REAL 401-blocking bug found on device:
 * GET /pairing/session/:id fell through to master auth because the global
 * gate used an exact-path match that never matched the :id param route.
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { AgentAuthService } = require("../src/agentAuth");
const pairingGate = require("../src/pairingGate");
const { registerPairingRoutes } = require("../src/pairingRoutes");
const pairing = require("../src/pairingSessions");

const DEVICE = "android-e2e";

function makeKey() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function signRequest(pair, deviceId, method, url, bodyBuf, ts = Date.now()) {
  const bodyHash = crypto.createHash("sha256").update(bodyBuf).digest("hex");
  const canonical = `${method}\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return { "x-agent-auth": `${deviceId}:${sig}`, "x-agent-ts": String(ts) };
}

describe("PAIRING-E2E: real app composition (global requireToken + agent auth)", () => {
  let pair;
  let app;
  let svc;

  before(async () => {
    // Production composition: replaced JSON parser (raw bytes preserved) +
    // pairingGate (the EXACT module server.js uses) + pairingRoutes.
    app = Fastify({ logger: false });
    const defaultJsonParser = app.getDefaultJsonParser("error", "error");
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
      if (process.env.PAIRING_DEBUG) {
        console.error("[parser]", typeof body, String(body || "").length, String(body || "").slice(0, 60));
      }
      req.rawBody = Buffer.from(body, "utf8");
      defaultJsonParser(req, body, done);
    });
    svc = new AgentAuthService(new Database(":memory:"));
    pair = makeKey();
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    // FIX 5 policy lives in the service: first enrolled agent → PRIMARY.
    const reg = svc.registerIdentity({ deviceId: DEVICE, publicKeys: { signing: spki.toString("base64") } });
    assert.equal(reg.role, "PRIMARY_TRUST_AGENT", "first agent must auto-promote");
    app.addHook("preHandler", (request, reply, done) => {
      pairingGate(svc, request, reply, done);
    });
    registerPairingRoutes(app, { agentAuthService: svc, config: {} });
    await app.ready();
  });

  // P1-3: per-IP session cap is shared across tests (inject = one IP).
  test.beforeEach(() => pairing._reset());

  after(async () => {
    await app.close();
  });

  test("browser creates session (anonymous, pollSecret returned)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/session",
      payload: {
        webDeviceId: "web-e2e",
        webSigningPublicKey: "PK-S",
        webEncryptionPublicKey: "PK-E",
        ephemeralPublicKey: "PK-P",
        nonce: "n-e2e",
      },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().pollSecret, "pollSecret must be returned to the browser");
  });

  test("Android GET session/:id (agent-signed) → 200, NOT 401", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-2",
        },
      })
    ).json();
    const url = `/api/v1/pairing/session/${created.pairingSessionId}`;
    const res = await app.inject({
      method: "GET",
      url,
      headers: signRequest(pair, DEVICE, "GET", url, Buffer.alloc(0)),
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.payload.slice(0, 120)}`);
    assert.equal(res.json().webDeviceId, "web-e2e");
  });

  test("Android GET session/:id with MASTER token instead of signature → 401", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-3",
        },
      })
    ).json();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/session/${created.pairingSessionId}`,
      headers: { authorization: "Bearer test-master-token" },
    });
    assert.equal(res.statusCode, 401, "master token must not authorize Android pairing lookups");
  });

  test("Android approve (agent-signed POST) → 200; browser status with pollSecret → APPROVED", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-4",
        },
      })
    ).json();
    const body = JSON.stringify({
      pairingSessionId: created.pairingSessionId,
      certificate: "CERT-E2E",
      deviceId: "web-e2e",
      transcriptHash: created.qr ? "h" : "h",
      trustRootPublicKey: "TRUST-ROOT",
    });
    const approveUrl = "/api/v1/pairing/approve";
    const res = await app.inject({
      method: "POST",
      url: approveUrl,
      payload: body, // exact raw string — must reach the server byte-for-byte
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body, "utf8")),
        ...signRequest(pair, DEVICE, "POST", approveUrl, Buffer.from(body, "utf8")),
      },
    });
    assert.equal(res.statusCode, 200, `approve failed: ${res.payload.slice(0, 120)}`);
    const status = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/status?pairingSessionId=${encodeURIComponent(created.pairingSessionId)}&pollSecret=${encodeURIComponent(created.pollSecret)}`,
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, "APPROVED");
    assert.equal(status.json().certificate, "CERT-E2E");
  });

  test("status WITHOUT pollSecret → EXPIRED (cannot consume)", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-5",
        },
      })
    ).json();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/status?pairingSessionId=${encodeURIComponent(created.pairingSessionId)}`,
    });
    // Missing pollSecret must never reveal state: schema 400 or EXPIRED mask.
    const body = res.json();
    assert.ok(
      res.statusCode === 400 || body.state === "EXPIRED",
      `missing pollSecret must not leak state (got ${res.statusCode}: ${res.payload.slice(0, 80)})`,
    );
  });

  test("REGRESSION: X-API-Key alongside valid signature → 200 (key ignored, not bypass)", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-6",
        },
      })
    ).json();
    const url = `/api/v1/pairing/session/${created.pairingSessionId}`;
    const res = await app.inject({
      method: "GET",
      url,
      headers: {
        "x-api-key": "test-device-key",
        ...signRequest(pair, DEVICE, "GET", url, Buffer.alloc(0)),
      },
    });
    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.payload.slice(0, 120)}`);
  });

  test("REGRESSION: valid X-API-Key WITHOUT signature → 401 (never authorizes trust)", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-7",
        },
      })
    ).json();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/session/${created.pairingSessionId}`,
      headers: { "x-api-key": "test-device-key" },
    });
    assert.equal(res.statusCode, 401, "shared device key must never authorize pairing trust");
  });

  test("REGRESSION: approve with X-API-Key only → 401", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-8",
        },
      })
    ).json();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/approve",
      headers: { "x-api-key": "test-device-key", "content-type": "application/json" },
      payload: {
        pairingSessionId: created.pairingSessionId,
        certificate: "CERT",
        deviceId: "web-e2e",
        transcriptHash: "h",
        trustRootPublicKey: "TRUST",
      },
    });
    // The security property: shared key alone must never approve (200).
    assert.ok(res.statusCode === 401 || res.statusCode === 400, `got ${res.statusCode}`);
  });

  test("RAW-BODY CONTRACT: signature over exact bytes verifies; different serialization of same JSON rejects", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-9",
        },
      })
    ).json();

    // Android-style approve body — EXACT bytes the client will sign.
    const exactRawBody = JSON.stringify({
      pairingSessionId: created.pairingSessionId,
      certificate: "CERT-RAWBODY",
      deviceId: "web-e2e",
      transcriptHash: "h",
      trustRootPublicKey: "TRUST",
    });

    const approveUrl = "/api/v1/pairing/approve";

    // 1) signature over the EXACT raw bytes → must verify. inject sends the
    // raw string as-is with the explicit content-type.
    const res1 = await app.inject({
      method: "POST",
      url: approveUrl,
      payload: exactRawBody,
      headers: {
        "content-type": "application/json",
        ...signRequest(pair, DEVICE, "POST", approveUrl, Buffer.from(exactRawBody, "utf8")),
      },
    });
    assert.equal(res1.statusCode, 200, `exact-bytes approve failed: ${res1.payload.slice(0, 140)}`);

    // 2) same semantic JSON, different serialization (spaces + key order) —
    //    signature from (1) reused → MUST reject (raw-body binding).
    const differentSerialization = JSON.stringify(
      {
        trustRootPublicKey: "TRUST",
        transcriptHash: "h",
        deviceId: "web-e2e",
        certificate: "CERT-RAWBODY",
        pairingSessionId: created.pairingSessionId,
      },
      null,
      2, // pretty-printed: different bytes, same semantics
    );
    // Fresh session (the previous one was consumed).
    const created2 = (
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/session",
        payload: {
          webDeviceId: "web-e2e",
          webSigningPublicKey: "PK-S",
          webEncryptionPublicKey: "PK-E",
          ephemeralPublicKey: "PK-P",
          nonce: "n-e2e-10",
        },
      })
    ).json();
    const tamperedBody = differentSerialization.replace(
      created.pairingSessionId,
      created2.pairingSessionId,
    );
    const res2 = await app.inject({
      method: "POST",
      url: approveUrl,
      payload: tamperedBody,
      headers: {
        "content-type": "application/json",
        // signature computed over the ORIGINAL exact bytes — must mismatch
        ...signRequest(pair, DEVICE, "POST", approveUrl, Buffer.from(exactRawBody, "utf8")),
      },
    });
    assert.equal(
      res2.statusCode,
      401,
      `re-serialized body with old signature must reject: ${res2.payload.slice(0, 140)}`,
    );
  });
});
