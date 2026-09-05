"use strict";

/**
 * PR-08b (ADR-001/004) — agent identity registration + per-device auth gate.
 *
 * The Android agent POSTs its PR-05 publicKeys block to /api/v1/agent/identity
 * (device-key authenticated — bootstrap). From then on, /api/v1/agent/*
 * endpoints prefer per-device ECDSA signatures (X-Agent-Auth header) and fall
 * back to the shared device key ONLY while the calling device has no enrolled
 * identity — so existing agents keep working and new ones upgrade in place.
 * Once BOTH mechanisms exist server-side we can deprecate the shared key.
 */

const { registerControlPlaneRoutes } = require("./controlPlaneRoutes");

/**
 * Attach agent-identity registration routes (called from server.js).
 * @param {import("fastify").FastifyInstance} app
 * @param {object} deps { agentAuthService }
 */
function registerAgentIdentityRoutes(app, { agentAuthService }) {
  app.post("/api/v1/agent/identity", {
    schema: {
      summary: "Register/refresh agent identity keys (PR-05 → PR-08b)",
      description: [
        "Device-key authenticated bootstrap: the agent posts its publicKeys block",
        "(signing required; encryption/trustRoot optional) and a stable deviceId.",
        "Subsequent /api/v1/agent/* calls are authenticated per-device with",
        "X-Agent-Auth ECDSA signatures over the canonical request string."
      ].join("\n"),
      tags: ["Agent"],
      body: {
        type: "object",
        required: ["deviceId", "publicKeys"],
        properties: {
          deviceId: { type: "string" },
          protocolVersion: { type: "integer", default: 1 },
          publicKeys: {
            type: "object",
            required: ["signing"],
            properties: {
              signing: { type: "string", description: "base64 uncompressed EC point" },
              encryption: { type: "string" },
              trustRoot: { type: "string" }
            }
          }
        }
      },
      response: {
        200: { type: "object", properties: { ok: { type: "boolean" }, role: { type: "string" } } },
        401: {
          type: "object",
          properties: {
            error: { type: "string" },
            reason: { type: "string", enum: [
              "device_key_mismatch",
              "device_key_not_configured",
            ] },
            expectedKeyPreview: { type: ["string", "null"] },
          },
        },
      }
    }
  }, async (request) => {
    // Ordinary registration cannot grant primary authority.
    const { deviceId, publicKeys, protocolVersion } = request.body || {};
    if (request.authenticatedAgentId && request.authenticatedAgentId !== String(deviceId || "")) {
      const err = new Error("signed identity does not match registration deviceId");
      err.statusCode = 403;
      throw err;
    }
    const result = agentAuthService.registerIdentity({
      deviceId,
      publicKeys,
      protocolVersion,
      forcePrimary: false,
    });
    request._pairingDiagnostic = {
      stage: "ANDROID_IDENTITY_REGISTRATION",
      status: "SUCCESS",
      reason: "identity_refreshed",
      deviceId,
    };
    return { ...result, role: result.role };
  });

  app.get("/api/v1/agent/identities", {
    schema: {
      summary: "List enrolled agent identities (Privacy: keys not returned)",
      tags: ["Agent"]
    }
  }, async () => ({ identities: agentAuthService.listIdentities() }));
}

module.exports = { registerAgentIdentityRoutes };
