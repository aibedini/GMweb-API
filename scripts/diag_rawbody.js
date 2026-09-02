// Diagnose the real composition: print rawBody received vs signed bytes.
process.env.NODE_ENV = "test";
process.env.DASHBOARD_ENABLED = "false";
process.env.GMWEB_API_TOKEN = "test-master-token";
process.env.GMWEB_BROWSER_KEY = "test-browser-key";
process.env.GMWEB_ANDROID_DEVICE_KEY = "test-device-key";
process.env.GMWEB_DB_PATH = ":memory:";
const crypto = require("node:crypto");
const { app, deviceKeyStore, agentAuthService } = require("../src/server");

const DEVICE = "android-e2e";
function signRequest(pair, deviceId, method, url, bodyBuf, ts = Date.now()) {
  const bodyHash = crypto.createHash("sha256").update(bodyBuf).digest("hex");
  const canonical = `${method}\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return { "x-agent-auth": `${deviceId}:${sig}`, "x-agent-ts": String(ts) };
}

app.ready().then(async () => {
  deviceKeyStore.key = "test-device-key";
  deviceKeyStore.source = "env";
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = pair.publicKey.export({ format: "der", type: "spki" });
  const reg = await app.inject({
    method: "POST", url: "/api/v1/agent/identity",
    headers: { "x-api-key": "test-device-key" },
    payload: { deviceId: DEVICE, publicKeys: { signing: spki.toString("base64") } },
  });
  console.log("enroll:", reg.statusCode);

  const created = (await app.inject({
    method: "POST", url: "/api/v1/pairing/session",
    payload: { webDeviceId: "web-e2e", webSigningPublicKey: "PK-S", webEncryptionPublicKey: "PK-E", ephemeralPublicKey: "PK-P", nonce: "n" },
  })).json();

  const body = JSON.stringify({
    pairingSessionId: created.pairingSessionId,
    certificate: "CERT",
    deviceId: "web-e2e",
    transcriptHash: "h",
    trustRootPublicKey: "TRUST",
  });
  const url = "/api/v1/pairing/approve";
  const ts = Date.now();
  const headers = {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body, "utf8")),
    ...signRequest(pair, DEVICE, "POST", url, Buffer.from(body, "utf8"), ts),
  };
  const res = await app.inject({ method: "POST", url, payload: body, headers });
  console.log("STATUS:", res.statusCode, res.payload.slice(0, 120));

  // What did the server see as rawBody? Reconstruct: verify signature over
  // possible byte variants.
  const sigB64 = headers["x-agent-auth"].split(":")[1];
  const bh = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  const canonical = (buf) => `POST\n${url}\n${bh(buf)}\nX-AGENT-TS:${ts}\n`;
  const pub = pair.publicKey;
  console.log("verify over exact string bytes:", crypto.verify("sha256", Buffer.from(canonical(Buffer.from(body, "utf8"))), pub, Buffer.from(sigB64, "base64")));
  process.exit(0);
}).catch((e) => { console.log("ERR", e.message); process.exit(1); });
