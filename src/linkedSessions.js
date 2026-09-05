"use strict";
const crypto = require("node:crypto");
const { db } = require("./pairingDb");
const COOKIE_NAME = "gmweb_linked_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = token => crypto.createHash("sha256").update(String(token)).digest("hex");
function gc() { db().prepare("DELETE FROM linked_sessions WHERE expires_at <= ?").run(Date.now()); }
function issue(deviceId, capabilities, trustSequence = 0, certificateExpiresAt = Date.now() + SESSION_TTL_MS) {
  gc();
  const createdAt = Date.now();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Math.min(createdAt + SESSION_TTL_MS, certificateExpiresAt);
  const session = { deviceId, capabilities, trustSequence, createdAt, expiresAt };
  db().prepare("INSERT INTO linked_sessions VALUES (?, ?, ?, ?, ?)")
    .run(hashToken(token), deviceId, expiresAt, createdAt, JSON.stringify(session));
  return token;
}
function resolve(token) {
  if (!token) return null;
  gc();
  const h = hashToken(token);
  const row = db().prepare("SELECT payload, last_seen FROM linked_sessions WHERE token_hash = ?").get(h);
  if (!row) return null;
  if (Date.now() - row.last_seen > 45000)
    db().prepare("UPDATE linked_sessions SET last_seen = ? WHERE token_hash = ?").run(Date.now(), h);
  return JSON.parse(row.payload);
}
function revokeDevice(deviceId) {
  db().transaction(() => {
    db().prepare("DELETE FROM linked_sessions WHERE device_id = ?").run(deviceId);
    db().prepare("DELETE FROM pairing_challenges WHERE device_id = ?").run(deviceId);
    db().prepare("DELETE FROM pairing_sessions WHERE json_extract(payload, '$.webDeviceId') = ?").run(deviceId);
  }).immediate();
}
function telemetry() {
  gc();
  return db().prepare(`SELECT device_id AS deviceId, max(last_seen) AS lastSeenAt,
    max(expires_at) AS sessionExpiresAt FROM linked_sessions GROUP BY device_id`).all()
    .map(row => ({ ...row, sessionActive: true, onlineNow: Date.now() - row.lastSeenAt < 90000 }));
}
module.exports = { COOKIE_NAME, SESSION_TTL_MS, issue, resolve, revokeDevice, telemetry };
