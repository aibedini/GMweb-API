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

const pairing = require("./pairingSessions");

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

/**
 * P0-2 — route-level Android-agent enforcement. Runs INSIDE the route
 * (post-parse) so the exact raw body is available; the global requireToken
 * hook has already rejected fully-anonymous callers for these paths.
 *
 * Rejects: no signature at all, signatures that don't match the exact
 * method+path+body, expired/replayed timestamps, unknown devices. The bound
 * deviceId is attached as request.authenticatedAgentId.
 */
function requireAgentSignature(request, reply, agentAuthService, done) {
  const header = String(request.headers["x-agent-auth"] || "");
  if (!header) {
    reply.code(401).send({ error: "agent signature required" });
    return false;
  }
  const result = agentAuthService.verifyAgentHeader(request, request.rawBody || Buffer.alloc(0));
  if (!result.ok) {
    reply.code(401).send({ error: "unauthorized", reason: result.reason });
    return false;
  }
  request.authenticatedAgentId = result.deviceId;
  done();
  return true;
}

function registerPairingRoutes(app, { agentAuthService, config }) {
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
      origin: serverOrigin(request, config),
    });
    const session = pairing.getSession(created.pairingSessionId);
    return { ...created, qr: pairing.qrPayload(session) };
  });

  // ── Web: poll pairing status (anonymous OK; single-use consume) ────────
  app.get("/api/v1/pairing/status", {
    schema: {
      summary: "Poll pairing status; consumes the certificate exactly once",
      description:
        "ADR-007 §5: returns {state:'PENDING'} while waiting; on approval returns the " +
        "Android-signed DeviceCertificate + transcriptHash ONCE and destroys the session. " +
        "The web MUST verify the certificate binding locally before trusting it.",
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
    const session = pairing.getSession(request.params.id);
    if (!session) {
      const err = new Error("pairing session not found or expired");
      err.statusCode = 404;
      throw err;
    }
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
        required: ["pairingSessionId", "certificate", "deviceId", "transcriptHash"],
        additionalProperties: false,
        properties: {
          pairingSessionId: { type: "string", maxLength: 128 },
          certificate: { type: "string", maxLength: 16384 },
          deviceId: { type: "string", maxLength: 128 },
          transcriptHash: { type: "string", maxLength: 128 },
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
    const body = request.body || {};
    return pairing.approveSession(body.pairingSessionId, {
      certificate: body.certificate,
      deviceId: body.deviceId,
      transcriptHash: body.transcriptHash,
    });
  });
}

module.exports = { registerPairingRoutes, serverOrigin };
