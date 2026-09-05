"use strict";

const crypto = require("node:crypto");

const RECOVERY_CAPABILITIES = [
  "READ_MESSAGES",
  "READ_PAIRING_DIAGNOSTICS",
];

function recoveryDeviceId() {
  // One revocable identity per successful token exchange. Avoid browser
  // fingerprinting and avoid coupling two independent PWA sessions that
  // happen to share an IP/User-Agent.
  return `pwa-access-${crypto.randomBytes(12).toString("hex")}`;
}

function setLinkedCookie(reply, linkedSessions, token) {
  reply.setCookie(linkedSessions.COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(linkedSessions.SESSION_TTL_MS / 1000),
  });
}

/**
 * One-time PWA access path for /web. A dedicated, short-lived token is
 * consumed once and exchanged for the same narrow HttpOnly linked-session
 * cookie used by QR pairing. The master API token is intentionally rejected.
 */
function registerPwaAuthRoutes(app, {
  pwaAccessTokens,
  linkedSessions,
  checkRateLimit,
  loginMax = 10,
  loginWindowMs = 60_000,
}) {
  app.post("/api/v1/pwa/token-login", {
    bodyLimit: 8 * 1024,
    schema: {
      summary: "Consume a one-time PWA access token",
      description: [
        "QR-independent access for the server owner using a dedicated token created in the dashboard.",
        "The token is short-lived, stored as a SHA-256 hash, consumed once, and never stored by the PWA.",
        "Success issues an HttpOnly, Secure, SameSite=Strict cookie restricted to read-only message sync and pairing diagnostics.",
        "The GMweb master API token and project API keys are not accepted here.",
      ].join("\n"),
      tags: ["Pairing"],
      security: [],
      body: {
        type: "object",
        required: ["token"],
        additionalProperties: false,
        properties: { token: { type: "string", minLength: 1, maxLength: 4096 } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            access: { type: "string" },
            expiresInSeconds: { type: "integer" },
          },
        },
        401: { type: "object", properties: { error: { type: "string" }, reason: { type: "string" } } },
        429: { type: "object", properties: { error: { type: "string" }, retryAfterSeconds: { type: "integer" } } },
      },
    },
  }, async (request, reply) => {
    const limit = checkRateLimit(request, "pwa-token-login", loginMax, loginWindowMs);
    if (!limit.allowed) {
      request._pairingDiagnostic = {
        stage: "PWA_TOKEN_LOGIN",
        status: "FAILED",
        reason: "rate_limited",
      };
      reply.header("retry-after", String(limit.retryAfterSeconds));
      reply.code(429).send({ error: "rate_limited", retryAfterSeconds: limit.retryAfterSeconds });
      return;
    }

    const deviceId = recoveryDeviceId();
    const access = pwaAccessTokens.consume(request.body.token, deviceId);
    if (!access) {
      request._pairingDiagnostic = {
        stage: "PWA_TOKEN_LOGIN",
        status: "FAILED",
        reason: "invalid_or_expired_pwa_token",
      };
      reply.code(401).send({ error: "unauthorized", reason: "invalid_or_expired_pwa_token" });
      return;
    }

    const token = linkedSessions.issue(deviceId, RECOVERY_CAPABILITIES);
    setLinkedCookie(reply, linkedSessions, token);
    request._pairingDiagnostic = {
      stage: "PWA_TOKEN_LOGIN",
      status: "SUCCESS",
      reason: "restricted_session_issued",
      deviceId,
    };
    return {
      ok: true,
      access: "ONE_TIME_PWA_TOKEN",
      expiresInSeconds: Math.floor(linkedSessions.SESSION_TTL_MS / 1000),
    };
  });
}

function registerPwaTokenAdminRoutes(app, { pwaAccessTokens, linkedSessions }) {
  app.get("/admin/pwa-access-tokens", {
    schema: { summary: "List one-time PWA access tokens", tags: ["PWA Access"] },
  }, async () => ({ tokens: pwaAccessTokens.list() }));

  app.post("/admin/pwa-access-tokens", {
    schema: {
      summary: "Create a one-time PWA access token",
      tags: ["PWA Access"],
      body: {
        type: "object",
        additionalProperties: false,
        properties: {
          label: { type: "string", minLength: 1, maxLength: 64 },
          expiresInMinutes: { type: "integer", minimum: 1, maximum: 1440, default: 15 },
        },
      },
    },
  }, async (request) => ({
    ok: true,
    token: pwaAccessTokens.create({
      label: request.body?.label || "Browser",
      ttlMs: (request.body?.expiresInMinutes || 15) * 60_000,
    }),
  }));

  app.delete("/admin/pwa-access-tokens/:id", {
    schema: {
      summary: "Revoke a PWA access token and its browser session",
      tags: ["PWA Access"],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  }, async (request, reply) => {
    const revoked = pwaAccessTokens.revoke(request.params.id);
    if (!revoked) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    if (revoked.deviceId) linkedSessions.revokeDevice(revoked.deviceId);
    return { ok: true };
  });
}

module.exports = { RECOVERY_CAPABILITIES, registerPwaAuthRoutes, registerPwaTokenAdminRoutes };
