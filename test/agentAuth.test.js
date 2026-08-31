"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const { AgentAuthService } = require("../src/agentAuth");

function makeKey() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function authedRequest(svc, pair, deviceId, body, { ts = Date.now(), url = "/api/v1/agent/commands/claim" } = {}) {
  const bodyHash = crypto.createHash("sha256").update(Buffer.from(body)).digest("hex");
  const canonical = `POST\n${url}\n${bodyHash}\nX-AGENT-TS:${ts}\n`;
  const sig = crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64");
  return {
    headers: { "x-agent-auth": `${deviceId}:${sig}`, "x-agent-ts": String(ts) },
    url,
    bodyBuf: Buffer.from(body),
  };
}

describe("AgentAuthService (PR-08b) — per-device signed auth", () => {
  test("valid signature verifies and binds the deviceId", () => {
    const svc = new AgentAuthService(new Database(":memory:"));
    const pair = makeKey();
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    svc.registerIdentity({ deviceId: "dev-1", publicKeys: { signing: spki.toString("base64") } });
    const req = authedRequest(svc, pair, "dev-1", '{"agentId":"dev-1"}');
    const r = svc.verifyAgentHeader(req, req.bodyBuf);
    assert.equal(r.ok, true);
    assert.equal(r.deviceId, "dev-1");
  });

  test("replayed (device, ts) pair is rejected within the window", () => {
    const svc = new AgentAuthService(new Database(":memory:"));
    const pair = makeKey();
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    svc.registerIdentity({ deviceId: "dev-1", publicKeys: { signing: spki.toString("base64") } });
    const ts = Date.now();
    const req = authedRequest(svc, pair, "dev-1", "{}", { ts });
    assert.equal(svc.verifyAgentHeader(req, req.bodyBuf).ok, true);
    const replay = authedRequest(svc, pair, "dev-1", "{}", { ts });
    const r = svc.verifyAgentHeader(replay, replay.bodyBuf);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "replayed_timestamp");
  });

  test("tampered body fails the body-hash in the canonical string", () => {
    const svc = new AgentAuthService(new Database(":memory:"));
    const pair = makeKey();
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    svc.registerIdentity({ deviceId: "dev-1", publicKeys: { signing: spki.toString("base64") } });
    const req = authedRequest(svc, pair, "dev-1", '{"limit":25}');
    const r = svc.verifyAgentHeader(req, Buffer.from('{"limit":99}'));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "signature_mismatch");
  });

  test("stale and future timestamps leave the 90s window", () => {
    const svc = new AgentAuthService(new Database(":memory:"));
    const pair = makeKey();
    const spki = pair.publicKey.export({ format: "der", type: "spki" });
    svc.registerIdentity({ deviceId: "dev-1", publicKeys: { signing: spki.toString("base64") } });
    const body = "{}";
    for (const ts of [Date.now() - 200_000, Date.now() + 200_000]) {
      const req = authedRequest(svc, pair, "dev-1", body, { ts });
      const r = svc.verifyAgentHeader(req, req.bodyBuf);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "timestamp_out_of_window");
    }
  });

  test("unknown device and malformed header fail closed", () => {
    const svc = new AgentAuthService(new Database(":memory:"));
    assert.equal(svc.verifyAgentHeader({ headers: { "x-agent-auth": "ghost:x", "x-agent-ts": String(Date.now()) }, url: "/x" }, "").reason, "unknown_device");
    assert.equal(svc.verifyAgentHeader({ headers: { "x-agent-auth": "noseparator", "x-agent-ts": "1" }, url: "/x" }, "").reason, "malformed_agent_auth_header");
    assert.equal(svc.verifyAgentHeader({ headers: {}, url: "/x" }, "").reason, "missing_agent_auth_header");
  });

  test("identity upsert overwrites keys on re-registration", () => {
    const svc = new AgentAuthService(new Database(":memory:"));
    const p1 = makeKey();
    const p2 = makeKey();
    svc.registerIdentity({ deviceId: "d", publicKeys: { signing: p1.publicKey.export({ format: "der", type: "spki" }).toString("base64") } });
    svc.registerIdentity({ deviceId: "d", publicKeys: { signing: p2.publicKey.export({ format: "der", type: "spki" }).toString("base64") } });
    const req = authedRequest(svc, p2, "d", "{}");
    assert.equal(svc.verifyAgentHeader(req, req.bodyBuf).ok, true);
    const old = authedRequest(svc, p1, "d", "{}");
    assert.equal(svc.verifyAgentHeader(old, old.bodyBuf).ok, false);
  });
});
