"use strict";

/**
 * ADR-007 — pairing session HTTP routes (web ↔ GMweb ↔ Android).
 *
 * Auth posture (deliberate, per ADR-007 §2):
 *  - POST /api/v1/pairing/session   → NO session required (the whole point:
 *    an unlinked browser must be able to START pairing). Rate-limited.
 *  - GET  /api/v1/pairing/status    → NO session (polling by the unlinked
 *    web client). Returns ONLY {state} until approved, then the certificate
 *    payload once (single-use consume).
 *  - POST /api/v1/pairing/approve   → Android agent bridge auth (device key
 *    OR X-Agent-Auth signature) — the SAME gate as /api/v1/agent/*: only the
 *    primary trust device can approve a new web device.
 */

const pairing = require("./pairingSessions");

/** Web-facing origin recorded in the transcript (server sees Host). */
function originOf(request) {
  const proto = request.headers["x-forwarded-proto"] || request.protocol || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "";
  return `${proto}://${host}`;
}

function registerPairingRoutes(app, { agentAuthService }) {
  // ── Web: create pairing session + get QR transcript ────────────────────
  app.post("/api/v1/pairing/session", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      summary: "Create a short-lived QR pairing session (unlinked web client)",
      description:
        "ADR-007 §2: the web client generates its keypairs locally and posts the transcript. " +
        "The session is single-use, TTL 120s, origin-bound, accountless until Android approves.",
      tags: ["Pairing"],
      body: {
        type: "object",
        required: ["webDeviceId", "webSigningPublicKey", "webEncryptionPublicKey", "ephemeralPublicKey", "nonce"],
        properties: {
          webDeviceId: { type: "string", maxLength: 128 },
          webSigningPublicKey: { type: "string" },
          webEncryptionPublicKey: { type: "string" },
          ephemeralPublicKey: { type: "string" },
          nonce: { type: "string" },
          origin: { type: "string", maxLength: 256 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            pairingSessionId: { type: "string" },
            expiresAt: { type: "number" },
            ttlSeconds: { type: "number" },
            qr: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  }, async (request) => {
    const body = request.body || {};
    const created = pairing.createSession({
      webDeviceId: body.webDeviceId,
      webSigningPublicKey: body.webSigningPublicKey,
      webEncryptionPublicKey: body.webEncryptionPublicKey,
      ephemeralPublicKey: body.ephemeralPublicKey,
      nonce: body.nonce,
      origin: body.origin || originOf(request),
    });
    const session = pairing.getSession(created.pairingSessionId);
    return { ...created, qr: pairing.qrPayload(session) };
  });

  // ── Web: poll pairing status (single-use consume on APPROVED) ──────────
  app.get("/api/v1/pairing/status", {
    schema: {
      summary: "Poll pairing status; consumes the certificate exactly once",
      description:
        "ADR-007 §5: returns {state:'PENDING'} while waiting; on approval returns the " +
        "Android-signed DeviceCertificate ONCE (single-use) and destroys the session.",
      tags: ["Pairing"],
      querystring: {
        type: "object",
        required: ["pairingSessionId"],
        properties: { pairingSessionId: { type: "string" } },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request) => {
    const id = request.query.pairingSessionId;
    const session = pairing.getSession(id);
    if (!session) return { state: "EXPIRED" };
    if (session.state === "PENDING") {
      return { state: "PENDING", expiresAt: session.expiresAt };
    }
    const consumed = pairing.consumeApproval(id);
    if (!consumed) return { state: "EXPIRED" };
    return { state: "APPROVED", ...consumed };
  });

  // ── Android: fetch session metadata (what am I approving?) ─────────────
  app.get("/api/v1/pairing/session/:id", {
    schema: {
      summary: "Pairing session metadata for the Android confirmation screen",
      description:
        "ADR-007 §3: Android fetches what it is about to approve. Auth: agent bridge " +
        "(device key or X-Agent-Auth) — enforced by the global requireToken hook.",
      tags: ["Pairing"],
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request) => {
    const session = pairing.getSession(request.params.id);
    if (!session) {
      const err = new Error("pairing session not found or expired");
      err.statusCode = 404;
      throw err;
    }
    return pairing.qrPayload(session);
  });

  // ── Android: approve + attach the signed DeviceCertificate ─────────────
  app.post("/api/v1/pairing/approve", {
    schema: {
      summary: "Android approves the pairing and attaches the signed certificate",
      description:
        "ADR-007 §4: only the primary trust device (Android agent bridge auth) may approve. " +
        "GMweb relays the signed DeviceCertificate; it never grants trust by itself.",
      tags: ["Pairing"],
      body: {
        type: "object",
        required: ["pairingSessionId", "certificate", "deviceId"],
        properties: {
          pairingSessionId: { type: "string" },
          certificate: { type: "string", maxLength: 16384 },
          deviceId: { type: "string", maxLength: 128 },
        },
      },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } },
    },
  }, async (request) => {
    const body = request.body || {};
    return pairing.approveSession(body.pairingSessionId, {
      certificate: body.certificate,
      deviceId: body.deviceId,
    });
  });
}

module.exports = { registerPairingRoutes };
