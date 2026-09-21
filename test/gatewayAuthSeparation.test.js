"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Fastify = require("fastify");
const Database = require("better-sqlite3");
const { AgentAuthService } = require("../src/agentAuth");
const { TrustRegistry } = require("../src/trustRegistry");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { AndroidOutbox } = require("../src/androidOutbox");
const { registerControlPlaneRoutes } = require("../src/controlPlaneRoutes");
const { registerGatewayRoutes } = require("../src/gatewayRoutes");

const GATEWAY_KEY = "gateway-test-key";

function signedHeaders(pair, deviceId, url, ts = Date.now()) {
  const bodyHash = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  const canonical = `POST\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const signature = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return { "x-agent-auth": `${deviceId}:${signature}`, "x-agent-ts": String(ts) };
}

async function buildApp() {
  const db = new Database(":memory:");
  const agentAuthService = new AgentAuthService(db);
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  agentAuthService.registerIdentity({ deviceId: "agent-1", publicKeys: { signing: publicKey } });

  const app = Fastify({ logger: false });
  app.addHook("preHandler", (request, reply, done) => {
    if (request.url.startsWith("/gateway/")) {
      if (request.headers["x-api-key"] === GATEWAY_KEY) return done();
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    if (request.url.startsWith("/api/v1/agent/")) {
      const auth = agentAuthService.verifyAgentHeader(request, Buffer.alloc(0));
      if (auth.ok) {
        request.authenticatedAgentId = auth.deviceId;
        return done();
      }
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    done();
  });

  const outbox = new AndroidOutbox();
  registerGatewayRoutes(app, {
    outbox,
    checkDeviceKey: (request) => request.headers["x-api-key"] === GATEWAY_KEY,
    isPullModeActive: () => true
  });
  registerControlPlaneRoutes(app, {
    trustRegistry: new TrustRegistry(db),
    commandEngine: new CommandEngine(db),
    eventStore: new EventStore(db),
    accountId: "test-account",
    authorizeAgent: () => null,
    agentAuthService,
    checkRateLimit: () => ({ allowed: true })
  });
  await app.ready();
  return { app, db, pair };
}

test("AgentAuth can succeed while the gateway key fails", async () => {
  const { app, db, pair } = await buildApp();
  const agent = await app.inject({ method: "POST", url: "/api/v1/agent/ping", headers: signedHeaders(pair, "agent-1", "/api/v1/agent/ping") });
  const gateway = await app.inject({ method: "GET", url: "/gateway/ping", headers: { "x-api-key": "wrong" } });
  assert.equal(agent.statusCode, 200);
  assert.equal(gateway.statusCode, 401);
  await app.close();
  db.close();
});

test("gateway key can succeed while AgentAuth fails", async () => {
  const { app, db } = await buildApp();
  const gateway = await app.inject({ method: "GET", url: "/gateway/ping", headers: { "x-api-key": GATEWAY_KEY } });
  const agent = await app.inject({ method: "POST", url: "/api/v1/agent/ping", headers: { "x-agent-auth": "bad", "x-agent-ts": String(Date.now()) } });
  assert.equal(gateway.statusCode, 200);
  assert.equal(agent.statusCode, 401);
  await app.close();
  db.close();
});
