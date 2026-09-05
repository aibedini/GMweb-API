"use strict";
const crypto = require("node:crypto");
const { db } = require("./pairingDb");
const { PROTOCOL, canonicalEnrollment } = require("../shared/pairingProtocol.mjs");
const { verifyP256, apiOrigin: configuredApiOrigin } = require("./pairingRoutes");
const hash = token => crypto.createHash("sha256").update(String(token)).digest("hex");

function registerPrimaryEnrollment(app, { agentAuthService, config, canAdmin }) {
  app.post("/admin/primary-setup", {
    schema: { summary: "Create a one-use primary phone setup claim", tags: ["Pairing"],
      response: { 200: { type: "object", additionalProperties: true } } },
  }, async (request, reply) => {
    if (!canAdmin(request)) return reply.code(403).send({ error: "dashboard_required" });
    const apiOrigin = configuredApiOrigin(request, config);
    const claim = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 300000;
    db().transaction(() => {
      // Only the newest dashboard claim remains valid.
      db().exec("DELETE FROM primary_setup_claims");
      db().prepare("INSERT INTO primary_setup_claims VALUES (?, ?, ?)").run(hash(claim), expiresAt, apiOrigin);
    }).immediate();
    reply.header("Cache-Control", "no-store");
    return { protocol: PROTOCOL, kind: "PRIMARY_SETUP", claim, apiOrigin, expiresAt };
  });
  app.post("/api/v1/primary-enrollment", {
    bodyLimit: 8192,
    schema: { summary: "Consume a setup claim and enroll the primary phone", tags: ["Pairing"],
      body: { type: "object", required: ["claim", "deviceId", "apiOrigin", "publicKeys", "signature", "rootSignature"],
        properties: { claim: { type: "string", maxLength: 128 }, deviceId: { type: "string", minLength: 1, maxLength: 128 },
          apiOrigin: { type: "string", maxLength: 256 }, signature: { type: "string", maxLength: 512 },
          rootSignature: { type: "string", maxLength: 512 }, publicKeys: { type: "object",
            required: ["signing", "encryption", "trustRoot"], properties: {
              signing: { type: "string", maxLength: 512 }, encryption: { type: "string", maxLength: 512 },
              trustRoot: { type: "string", maxLength: 512 } } } } },
      response: { 200: { type: "object", additionalProperties: true } } },
  }, async (request, reply) => {
    const b = request.body;
    const enrolled = db().transaction(() => {
      const claim = db().prepare("SELECT * FROM primary_setup_claims WHERE token_hash = ? AND expires_at > ?")
        .get(hash(b.claim), Date.now());
      if (!claim || claim.api_origin !== b.apiOrigin) return false;
      const bytes = Buffer.from(canonicalEnrollment(b), "utf8");
      if (!verifyP256(bytes, b.signature, b.publicKeys.signing) ||
          !verifyP256(bytes, b.rootSignature, b.publicKeys.trustRoot)) return false;
      const previous = db().prepare("SELECT trust_root_public_key FROM agent_identities WHERE device_role = 'PRIMARY_TRUST_AGENT'").get();
      if (previous && previous.trust_root_public_key !== b.publicKeys.trustRoot) {
        // A fresh primary starts its own trust sequence at one.
        for (const table of ["trust_statements", "trust_snapshots"]) {
          if (db().prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
            db().prepare(`DELETE FROM ${table} WHERE account_id = ?`).run("default");
        }
      }
      agentAuthService.registerIdentity({ deviceId: b.deviceId, publicKeys: b.publicKeys, forcePrimary: true });
      db().prepare("DELETE FROM primary_setup_claims WHERE token_hash = ?").run(hash(b.claim));
      // Replacing the primary also invalidates every previous delegation.
      db().exec("DELETE FROM linked_sessions; DELETE FROM pairing_sessions; DELETE FROM pairing_challenges;");
      return true;
    }).immediate();
    if (!enrolled) return reply.code(401).send({ error: "invalid_setup_claim_or_proof" });
    return { ok: true, role: "PRIMARY_TRUST_AGENT" };
  });
}
module.exports = { registerPrimaryEnrollment };
