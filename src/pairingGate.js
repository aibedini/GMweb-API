"use strict";

/**
 * ADR-007 — auth gate for the trust-sensitive pairing routes.
 * Shared by server.js (global requireToken hook) and the E2E composition
 * test so the production decision logic has exactly one definition.
 *
 * Contract (review-enforced):
 *  - SIGNATURE-REQUIRED: the shared device key (X-API-Key) can never
 *    authorize these routes — checkDeviceKey is deliberately NOT consulted.
 *  - Signature verified ONCE against the exact raw body; the bound
 *    deviceId is exposed as request.authenticatedAgentId. Routes check
 *    role only (a second verify would falsely trip the replay cache).
 *  - Rejections carry the safe server reason (no secrets).
 */
module.exports = function pairingAgentGate(agentAuthService, request, reply, done) {
  const path = String(request.url || "").split("?")[0];
  const isSessionLookup =
    path.startsWith("/api/v1/pairing/session/") && request.method === "GET";
  const isApprove = path === "/api/v1/pairing/approve" && request.method === "POST";
  if (!isSessionLookup && !isApprove) return done();

  const auth = agentAuthService.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
  if (auth.ok) {
    request.authenticatedAgentId = auth.deviceId;
    return done();
  }
  reply.code(401).send({ error: "unauthorized", reason: auth.reason });
};
