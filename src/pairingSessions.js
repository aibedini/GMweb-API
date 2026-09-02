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
  // HARDENING: a poll secret is generated server-side and returned to the
  // web client exactly once. Only its SHA-256 is stored; the QR never
  // carries it (Android never sees it). /pairing/status requires it, so a
  // QR screenshot cannot consume the approval race-style.
  const pollSecret = newId(24);
  const pollSecretHash = crypto.createHash("sha256").update(pollSecret).digest("hex");
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
    pollSecretHash,
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
    pollSecret, // returned ONCE to the creating browser (never stored raw)
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
function approveSession(pairingSessionId, { certificate, deviceId, transcriptHash, trustRootPublicKey }) {
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
  // POST-PAIR SECURE BOOTSTRAP: a single-use challenge bound to the device,
  // consumed by POST /api/v1/pairing/complete where the browser proves
  // possession of its (non-extractable) signing key. Short expiry.
  s.approved = {
    certificate: String(certificate).slice(0, 16384),
    deviceId: String(deviceId).slice(0, 128),
    // P0-8: hash Android signed — the web MUST match it locally.
    transcriptHash: String(transcriptHash || "").slice(0, 128),
    // BLOCKER 1: the Android Trust Root public key is pinned here so the web
    // can verify rootSignature itself (obtain/pin from pairing bootstrap).
    trustRootPublicKey: String(trustRootPublicKey || "").slice(0, 512),
    sessionChallenge: crypto.randomBytes(32).toString("hex"),
    challengeIssuedAt: now(),
    approvedAt: now(),
  };
  return { ok: true, state: s.state };
}

/** Consume (null out) the challenge — called ONLY by /pairing/complete
 *  after signature verification succeeds. Returns true if it was present. */
function consumeChallenge(pairingSessionId, pollSecret) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  if (!s || !pollSecretMatches(s, pollSecret)) return false;
  if (s.state !== "APPROVED" || !s.approved || !s.approved.sessionChallenge) return false;
  s.approved.sessionChallenge = null;
  return true;
}

/** Canonical challenge bytes the browser signs (shared contract v1). */
function challengeCanonical(deviceId, challenge, origin, issuedAt) {
  return Buffer.from(
    ["GMweb-Link-Session-v1", deviceId, challenge, origin, String(issuedAt)].join("\n"),
    "utf8"
  );
}

/** Single-use challenge consumption for session issuance. */
function takeChallenge(pairingSessionId, pollSecret) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  if (!s || !pollSecretMatches(s, pollSecret)) return null;
  if (s.state !== "APPROVED" || !s.approved) return null;
  if (now() - s.approved.challengeIssuedAt > 10 * 60 * 1000) {
    sessions.delete(String(pairingSessionId));
    return null;
  }
  const c = s.approved.sessionChallenge;
  if (!c) return null; // already consumed (single use)
  return {
    challenge: c,
    deviceId: s.approved.deviceId,
    certificate: s.approved.certificate,
    trustRootPublicKey: s.approved.trustRootPublicKey,
    challengeIssuedAt: s.approved.challengeIssuedAt,
  };
}

/** Constant-time compare for poll secrets. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** True when [pollSecret] matches the session's stored hash. */
function pollSecretMatches(session, pollSecret) {
  if (!session || !pollSecret) return false;
  const hash = crypto.createHash("sha256").update(String(pollSecret)).digest("hex");
  return safeEqual(hash, session.pollSecretHash);
}

/**
 * Challenges that survived certificate consumption (POST-PAIR SECURE
 * BOOTSTRAP). Keyed by pollSecretHash so only the browser that created the
 * pairing session can read/burn its challenge. TTL 10 min.
 */
const pendingChallenges = new Map(); // pollSecretHash -> {challenge, deviceId, certificate, issuedAt, expiresAt}

/** Peek the challenge after approval (does NOT burn). */
function peekChallenge(pollSecret) {
  gc();
  const h = challengeHash(pollSecret);
  const rec = pendingChallenges.get(h);
  if (!rec || Date.now() - rec.issuedAt > 10 * 60 * 1000) return null;
  return { ...rec };
}

/** Burn the challenge after signature verification (single use). */
function burnChallenge(pollSecret) {
  return pendingChallenges.delete(challengeHash(pollSecret));
}

function challengeHash(pollSecret) {
  return crypto.createHash("sha256").update(String(pollSecret || "")).digest("hex");
}

/** Web consumes the approval once (session destroyed after). */
function consumeApproval(pairingSessionId, pollSecret) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  if (!s) return null;
  if (!pollSecretMatches(s, pollSecret)) return null;
  if (s.state !== "APPROVED" || !s.approved) return null;
  // POST-PAIR: park the single-use challenge so it survives consumption —
  // the browser still needs it for /pairing/complete after local verify.
  pendingChallenges.set(challengeHash(pollSecret), {
    challenge: s.approved.sessionChallenge,
    deviceId: s.approved.deviceId,
    certificate: s.approved.certificate,
    trustRootPublicKey: s.approved.trustRootPublicKey,
    issuedAt: s.approved.challengeIssuedAt,
  });
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
    trustRootPublicKey: s.approved.trustRootPublicKey,
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

/** Canonical transcript BYTES (Android re-hashes these independently). */
function canonicalBytes(session) {
  return canonicalTranscript(session);
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
  challengeCanonical,
  peekChallenge,
  burnChallenge,
  consumeChallenge,
  consumeApproval,
  qrPayload,
  hashOf,
  canonicalBytes,
  pollSecretMatches,
  _reset,
};
