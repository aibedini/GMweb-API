"use strict";
const crypto = require("node:crypto");
const { db } = require("./pairingDb");
const { PROTOCOL, canonicalTranscript, canonicalChallenge } = require("../shared/pairingProtocol.mjs");
const PAIRING_TTL_MS = 120000;
const MAX_GLOBAL_SESSIONS = 200;
const MAX_SESSIONS_PER_IP = 5;
class CapacityError extends Error { constructor(message) { super(message); this.statusCode = 429; } }
function fail(message, statusCode = 400) { throw Object.assign(new Error(message), { statusCode }); }
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
function gc() {
  db().prepare("DELETE FROM pairing_sessions WHERE expires_at <= ?").run(Date.now());
  db().prepare("DELETE FROM pairing_challenges WHERE expires_at <= ?").run(Date.now());
}
function transcriptHash(t) { return hash(canonicalTranscript(t)); }
function createSession(p, ctx) {
  gc();
  const ip = String(ctx.ip || "unknown");
  if (db().prepare("SELECT count(*) n FROM pairing_sessions WHERE ip = ?").get(ip).n >= MAX_SESSIONS_PER_IP)
    throw new CapacityError("too many active pairing sessions from this address");
  if (db().prepare("SELECT count(*) n FROM pairing_sessions").get().n >= MAX_GLOBAL_SESSIONS)
    throw new CapacityError("pairing session capacity reached");
  for (const [name, max] of Object.entries({ webDeviceId: 128, webSigningPublicKey: 512,
    webEncryptionPublicKey: 512, ephemeralPublicKey: 512, nonce: 128 })) {
    if (typeof p[name] !== "string" || !p[name] || p[name].length > max) fail(`${name} must be a non-empty string of at most ${max} chars`);
  }
  if (p.ephemeralPublicKey === p.webSigningPublicKey) fail("ephemeralPublicKey must differ from webSigningPublicKey");
  const webOrigin = String(ctx.origin || "");
  const apiOrigin = String(ctx.apiOrigin || webOrigin);
  for (const origin of [webOrigin, apiOrigin]) {
    let url;
    try { url = new URL(origin); } catch { fail("server origin must be an HTTPS URL", 500); }
    if (url.protocol !== "https:" || url.origin !== origin) fail("server origin must be an HTTPS origin", 500);
  }
  const pollSecret = crypto.randomBytes(24).toString("base64url");
  const session = { pairingSessionId: crypto.randomBytes(18).toString("base64url"),
    version: 1, protocol: PROTOCOL, webDeviceId: p.webDeviceId,
    webSigningPublicKey: p.webSigningPublicKey, webEncryptionPublicKey: p.webEncryptionPublicKey,
    ephemeralPublicKey: p.ephemeralPublicKey, nonce: p.nonce,
    origin: webOrigin, apiOrigin, webOrigin, createdAt: Date.now(), expiresAt: Date.now() + PAIRING_TTL_MS,
    ip, pollSecretHash: hash(pollSecret), state: "PENDING", approved: null };
  session.transcriptHash = transcriptHash(session);
  db().prepare("INSERT INTO pairing_sessions VALUES (?, ?, ?, ?)")
    .run(session.pairingSessionId, ip, session.expiresAt, JSON.stringify(session));
  return { pairingSessionId: session.pairingSessionId, expiresAt: session.expiresAt, ttlSeconds: 120, pollSecret };
}
function getSession(id) {
  gc();
  const row = db().prepare("SELECT payload FROM pairing_sessions WHERE id = ?").get(String(id || ""));
  return row ? JSON.parse(row.payload) : null;
}
function pollSecretMatches(s, secret) {
  if (!s || !secret) return false;
  return crypto.timingSafeEqual(Buffer.from(s.pollSecretHash), Buffer.from(hash(secret)));
}
function approveSession(id, approval) {
  const s = getSession(id);
  if (!s) fail("pairing session not found or expired", 404);
  if (s.state !== "PENDING") fail("pairing session already used", 409);
  if (!approval.certificate || !approval.deviceId) fail("certificate and deviceId are required");
  s.state = "APPROVED";
  s.approved = { ...approval, sessionChallenge: crypto.randomBytes(32).toString("hex"),
    challengeIssuedAt: Date.now(), approvedAt: Date.now() };
  db().prepare("UPDATE pairing_sessions SET payload = ? WHERE id = ?").run(JSON.stringify(s), id);
  return { ok: true, state: s.state };
}
function consumeApproval(id, secret) {
  const s = getSession(id);
  if (!s || !pollSecretMatches(s, secret) || s.state !== "APPROVED") return null;
  const a = s.approved;
  const challenge = { pairingSessionId: id, challenge: a.sessionChallenge, deviceId: a.deviceId,
    certificate: a.certificate, trustRootPublicKey: a.trustRootPublicKey,
    apiOrigin: s.apiOrigin, webOrigin: s.webOrigin, issuedAt: a.challengeIssuedAt };
  db().prepare("INSERT INTO pairing_challenges VALUES (?, ?, ?, ?)")
    .run(hash(secret), a.deviceId, Date.now() + 600000, JSON.stringify(challenge));
  db().prepare("DELETE FROM pairing_sessions WHERE id = ?").run(id);
  return { state: "APPROVED", certificate: a.certificate, deviceId: a.deviceId,
    transcriptHash: a.transcriptHash, trustRootPublicKey: a.trustRootPublicKey, approvedAt: a.approvedAt };
}
function peekChallenge(secret) {
  gc();
  const row = db().prepare("SELECT payload FROM pairing_challenges WHERE id = ?").get(hash(secret || ""));
  return row ? JSON.parse(row.payload) : null;
}
function burnChallenge(secret) {
  return db().prepare("DELETE FROM pairing_challenges WHERE id = ? AND expires_at > ?")
    .run(hash(secret || ""), Date.now()).changes === 1;
}
function challengeCanonical(deviceId, challenge, webOrigin, issuedAt, pairingSessionId, apiOrigin) {
  return Buffer.from(canonicalChallenge({deviceId, challenge, webOrigin, issuedAt, pairingSessionId, apiOrigin}), "utf8");
}
function qrPayload(s) {
  const { version, protocol, pairingSessionId, webDeviceId, webSigningPublicKey, webEncryptionPublicKey,
    ephemeralPublicKey, nonce, origin, apiOrigin, webOrigin, expiresAt, transcriptHash } = s;
  return { version, protocol, pairingSessionId, webDeviceId, webSigningPublicKey, webEncryptionPublicKey,
    ephemeralPublicKey, nonce, origin, apiOrigin, webOrigin, expiresAt, transcriptHash };
}
const atomic = fn => (...args) => db().transaction(() => fn(...args)).immediate();
function _reset() { db().exec("DELETE FROM pairing_sessions; DELETE FROM pairing_challenges;"); }
module.exports = { PAIRING_TTL_MS, MAX_GLOBAL_SESSIONS, MAX_SESSIONS_PER_IP, CapacityError,
  canonicalTranscript, transcriptHash, createSession: atomic(createSession), getSession,
  approveSession: atomic(approveSession), consumeApproval: atomic(consumeApproval), peekChallenge,
  burnChallenge, challengeCanonical, pollSecretMatches, qrPayload, hashOf: transcriptHash,
  canonicalBytes: canonicalTranscript, _reset };
