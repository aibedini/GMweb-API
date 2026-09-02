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
});
