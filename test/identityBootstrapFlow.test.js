"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { AgentAuthService } = require("../src/agentAuth");
const { registerAgentIdentityRoutes } = require("../src/agentIdentityRoutes");
const { registerPairingRoutes } = require("../src/pairingRoutes");
const pairing = require("../src/pairingSessions");

function keyPair() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function spki(pair) {
  return pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
}

function signed(pair, deviceId, method, path, body = Buffer.alloc(0), ts = Date.now()) {
  const hash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = `${method}\n${path}\n${hash}\nX-AGENT-TS:${ts}\n`;
  const signature = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return {
    "x-agent-auth": `${deviceId}:${signature}`,
    "x-agent-ts": String(ts),
  };
}

test("dashboard QR bootstrap enrolls Android then signed metadata and approval reach APPROVED", async () => {
  pairing._reset();
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    request.rawBody = body;
    try { done(null, JSON.parse(body.toString("utf8") || "{}")); } catch (error) { done(error); }
  });

  const service = new AgentAuthService(new Database(":memory:"));
  const stale = keyPair();
  service.registerIdentity({ deviceId: "stale-phone", publicKeys: { signing: spki(stale) } });

  app.addHook("preHandler", (request, reply, done) => {
    const path = request.url.split("?")[0];
    if (path === "/api/v1/agent/identity") {
      const token = String(request.headers["x-pairing-bootstrap"] || "");
      const sessionId = String(request.headers["x-pairing-session"] || "");
      if (pairing.consumeIdentityBootstrap(sessionId, token)) {
        request.identityBootstrapAuthorized = true;
        return done();
      }
      reply.code(401).send({ error: "unauthorized", reason: "invalid_pairing_bootstrap" });
      return;
    }
    if (path.startsWith("/api/v1/pairing/session/") || path === "/api/v1/pairing/approve") {
      const auth = service.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
      if (!auth.ok) {
        reply.code(401).send({ error: "unauthorized", reason: auth.reason });
        return;
      }
      request.authenticatedAgentId = auth.deviceId;
    }
    done();
  });
  registerAgentIdentityRoutes(app, { agentAuthService: service });
  registerPairingRoutes(app, {
    agentAuthService: service,
    config: { publicWebOrigin: "https://gmweb.example" },
    canBootstrapIdentity: () => true,
  });
  await app.ready();

  try {
    const browser = keyPair();
    const create = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/session",
      payload: {
        webDeviceId: "web-device",
        webSigningPublicKey: spki(browser),
        webEncryptionPublicKey: "web-encryption",
        ephemeralPublicKey: "web-ephemeral",
        nonce: "nonce",
      },
    });
    assert.equal(create.statusCode, 200);
    const session = create.json();
    assert.ok(session.qr.identityBootstrapToken);

    const phone = keyPair();
    const identityBody = Buffer.from(JSON.stringify({
      deviceId: "current-phone",
      protocolVersion: 1,
      publicKeys: { signing: spki(phone), encryption: "phone-encryption", trustRoot: spki(phone) },
    }));
    const enrollment = await app.inject({
      method: "POST",
      url: "/api/v1/agent/identity",
      payload: identityBody,
      headers: {
        "content-type": "application/json",
        "x-pairing-session": session.pairingSessionId,
        "x-pairing-bootstrap": session.qr.identityBootstrapToken,
      },
    });
    assert.equal(enrollment.statusCode, 200);
    assert.equal(service.getRole("stale-phone"), "LEGACY_AGENT");
    assert.equal(service.getRole("current-phone"), "PRIMARY_TRUST_AGENT");

    const metadataPath = `/api/v1/pairing/session/${session.pairingSessionId}`;
    const metadata = await app.inject({
      method: "GET",
      url: metadataPath,
      headers: signed(phone, "current-phone", "GET", metadataPath, Buffer.alloc(0)),
    });
    assert.equal(metadata.statusCode, 200);

    const certificate = JSON.stringify({
      deviceId: "web-device",
      signingPublicKey: spki(browser),
      capabilities: ["READ_MESSAGES"],
    });
    const approveBody = Buffer.from(JSON.stringify({
      pairingSessionId: session.pairingSessionId,
      certificate,
      deviceId: "web-device",
      transcriptHash: metadata.json().transcriptHash,
      trustRootPublicKey: spki(phone),
    }));
    const approve = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/approve",
      payload: approveBody,
      headers: {
        "content-type": "application/json",
        ...signed(phone, "current-phone", "POST", "/api/v1/pairing/approve", approveBody, Date.now() + 1),
      },
    });
    assert.equal(approve.statusCode, 200);

    const status = await app.inject({
      method: "GET",
      url: `/api/v1/pairing/status?pairingSessionId=${session.pairingSessionId}&pollSecret=${session.pollSecret}`,
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, "APPROVED");
  } finally {
    await app.close();
    pairing._reset();
  }
});
