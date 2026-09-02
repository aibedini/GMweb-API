// The route-level requireAgentSignature (pairingRoutes.js) still demands
// authenticatedAgentId but this standalone app has no global hook — mirror
// the real composition: authenticate in preHandler like server.js does.
const Fastify = require("fastify");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { AgentAuthService } = require("./src/agentAuth");
const pairing = require("./src/pairingSessions");
const { registerPairingRoutes } = require("./src/pairingRoutes");
const app = Fastify({ logger: false });
const djp = app.getDefaultJsonParser("error", "error");
app.removeContentTypeParser("application/json");
app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  req.rawBody = Buffer.from(body, "utf8");
  djp(req, body, done);
});
const svc = new AgentAuthService(new Database(":memory:"));
const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = pair.publicKey.export({ format: "der", type: "spki" });
svc.registerIdentity({ deviceId: "android-e2e", publicKeys: { signing: spki.toString("base64") } });
app.addHook("preHandler", (req, reply, done) => {
  const p = req.url.split("?")[0];
  const isAgentPath = p === "/api/v1/pairing/approve" || /^\/api\/v1\/pairing\/session\/[^/]+$/.test(p);
  if (!isAgentPath) return done();
  const auth = svc.verifyAgentHeader(req, req.rawBody || Buffer.alloc(0));
  if (auth.ok) {
    req.authenticatedAgentId = auth.deviceId;
    return done();
  }
  reply.code(401).send({ error: "unauthorized", reason: auth.reason });
});
registerPairingRoutes(app, { agentAuthService: svc, config: {} });
app.ready().then(async () => {
  const created = (await app.inject({ method: "POST", url: "/api/v1/pairing/session", payload: { webDeviceId: "w", webSigningPublicKey: "S", webEncryptionPublicKey: "E", ephemeralPublicKey: "P", nonce: "n" } })).json();
  const raw = JSON.stringify({ pairingSessionId: created.pairingSessionId, certificate: "C", deviceId: "w", transcriptHash: "h", trustRootPublicKey: "T" });
  const url = "/api/v1/pairing/approve";
  const ts = Date.now();
  const bh = crypto.createHash("sha256").update(Buffer.from(raw, "utf8")).digest("hex");
  const canonical = "POST\n" + url + "\n" + bh + "\nX-AGENT-TS:" + ts + "\n";
  const sig = crypto.sign("sha256", Buffer.from(canonical, "utf8"), pair.privateKey).toString("base64");
  const res = await app.inject({ method: "POST", url, payload: raw, headers: { "content-type": "application/json; charset=utf-8", "x-agent-auth": "android-e2e:" + sig, "x-agent-ts": String(ts) } });
  console.log("APPROVE-STATUS", res.statusCode, res.payload.slice(0, 100));
  process.exit(0);
}).catch((e) => { console.log("ERR", e.message); process.exit(1); });
