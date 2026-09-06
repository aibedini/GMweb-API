"use strict";

const crypto = require("node:crypto");
const { db } = require("./pairingDb");

const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const fingerprint = value => value
  ? crypto.createHash("sha256").update(Buffer.from(String(value), "base64")).digest("hex")
  : null;

function ensureTable() {
  db().exec(`CREATE TABLE IF NOT EXISTS diagnostic_tokens (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

function buildServerChecks({ identity, trustRootFingerprint, trustSequence, linkedDevices, activeSessions, publicApiOrigin }) {
  const role = identity?.device_role || null;
  return {
    apiReachable: true,
    publicApiOrigin: publicApiOrigin || null,
    agentSignatureAccepted: Boolean(identity),
    identityEnrolled: Boolean(identity),
    role,
    isPrimary: role === "PRIMARY_TRUST_AGENT",
    trustRootMatch: fingerprint(identity?.trust_root_public_key) === trustRootFingerprint,
    serverTrustSequence: Number(trustSequence),
    linkedDeviceCount: Number(linkedDevices),
    activeLinkedSessionCount: Number(activeSessions),
    pairingMetadataEndpointAvailable: true,
    diagnosticPingAccepted: true,
  };
}

function registerConnectionDiagnostics(app, { agentAuthService, canAdmin, checkRateLimit, config }) {
  ensureTable();
  app.post("/admin/connection-diagnostics", {
    schema: { summary: "Create a short-lived diagnostic-only token", tags: ["Diagnostics"],
      response: { 200: { type: "object", additionalProperties: true } } },
  }, async (request, reply) => {
    if (!canAdmin(request)) return reply.code(403).send({ error: "dashboard_required" });
    const limit = checkRateLimit(request, "connection-diagnostic-create", 6, 60_000);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfterSeconds));
      return reply.code(429).send({ error: "rate_limited" });
    }
    const token = `gmwd_${crypto.randomBytes(32).toString("base64url")}`;
    const expiresAt = Date.now() + 15 * 60_000;
    db().prepare("DELETE FROM diagnostic_tokens WHERE expires_at <= ?").run(Date.now());
    db().prepare("INSERT INTO diagnostic_tokens VALUES (?, ?, ?)").run(hash(token), expiresAt, Date.now());
    reply.header("Cache-Control", "no-store");
    return { token, expiresAt };
  });

  app.post("/api/v1/agent/diagnostics", {
    bodyLimit: 2048,
    schema: { summary: "Run diagnostic-only Android/control-plane checks", tags: ["Diagnostics"],
      body: { type: "object", required: ["token", "trustRootFingerprint"], additionalProperties: false,
        properties: { token: { type: "string", minLength: 20, maxLength: 128 }, trustRootFingerprint: { type: "string", minLength: 64, maxLength: 64 } } },
      response: { 200: { type: "object", additionalProperties: true } } },
  }, async (request, reply) => {
    const limit = checkRateLimit(request, "connection-diagnostic-run", 12, 60_000);
    if (!limit.allowed) {
      reply.header("Retry-After", String(limit.retryAfterSeconds));
      return reply.code(429).send({ error: "rate_limited" });
    }
    const record = db().prepare("SELECT expires_at FROM diagnostic_tokens WHERE token_hash = ? AND expires_at > ?")
      .get(hash(request.body.token), Date.now());
    if (!record) return reply.code(401).send({ error: "invalid_or_expired_diagnostic_token" });
    const identity = agentAuthService.getIdentity(request.authenticatedAgentId);
    const trustSequence = db().prepare("SELECT COALESCE(MAX(trust_sequence), 0) value FROM trust_statements").get()?.value || 0;
    const linkedDevices = db().prepare("SELECT COUNT(DISTINCT device_id) value FROM linked_sessions WHERE expires_at > ?").get(Date.now())?.value || 0;
    const activeSessions = db().prepare("SELECT COUNT(*) value FROM linked_sessions WHERE expires_at > ?").get(Date.now())?.value || 0;
    reply.header("Cache-Control", "no-store");
    return {
      expiresAt: record.expires_at,
      checks: buildServerChecks({
        identity,
        trustRootFingerprint: request.body.trustRootFingerprint,
        trustSequence,
        linkedDevices,
        activeSessions,
        publicApiOrigin: process.env.PUBLIC_API_ORIGIN || config?.publicApiOrigin,
      }),
    };
  });
}

module.exports = { registerConnectionDiagnostics, buildServerChecks, fingerprint };
