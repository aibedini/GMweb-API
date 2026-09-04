"use strict";

const crypto = require("node:crypto");

const RECOVERY_CAPABILITIES = [
  "READ_MESSAGES",
  "SEND_MESSAGES",
  "READ_PAIRING_DIAGNOSTICS",
];

function tokensMatch(actual, expected) {
  if (!actual || !expected) return false;
  const actualHash = crypto.createHash("sha256").update(String(actual)).digest();
  const expectedHash = crypto.createHash("sha256").update(String(expected)).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function recoveryDeviceId(request) {
  const fingerprint = [request.ip || "", request.headers["user-agent"] || ""].join("\n");
  return `pwa-admin-${crypto.createHash("sha256").update(fingerprint).digest("hex").slice(0, 16)}`;
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
 * Admin recovery path for /web. The master token is exchanged once for the
 * same narrow HttpOnly linked-session cookie used by QR pairing. It never
 * authorizes the Android-only pairing lookup/approve routes.
 */
function registerPwaAuthRoutes(app, {
  apiToken,
  linkedSessions,
  checkRateLimit,
  loginMax = 10,
  loginWindowMs = 60_000,
}) {
  app.post("/api/v1/pwa/token-login", {
    bodyLimit: 8 * 1024,
    schema: {
      summary: "Exchange the GMweb master token for a restricted PWA session",
      description: [
        "Secure QR alternative for the server owner. The token is verified once and is not stored by the PWA.",
        "Success issues an HttpOnly, Secure, SameSite=Strict cookie restricted to message sync/send and pairing diagnostics.",
        "This endpoint does not authorize Android pairing metadata or approval routes.",
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

    const submittedToken = request.body.token;
    if (!tokensMatch(submittedToken, apiToken)) {
      request._pairingDiagnostic = {
        stage: "PWA_TOKEN_LOGIN",
        status: "FAILED",
        reason: "invalid_admin_token",
      };
      reply.code(401).send({ error: "unauthorized", reason: "invalid_admin_token" });
      return;
    }

    const deviceId = recoveryDeviceId(request);
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
      access: "ADMIN_TOKEN_RECOVERY",
      expiresInSeconds: Math.floor(linkedSessions.SESSION_TTL_MS / 1000),
    };
  });
}

module.exports = { RECOVERY_CAPABILITIES, registerPwaAuthRoutes, tokensMatch };
