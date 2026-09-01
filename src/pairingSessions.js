"use strict";

/**
 * ADR-007 — Primary-Device QR Pairing: pairing-session relay.
 *
 * The Web/PWA NEVER bootstraps trust (no passkey-first first-run). Instead it
 * creates a short-lived pairing SESSION and renders its transcript as a QR
 * code; the Android Agent (primary trust device) scans it, shows the details
 * to the user behind BiometricPrompt, and SIGNS the DeviceCertificate that
 * makes the browser trusted. GMweb is only a relay/store — it can never make
 * a browser trusted by itself (§4).
 *
 * Session properties (§2): single-use, TTL 120s, origin-bound, accountless
 * until Android approves. The transcript is NOT a bearer secret: possessing
 * the QR alone grants nothing without the Android approval + signature.
 *
 * v1 scope: session lifecycle + approval relay + certificate store-and-
 * forward. Web-side keypairs are generated client-side; the server never
 * sees private keys.
 */

const PAIRING_TTL_MS = 120_000; // ADR-007 §2: 90–120s recommended
const PAIRING_VERSION = 1;

/** In-memory pairing sessions (durable enough for a 2-minute dance; a lost
 *  session is re-created by refreshing the QR — nothing to migrate). */
const sessions = new Map(); // pairingSessionId -> session

function newId(bytes = 16) {
  return require("node:crypto").randomBytes(bytes).toString("base64url");
}

function now() {
  return Date.now();
}

/** Drop expired sessions lazily (called on every access). */
function gc() {
  const t = now();
  for (const [id, s] of sessions) {
    if (s.expiresAt <= t || s.state === "CONSUMED") sessions.delete(id);
  }
}

/**
 * Create a pairing session from the web client's locally-generated
 * transcript. The request body IS the QR payload (server adds ids/expiry).
 */
function createSession({ webDeviceId, webSigningPublicKey, webEncryptionPublicKey, ephemeralPublicKey, nonce, origin }) {
  gc();
  if (!webDeviceId || !webSigningPublicKey || !webEncryptionPublicKey || !ephemeralPublicKey || !nonce) {
    const err = new Error("webDeviceId, webSigningPublicKey, webEncryptionPublicKey, ephemeralPublicKey and nonce are required");
    err.statusCode = 400;
    throw err;
  }
  const id = newId(18);
  const session = {
    pairingSessionId: id,
    version: PAIRING_VERSION,
    webDeviceId: String(webDeviceId).slice(0, 128),
    webSigningPublicKey: String(webSigningPublicKey),
    webEncryptionPublicKey: String(webEncryptionPublicKey),
    ephemeralPublicKey: String(ephemeralPublicKey),
    nonce: String(nonce),
    origin: String(origin || "").slice(0, 256),
    createdAt: now(),
    expiresAt: now() + PAIRING_TTL_MS,
    state: "PENDING", // PENDING → APPROVED → CONSUMED (or EXPIRED)
    approved: null,   // {certificate, deviceId, approvedAt} once Android signs
  };
  sessions.set(id, session);
  return {
    pairingSessionId: session.pairingSessionId,
    expiresAt: session.expiresAt,
    ttlSeconds: Math.round(PAIRING_TTL_MS / 1000),
  };
}

/** Fetch a live session (for Android metadata fetch + web status polling). */
function getSession(pairingSessionId) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  return s || null;
}

/**
 * Android approval: store the signed DeviceCertificate against the session,
 * flip state to APPROVED, and consume the session (single-use). The next web
 * status poll picks it up and the session is then destroyed.
 */
function approveSession(pairingSessionId, { certificate, deviceId }) {
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
    approvedAt: now(),
  };
  return { ok: true, state: s.state };
}

/** Web consumes the approval once (single-use; session destroyed after). */
function consumeApproval(pairingSessionId) {
  gc();
  const s = sessions.get(String(pairingSessionId || ""));
  if (!s) return null;
  if (s.state !== "APPROVED" || !s.approved) return null;
  sessions.delete(String(pairingSessionId)); // single-use
  return {
    state: "APPROVED",
    certificate: s.approved.certificate,
    deviceId: s.approved.deviceId,
    approvedAt: s.approved.approvedAt,
  };
}

/** Build the QR transcript payload the web client renders (no secrets). */
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

/** Test/admin helper. */
function _reset() {
  sessions.clear();
}

module.exports = {
  PAIRING_TTL_MS,
  createSession,
  getSession,
  approveSession,
  consumeApproval,
  qrPayload,
  _reset,
};
