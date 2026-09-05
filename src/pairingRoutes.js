"use strict";

/**
 * ADR-007 — pairing session HTTP routes (security revision P0-1..P0-5).
 *
 * Auth matrix (enforced in requireToken + route-level preHandler here):
 *   POST /api/v1/pairing/session        anonymous (rate-limited, bounded)
 *   GET  /api/v1/pairing/status         anonymous (single-use consume)
 *   GET  /api/v1/pairing/session/:id    ANDROID AGENT ONLY (signature)
 *   POST /api/v1/pairing/approve        ANDROID AGENT ONLY (signature)
 *
 * P0-2: agent-bridge auth is verified HERE at the route level against the
 * exact raw body — master token / dashboard session / project API keys are
 * explicitly rejected as trust approvers. The signature binds
 * method+path+body-hash+timestamp (replay-protected by AgentAuthService).
 *
 * P0-5: origin is server-owned (config.PUBLIC_WEB_ORIGIN, else the request
 * Host behind a trusted proxy) — the client cannot supply it.
 */


/**
 * ECDSA P-256 / SHA-256 verification accepting BOTH wire formats used by
 * Android (raw uncompressed point 0x04||X||Y and DER SPKI Base64).
 */
function verifyP256(data, sigB64, pubB64) {
  try {
    const keyBytes = Buffer.from(String(pubB64 || ""), "base64");
    let keyObject;
    if (keyBytes.length === 65 && keyBytes[0] === 0x04) {
      const spki = Buffer.concat([
        Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
        keyBytes,
      ]);
      keyObject = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
    } else {
      keyObject = crypto.createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    }
    if (keyObject.asymmetricKeyType !== "ec" || keyObject.asymmetricKeyDetails?.namedCurve !== "prime256v1") return false;
    const signature = Buffer.from(String(sigB64 || ""), "base64");
    // Android/Java emits ASN.1 DER while WebCrypto emits the 64-byte
    // IEEE-P1363 r||s form. Pairing uses both runtimes, so accept both exact
    // encodings instead of testing only Node's DER default.
    const verificationKey = signature.length === 64
      ? { key: keyObject, dsaEncoding: "ieee-p1363" }
      : keyObject;
    return crypto.verify("sha256", data, verificationKey, signature);
  } catch {
    return false;
  }
}

const pairing = require("./pairingSessions");
const linkedSessions = require("./linkedSessions");
const crypto = require("crypto");
const { db } = require("./pairingDb");
const { validateCertificate } = require("./pairingCertificate");
const { canonicalCertificate } = require("../shared/pairingProtocol.mjs");

/** Web-facing origin recorded in the transcript (server-derived only). */
function serverOrigin(request, config) {
  const configured = process.env.PUBLIC_WEB_ORIGIN || (config && config.publicWebOrigin);
  if (configured) return String(configured);
  const proto = request.headers["x-forwarded-proto"] || request.protocol || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host || "";
  // inject()/local calls report http; the production edge terminates TLS and
  // sets X-Forwarded-Proto. Trust the hop only when a proxy header exists,
  // otherwise default to https (deployments are HTTPS-only per the ADR).
  const secure = proto === "https" || !request.headers["x-forwarded-proto"];
  return `${secure ? "https" : proto}://${host}`;
}

function apiOrigin(request, config) {
  const configured = process.env.PUBLIC_API_ORIGIN || config?.publicApiOrigin;
  if (configured) return String(configured);
  // In development only, use the backend host independently of web origin.
  return `https://${request.headers.host || "localhost"}`;
}

/**
 * P0-2 — route-level Android-agent enforcement. Runs INSIDE the route
 * (post-parse) so the exact raw body is available; the global requireToken
 * hook has already rejected fully-anonymous callers for these paths.
 *
 * Rejects: no signature at all, signatures that don't match the exact
 * method+path+body, expired/replayed timestamps, unknown devices. The bound
 * deviceId is attached as request.authenticatedAgentId.
 */
/**
 * FIX 2b (review): the global preHandler hook has ALREADY verified the
 * agent signature (single verification — a second verify would falsely
 * trip the replay cache). Routes now only confirm the binding exists and
 * enforce the role.
 */
function requireAgentSignature(request, reply, _agentAuthService, done) {
  if (!request.authenticatedAgentId) {
    reply.code(401).send({ error: "agent signature required (not authenticated)" });
    return false;
  }
  done();
  return true;
}

function markPairing(request, stage, status, reason, identifiers = {}) {
  request._pairingDiagnostic = {
    stage,
    status,
    reason,
    sessionId: identifiers.sessionId,
    deviceId: identifiers.deviceId,
  };
}

function registerPairingRoutes(app, { agentAuthService, config }) {
  // BLOCKER 7: production origin is fail-closed. Header-derived origins are
  // only allowed outside production (trustProxy + forwarded headers must not
  // decide the root-trust transcript).
  const isProduction = process.env.NODE_ENV === "production";
  const configuredOrigin = process.env.PUBLIC_WEB_ORIGIN || (config && config.publicWebOrigin);
  if (isProduction) {
    if (!configuredOrigin || !configuredOrigin.startsWith("https://")) {
      throw new Error(
        "PUBLIC_WEB_ORIGIN must be set to an HTTPS URL in production (ADR-007 BLOCKER 7) — refusing to start"
      );
    }
    const configuredApi = process.env.PUBLIC_API_ORIGIN || config?.publicApiOrigin;
    for (const origin of [configuredOrigin, configuredApi]) {
      if (!origin || new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin) {
        throw new Error("PUBLIC_API_ORIGIN and PUBLIC_WEB_ORIGIN must be explicit HTTPS origins in production");
      }
    }
  }
  // ── Web: create pairing session + get QR transcript (anonymous OK) ─────
  app.post("/api/v1/pairing/session", {
    bodyLimit: 8 * 1024, // P1-3: strict body cap on the public endpoint
    schema: {
      summary: "Create a short-lived QR pairing session (unlinked web client)",
      description:
        "ADR-007 §2/P0-5: the web client generates its keypairs locally and posts the transcript. " +
        "Origin is SERVER-owned (ignored from the client). Single-use, TTL 120s, capacity-bounded.",
      tags: ["Pairing"],
      body: {
        type: "object",
        required: ["webDeviceId", "webSigningPublicKey", "webEncryptionPublicKey", "ephemeralPublicKey", "nonce"],
        additionalProperties: false, // P0-5: client 'origin' is rejected, not honored
        properties: {
          webDeviceId: { type: "string", maxLength: 128 },
          webSigningPublicKey: { type: "string", maxLength: 512 },
          webEncryptionPublicKey: { type: "string", maxLength: 512 },
          ephemeralPublicKey: { type: "string", maxLength: 512 },
          nonce: { type: "string", maxLength: 128 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            pairingSessionId: { type: "string" },
            expiresAt: { type: "number" },
            ttlSeconds: { type: "number" },
            pollSecret: { type: "string" }, // response schema strips unknown fields without this
            qr: { type: "object", additionalProperties: true },
          },
        },
      },
    },
  }, async (request) => {
    // P0-5: Fastify's default ajv STRIPS unknown fields (removeAdditional),
    // so a client-supplied origin is silently dropped before this handler —
    // it can never influence the transcript. Defense-in-depth: if a future
    // ajv config change makes it appear, reject loudly.
    if (request.body && "origin" in request.body) {
      const err = new Error("client-supplied origin is not trusted (P0-5)");
      err.statusCode = 400;
      throw err;
    }
    const created = pairing.createSession(request.body || {}, {
      ip: request.ip,
      origin: configuredOrigin || serverOrigin(request, config),
      apiOrigin: apiOrigin(request, config),
    });
    const session = pairing.getSession(created.pairingSessionId);
    markPairing(
      request,
      "WEB_SESSION_CREATED",
      "SUCCESS",
      "primary_enrollment_required",
      { sessionId: created.pairingSessionId, deviceId: request.body?.webDeviceId },
    );
    return {
      pairingSessionId: created.pairingSessionId,
      expiresAt: created.expiresAt,
      ttlSeconds: created.ttlSeconds,
      pollSecret: created.pollSecret, // shown to web ONCE; QR carries only the id
      qr: {
        ...pairing.qrPayload(session),

      },
    };
  });

  // ── Web: retryable status poll; linked-session challenge stays one-use ──
  app.get("/api/v1/pairing/status", {
    schema: {
      summary: "Poll pairing status; recover approval until the one-use challenge is completed",
      description:
        "ADR-007 §5: returns {state:'PENDING'} while waiting; on approval returns the " +
        "Android-signed DeviceCertificate + transcriptHash and parks a one-use challenge. Lost responses can be recovered with the same poll secret. " +
        "The web MUST verify the certificate binding locally before trusting it.",
      tags: ["Pairing"],
      querystring: {
        type: "object",
        required: ["pairingSessionId", "pollSecret"],
        properties: {
          pairingSessionId: { type: "string" },
          pollSecret: { type: "string", maxLength: 128 },
        },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request) => {
    const id = request.query.pairingSessionId;
    const pollSecret = request.query.pollSecret;
    const session = pairing.getSession(id);
    if (!session) {
      const resumed = pairing.resumeApproval(id, pollSecret);
      if (resumed) return resumed;
    }
    if (!session || !pairing.pollSecretMatches(session, pollSecret)) {
      // Wrong/missing pollSecret: treat as EXPIRED without leaking state.
      markPairing(request, "WEB_STATUS_POLL", "FAILED", "invalid_or_expired_session", { sessionId: id });
      return { state: "EXPIRED" };
    }
    if (session.state === "PENDING") {
      return { state: "PENDING", expiresAt: session.expiresAt };
    }
    const consumed = pairing.consumeApproval(id, pollSecret);
    if (!consumed) {
      markPairing(request, "WEB_STATUS_POLL", "FAILED", "approval_unavailable", { sessionId: id });
      return { state: "EXPIRED" };
    }
    markPairing(request, "WEB_APPROVAL_RECEIVED", "SUCCESS", "certificate_received", {
      sessionId: id,
      deviceId: consumed.deviceId,
    });
    return { state: "APPROVED", ...consumed };
  });

  // ── Android: session metadata — AGENT SIGNATURE REQUIRED (P0-1) ────────
  app.get("/api/v1/pairing/session/:id", {
    schema: {
      summary: "Pairing session metadata for the Android confirmation screen",
      description:
        "ADR-007 §3/P0-1: Android-only. Requires a valid X-Agent-Auth signature bound to " +
        "this exact request (method, path, body-hash, timestamp).",
      tags: ["Pairing"],
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    // GET has no body — the canonical body-hash covers the empty buffer;
    // AgentAuthService already binds method+path+ts.
    let gateDone = false;
    const ok = requireAgentSignature(request, reply, agentAuthService, () => {
      gateDone = true;
    });
    if (!ok || !gateDone) return reply;
    if (agentAuthService.getRole(request.authenticatedAgentId) !== "PRIMARY_TRUST_AGENT") {
      return reply.code(403).send({ error: "primary_enrollment_required", reason: "primary_enrollment_required" });
    }
    const session = pairing.getSession(request.params.id);
    if (!session) {
      markPairing(request, "ANDROID_METADATA_FETCH", "FAILED", "session_not_found_or_expired", {
        sessionId: request.params.id,
        deviceId: request.authenticatedAgentId,
      });
      const err = new Error("pairing session not found or expired");
      err.statusCode = 404;
      throw err;
    }
    markPairing(request, "ANDROID_METADATA_FETCH", "SUCCESS", "metadata_returned", {
      sessionId: request.params.id,
      deviceId: request.authenticatedAgentId,
    });
    return { ...pairing.qrPayload(session), transcriptHash: session.transcriptHash };
  });

  // ── Android: approve + attach the signed certificate — SIGNATURE REQUIRED
  app.post("/api/v1/pairing/approve", {
    bodyLimit: 32 * 1024,
    schema: {
      summary: "Android approves the pairing and attaches the signed certificate",
      description:
        "ADR-007 §4/P0-2: trust-root operation. Requires a valid enrolled Android agent " +
        "identity + X-Agent-Auth signature over the EXACT raw body (method+path+sha256(body)+" +
        "timestamp, replay-protected). Master token / dashboard session / project API keys " +
        "are NOT accepted as trust approvers.",
      tags: ["Pairing"],
      body: {
        type: "object",
        required: ["pairingSessionId", "certificate", "deviceId", "transcriptHash", "trustRootPublicKey"],
        additionalProperties: false,
        properties: {
          pairingSessionId: { type: "string", maxLength: 128 },
          certificate: { type: "string", maxLength: 16384 },
          deviceId: { type: "string", maxLength: 128 },
          transcriptHash: { type: "string", maxLength: 128 },
          trustRootPublicKey: { type: "string", maxLength: 512 },
        },
      },
      response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } },
    },
  }, async (request, reply) => {
    let gateDone = false;
    const ok = requireAgentSignature(request, reply, agentAuthService, () => {
      gateDone = true;
    });
    if (!ok || !gateDone) return reply;
    // BLOCKER 3: not every Android identity may approve a web device. Only
    // the account's registered PRIMARY_TRUST_AGENT (explicit role on the
    // identity record) passes; anything else is rejected even with a valid
    // signature.
    const role = agentAuthService.getRole(request.authenticatedAgentId);
    if (role !== "PRIMARY_TRUST_AGENT") {
      markPairing(request, "ANDROID_SERVER_APPROVAL", "FAILED", "not_primary_trust_agent", {
        sessionId: request.body?.pairingSessionId,
        deviceId: request.authenticatedAgentId,
      });
      reply.code(403).send({ error: "primary_enrollment_required", reason: "primary_enrollment_required" });
      return reply;
    }
    const body = request.body || {};
    const identity = agentAuthService.getIdentity(request.authenticatedAgentId);
    const session = pairing.getSession(body.pairingSessionId);
    let certificate;
    try { certificate = JSON.parse(body.certificate); } catch { certificate = null; }
    if (!session) return reply.code(404).send({ error: "session_expired" });
    if (!identity?.trust_root_public_key || identity.trust_root_public_key !== body.trustRootPublicKey ||
        body.deviceId !== session.webDeviceId || body.transcriptHash !== session.transcriptHash ||
        !validateCertificate(certificate, session) ||
        !verifyP256(Buffer.from(canonicalCertificate(certificate), "utf8"), certificate.rootSignature, identity.trust_root_public_key)) {
      markPairing(request, "ANDROID_SERVER_APPROVAL", "FAILED", "invalid_certificate");
      return reply.code(403).send({ error: "invalid_certificate", reason: "certificate_binding_or_signature_invalid" });
    }
    try {
      const approved = pairing.approveSession(body.pairingSessionId, {
        certificate: body.certificate,
        deviceId: body.deviceId,
        transcriptHash: body.transcriptHash,
        trustRootPublicKey: body.trustRootPublicKey,
      });
      markPairing(request, "ANDROID_SERVER_APPROVAL", "SUCCESS", "server_approved", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      return approved;
    } catch (error) {
      markPairing(request, "ANDROID_SERVER_APPROVAL", "FAILED", error.message || "approval_failed", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      throw error;
    }
  });

  // ── POST-PAIR SECURE BOOTSTRAP: challenge peek (pollSecret-bound) ────────
  // The browser reads its single-use challenge AFTER certificate
  // verification (approval already consumed). pollSecret authenticates;
  // peeking never burns — only /complete burns it.
  app.get("/api/v1/pairing/challenge", {
    schema: {
      summary: "Fetch the single-use link-session challenge (post-approval)",
      tags: ["Pairing"],
      querystring: {
        type: "object",
        required: ["pollSecret"],
        properties: { pollSecret: { type: "string", maxLength: 128 } },
      },
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request, reply) => {
    const rec = pairing.peekChallenge(request.query.pollSecret);
    if (!rec) {
      markPairing(request, "WEB_LINK_CHALLENGE", "FAILED", "invalid_or_expired_challenge");
      reply.code(404).send({ error: "invalid_or_expired_challenge" });
      return reply;
    }
    markPairing(request, "WEB_LINK_CHALLENGE", "SUCCESS", "challenge_returned", { deviceId: rec.deviceId });
    return {
      challenge: rec.challenge,
      issuedAt: rec.issuedAt,
      deviceId: rec.deviceId,
      certificate: rec.certificate,
      pairingSessionId: rec.pairingSessionId,
      webOrigin: rec.webOrigin,
      apiOrigin: rec.apiOrigin,
    };
  });

  // ── POST-PAIR SECURE BOOTSTRAP: browser proves key possession ────────────
  // Anonymous route, but every request must present the pairing session's
  // single-use challenge + a signature from the browser's OPERATIONAL key
  // over the canonical challenge bytes. GMweb verifies and issues an
  // HttpOnly Secure SameSite=Strict linked-device session cookie.
  // Capability-scoped: the session inherits exactly the certificate's caps.
  app.post("/api/v1/pairing/complete", {
    config: { rateLimit: { max: 10, timeWindow: 60000 } },
    schema: {
      summary: "Exchange the pairing challenge for a linked-device session",
      description: [
        "Called by the browser after it verified the Android-signed DeviceCertificate locally.",
        "The browser signs the canonical challenge (GMweb-Link-Session-v1) with the same",
        "operational signing key bound in the certificate. Single-use challenge.",
        "Success sets the HttpOnly linked-session cookie.",
      ].join("\n"),
      tags: ["Pairing"],
      body: {
        type: "object",
        required: ["pairingSessionId", "pollSecret", "deviceId", "challenge", "signature"],
        properties: {
          pairingSessionId: { type: "string", maxLength: 128 },
          pollSecret: { type: "string", maxLength: 256 },
          deviceId: { type: "string", maxLength: 128 },
          challenge: { type: "string", maxLength: 128 },
          signature: { type: "string", maxLength: 512 },
          certificate: { type: "string", maxLength: 16384 }
        }
      },
      response: {
        200: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            deviceId: { type: "string" },
            capabilities: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  }, async (request, reply) => {
    const body = request.body || {};
    const taken = pairing.peekChallenge(body.pollSecret);
    if (!taken || taken.challenge !== body.challenge || taken.pairingSessionId !== body.pairingSessionId) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "invalid_or_expired_challenge", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(401).send({ error: "invalid_or_expired_challenge" });
      return reply;
    }
    if (body.deviceId !== taken.deviceId) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "device_mismatch", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(403).send({ error: "device_mismatch" });
      return reply;
    }

    // Extract the certificate's signing key + capabilities (defensive parse).
    let cert = null;
    try { cert = JSON.parse(taken.certificate); } catch { cert = null; }
    const certSigPub = cert?.signingPublicKey || "";
    const caps = cert && Array.isArray(cert.capabilities) ? cert.capabilities : [];
    const capNames = ["READ_MESSAGES","SEND_MESSAGES","MANAGE_DEVICES","READ_OTP","READ_BANK_SECURITY","READ_PASSWORD_RESET","READ_AUTH_CODES","READ_FINANCIAL_NOTIFICATIONS"];
    const capabilities = caps.filter((c) => capNames.includes(String(c)));
    if (!capabilities.includes("READ_MESSAGES")) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "certificate_lacks_read_capability", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(403).send({ error: "certificate_lacks_read_capability" });
      return reply;
    }
    if (!certSigPub || !body.signature) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "signature_required", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(401).send({ error: "signature_required" });
      return reply;
    }

    // Canonical challenge bytes + ECDSA P-256 verification against the
    // certificate's signing public key (SPKI DER Base64 or raw point).
    const origin = taken.webOrigin;
    if (!cert || !Number.isSafeInteger(cert.expiresAt) || cert.expiresAt <= Date.now()) return reply.code(403).send({ error: "certificate_expired" });
    const canonical = pairing.challengeCanonical(
      taken.deviceId, body.challenge, origin, taken.issuedAt, taken.pairingSessionId, taken.apiOrigin
    );
    const ok = verifyP256(canonical, body.signature, certSigPub);
    if (!ok) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "challenge_signature_invalid", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(401).send({ error: "signature_mismatch", reason: "challenge_signature_invalid" });
      return reply;
    }

    // Require the browser to present the SAME certificate Android approved.
    if (body.certificate && String(body.certificate) !== taken.certificate) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "certificate_mismatch", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(403).send({ error: "certificate_mismatch" });
      return reply;
    }

    // Burn the challenge ONLY after every verification passed (a failed
    // verify must not lock the browser out of a legitimate retry).
    const token = db().transaction(() => {
      if (!pairing.burnChallenge(body.pollSecret)) return null;
      return linkedSessions.issue(taken.deviceId, capabilities, cert.trustSequence, cert.expiresAt);
    }).immediate();
    if (!token) {
      markPairing(request, "WEB_LINK_SESSION", "FAILED", "challenge_already_used", {
        sessionId: body.pairingSessionId,
        deviceId: body.deviceId,
      });
      reply.code(409).send({ error: "challenge_already_used" });
      return reply;
    }
    reply.setCookie(linkedSessions.COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: Math.floor(linkedSessions.SESSION_TTL_MS / 1000),
    });
    markPairing(request, "WEB_LINK_SESSION", "SUCCESS", "linked_session_issued", {
      sessionId: body.pairingSessionId,
      deviceId: taken.deviceId,
    });
    return {
      ok: true,
      deviceId: taken.deviceId,
      capabilities,
    };
  });

  // Linked-session introspection for browser startup (replaces passkey
  // as the linked-state signal).
  app.get("/api/v1/linked-session", {
    schema: {
      summary: "Linked-device session state (cookie-authenticated)",
      tags: ["Pairing"],
      response: {
        200: {
          type: "object",
          properties: {
            authenticated: { type: "boolean" },
            deviceId: { type: ["string", "null"] },
            capabilities: { type: "array", items: { type: "string" } },
            trustSequence: { type: "integer" }
          }
        }
      }
    }
  }, async (request, reply) => {
    const token = request.cookies ? request.cookies[linkedSessions.COOKIE_NAME] : "";
    const session = linkedSessions.resolve(token);
    if (!session) {
      return { authenticated: false, deviceId: null, capabilities: [], trustSequence: 0 };
    }
    return {
      authenticated: true,
      deviceId: session.deviceId,
      capabilities: session.capabilities,
      trustSequence: session.trustSequence,
    };
  });
}

module.exports = { registerPairingRoutes, serverOrigin, apiOrigin, verifyP256 };
