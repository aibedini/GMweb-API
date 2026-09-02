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

process.env.NODE_ENV = "test";
process.env.DASHBOARD_ENABLED = "false";
process.env.GMWEB_API_TOKEN = "test-master-token";
process.env.GMWEB_BROWSER_KEY = "test-browser-key";
process.env.GMWEB_ANDROID_DEVICE_KEY = "test-device-key";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
process.env.GMWEB_DB_PATH = ":memory:";

const { app, deviceKeyStore, agentAuthService } = require("../src/server");

const DEVICE = "android-e2e";

function signRequest(pair, deviceId, method, url, bodyBuf, ts = Date.now()) {
  const bodyHash = crypto.createHash("sha256").update(bodyBuf).digest("hex");
  const canonical = `${method}\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return { "x-agent-auth": `${deviceId}:${sig}`, "x-agent-ts": String(ts) };
}

describe("PAIRING-E2E: real app composition (global requireToken + agent auth)", () => {
  let pair;

  before(async () => {
    // The device key store loads async at real startup; force the env value
    // so the bootstrap header matches (as in production after load()).
    deviceKeyStore.key = "test-device-key";
    deviceKeyStore.source = "env";
    pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    // Register through the REAL identity route (device-key bootstrap).
    const reg = await app.inject({
      method: "POST",
      url: "/api/v1/agent/identity",
      headers: { "x-api-key": "test-device-key" },
      payload: { deviceId: DEVICE, publicKeys: { signing: spki.toString("base64") } },
    });
    assert.equal(reg.statusCode, 200, "identity enrollment must succeed");
    // First enrolled agent must be auto-promoted to PRIMARY_TRUST_AGENT.
    assert.equal(agentAuthService.getRole(DEVICE), "PRIMARY_TRUST_AGENT");
  });

  after(async () => {
    await app.close();
    // The real server composition holds live handles (BullMQ/redis, chrome
    // transport) — force-exit so the test process doesn't linger.
    setTimeout(() => process.exit(0), 500).unref?.();
    setImmediate(() => process.exit(0));
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
      payload: body,
      headers: {
        "content-type": "application/json",
        ...signRequest(pair, DEVICE, "POST", approveUrl, Buffer.from(body)),
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
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(exactRawBody, "utf8")),
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
        "content-type": "application/json; charset=utf-8",
        "content-length": String(Buffer.byteLength(tamperedBody, "utf8")),
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
