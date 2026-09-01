"use strict";

/**
 * ADR-007 — Primary-Device QR Pairing: pairing-session store (security
 * revision P0-1..P0-8, P1-1..P1-3).
 *
 * Trust model: the ANDROID AGENT (primary trust device) approves a web
 * browser and signs its DeviceCertificate. GMweb is a relay — it can never
 * make a browser trusted by itself.
 *
 * Security properties enforced here:
 *   P0-5  origin is SERVER-owned (PUBLIC_WEB_ORIGIN / request host), never
 *         client-supplied.
 *   P0-8  canonical transcript hash (SHA-256 over versioned canonical JSON)
 *         is computed here; Android signs THAT hash and the web re-computes
 *         it — substitution between QR and approval is detectable.
 *   P1-1  a dedicated ephemeral pairing keypair field (separate from the
 *         operational signing identity).
 *   P1-3  bounded memory: global + per-IP active-session caps, strict
 *         field-size limits, 429 on capacity, lazy GC.
 *   P0-1  single-use approve + single-use consume; expiry is absolute.
 *
 * RawBody capture and agent-signature enforcement live in server.js /
 * pairingRoutes.js — this module stays pure (testable without HTTP).
 */

const crypto = require("node:crypto");

const PAIRING_TTL_MS = 120_000; // ADR-007 §2: 90–120s recommended
const PAIRING_VERSION = 1;
const TRANSCRIPT_VERSION = 1;

// P1-3 — hard capacity limits (no unbounded public Map).
const MAX_GLOBAL_SESSIONS = 200;
const MAX_SESSIONS_PER_IP = 5;

// P1-3 — strict field size limits (chars).
const LIMITS = {
  webDeviceId: 128,
  publicKey: 512, // base64 P-256 SPKI/raw ≪ this
  nonce: 128,
};

class CapacityError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 429;
  }
}

const sessions = new Map(); // pairingSessionId -> session
const perIp = new Map(); // ip -> Set<pairingSessionId>

function newId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function now() {
  return Date.now();
}

function gc() {
  const t = now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= t || s.state === "CONSUMED") {
      sessions.delete(id);
      const set = perIp.get(s.ip);
      if (set) {
        set.delete(id);
        if (set.size === 0) perIp.delete(s.ip);
      }
    }
  }
}

function assertField(name, value, max) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    const err = new Error(`${name} must be a non-empty string of at most ${max} chars`);
    err.statusCode = 400;
    throw err;
  }
  return value;
}

/**
 * P0-8 — canonical transcript + hash. The canonical form is versioned:
 * JSON with FIXED key order over exactly these fields. Android signs
 * `transcriptHash`; the web independently re-computes and compares.
 */
function canonicalTranscript(t) {
  return JSON.stringify({
    v: TRANSCRIPT_VERSION,
    pairingSessionId: t.pairingSessionId,
    webDeviceId: t.webDeviceId,
    webSigningPublicKey: t.webSigningPublicKey,
    webEncryptionPublicKey: t.webEncryptionPublicKey,
    ephemeralPublicKey: t.ephemeralPublicKey,
    nonce: t.nonce,
    origin: t.origin,
    expiresAt: t.expiresAt,
  });
}

function transcriptHash(t) {
  return crypto.createHash("sha256").update(Buffer.from(canonicalTranscript(t), "utf8")).digest("hex");
}

/**
 * Create a pairing session.
 *
 * @param {object} p transcript fields from the web client (origin is IGNORED
 *   if present — P0-5: server owns origin)
 * @param {object} ctx { ip, origin } — server-derived values only
 */
function createSession(p, ctx) {
  gc();
  const ip = String((ctx && ctx.ip) || "unknown");
  // P1-3 — per-IP + global caps.
  let set = perIp.get(ip);
  if (set && set.size >= MAX_SESSIONS_PER_IP) {
    throw new CapacityError("too many active pairing sessions from this address");
  }
  if (sessions.size >= MAX_GLOBAL_SESSIONS) {
    throw new CapacityError("pairing session capacity reached");
  }

  // P1-3 — strict limits on every client-supplied field.
  const webDeviceId = assertField("webDeviceId", p.webDeviceId, LIMITS.webDeviceId);
  const webSigningPublicKey = assertField("webSigningPublicKey", p.webSigningPublicKey, LIMITS.publicKey);
  const webEncryptionPublicKey = assertField("webEncryptionPublicKey", p.webEncryptionPublicKey, LIMITS.publicKey);
  const ephemeralPublicKey = assertField("ephemeralPublicKey", p.ephemeralPublicKey, LIMITS.publicKey);
  const nonce = assertField("nonce", p.nonce, LIMITS.nonce);

  // P1-1 — the ephemeral key must NOT be the operational signing key
  // (two purposes). The server refuses a transcript that reuses it.
  if (ephemeralPublicKey === webSigningPublicKey) {
    const err = new Error("ephemeralPublicKey must differ from webSigningPublicKey (P1-1)");
    err.statusCode = 400;
    throw err;
  }

  // P0-5 — origin is SERVER-owned. Client-supplied origin is never trusted.
  const origin = String((ctx && ctx.origin) || "").slice(0, 256);
  if (!origin.startsWith("https://")) {
    const err = new Error("server origin must be an HTTPS URL (PUBLIC_WEB_ORIGIN / Host)");
    err.statusCode = 500;
    throw err;
  }

  const id = newId(18);
  const session = {
    pairingSessionId: id,
    version: PAIRING_VERSION,
    webDeviceId,
    webSigningPublicKey,
    webEncryptionPublicKey,
    ephemeralPublicKey, // P1-1: dedicated pairing-ephemeral key
    nonce,
    origin,
    createdAt: now(),
    expiresAt: now() + PAIRING_TTL_MS,
    ip,
    state: "PENDING", // PENDING → APPROVED → CONSUMED
    approved: null,
  };
  session.transcriptHash = transcriptHash(session);
  sessions.set(id, session);
  if (!set) perIp.set(ip, (set = new Set()));
  set.add(id);
  return {
    pairingSessionId: session.pairingSessionId,
    expiresAt: session.expiresAt,
    ttlSeconds: Math.round(PAIRING_TTL_MS / 1000),
  };
}

function getSession(pairingSessionId) {
  gc();
  return sessions.get(String(pairingSessionId || "")) || null;
}

/**
 * Android approval — callers MUST have enforced agent auth BEFORE calling
 * (P0-2 lives in pairingRoutes.js). The transcriptHash here is the one
 * Android signed; the web compares it against its own re-computation.
 */
function approveSession(pairingSessionId, { certificate, deviceId, transcriptHash }) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  if (!s) {
    const err = new Error("pairing session not found or expired");
    err.statusCode = 404;
    throw err;
  }
  if (s.state !== "PENDING") {
    const err = new Error("pairing session already used");
    err.statusCode = 409;
    throw err;
  }
  if (!certificate || !deviceId) {
    const err = new Error("certificate and deviceId are required");
    err.statusCode = 400;
    throw err;
  }
  s.state = "APPROVED";
  s.approved = {
    certificate: String(certificate).slice(0, 16384),
    deviceId: String(deviceId).slice(0, 128),
    // P0-8: hash Android signed — the web MUST match it locally.
    transcriptHash: String(transcriptHash || "").slice(0, 128),
    approvedAt: now(),
  };
  return { ok: true, state: s.state };
}

/** Web consumes the approval once (session destroyed after). */
function consumeApproval(pairingSessionId) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  if (!s) return null;
  if (s.state !== "APPROVED" || !s.approved) return null;
  sessions.delete(String(pairingSessionId));
  const set = perIp.get(s.ip);
  if (set) {
    set.delete(String(pairingSessionId));
    if (set.size === 0) perIp.delete(s.ip);
  }
  return {
    state: "APPROVED",
    certificate: s.approved.certificate,
    deviceId: s.approved.deviceId,
    transcriptHash: s.approved.transcriptHash,
    approvedAt: s.approved.approvedAt,
  };
}

/** The QR payload the web renders (no secrets; includes server origin). */
function qrPayload(session) {
  return {
    version: session.version,
    pairingSessionId: session.pairingSessionId,
    webDeviceId: session.webDeviceId,
    webSigningPublicKey: session.webSigningPublicKey,
    webEncryptionPublicKey: session.webEncryptionPublicKey,
    ephemeralPublicKey: session.ephemeralPublicKey,
    nonce: session.nonce,
    origin: session.origin,
    expiresAt: session.expiresAt,
  };
}

/** Expose the canonical hash so routes/tests can assert consistency. */
function hashOf(session) {
  return transcriptHash(session);
}

function _reset() {
  sessions.clear();
  perIp.clear();
}

module.exports = {
  PAIRING_TTL_MS,
  MAX_GLOBAL_SESSIONS,
  MAX_SESSIONS_PER_IP,
  CapacityError,
  canonicalTranscript,
  transcriptHash,
  createSession,
  getSession,
  approveSession,
  consumeApproval,
  qrPayload,
  hashOf,
  _reset,
};
