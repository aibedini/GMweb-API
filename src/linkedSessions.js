"use strict";

/**
 * POST-PAIR SECURE BOOTSTRAP — linked-device sessions.
 *
 * Server-side, device-bound session tokens issued ONLY through
 * POST /api/v1/pairing/complete after the browser proves possession of its
 * signing key against the Android-approved certificate. Delivered as an
 * HttpOnly Secure SameSite=Strict cookie — never localStorage/sessionStorage.
 * Capability-scoped: the session carries exactly the certificate's
 * capabilities; requireToken maps them to routes.
 */
const crypto = require("crypto");

const COOKIE_NAME = "gmweb_linked_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const sessions = new Map(); // tokenHash -> { deviceId, capabilities, trustSequence, createdAt }

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/**
 * Issue a linked-device session for an approved certificate.
 * capabilities: string[] from the verified DeviceCertificate.
 */
function issue(deviceId, capabilities, trustSequence = 0) {
  gc();
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(hashToken(token), {
    deviceId: String(deviceId).slice(0, 128),
    capabilities: (Array.isArray(capabilities) ? capabilities : [])
      .map((c) => String(c).slice(0, 64))
      .slice(0, 32),
    trustSequence: Number(trustSequence) || 0,
    createdAt: Date.now(),
  });
  return token;
}

/** Resolve a cookie token to its session, or null. */
function resolve(token) {
  gc();
  if (!token) return null;
  const session = sessions.get(hashToken(token));
  if (session) touch(token);
  return session || null;
}

/** Revoke everything for a device (Android DEVICE_REVOKED). */
function revokeDevice(deviceId) {
  const want = String(deviceId || "");
  for (const [h, s] of sessions) {
    if (s.deviceId === want) sessions.delete(h);
  }
}

/**
 * Server-observed telemetry for Android (no tokens ever). Presence window:
 * a device is "online now" if it resolved its session in the last 90s.
 */
function telemetry() {
  gc();
  const now = Date.now();
  const byDevice = new Map();
  for (const [h, s] of sessions) {
    const seen = lastSeen.get(h) || s.createdAt;
    const entry = byDevice.get(s.deviceId) || {
      deviceId: s.deviceId,
      sessionActive: true,
      lastSeenAt: seen,
      sessionExpiresAt: s.createdAt + SESSION_TTL_MS,
      onlineNow: false,
    };
    entry.lastSeenAt = Math.max(entry.lastSeenAt, seen);
    entry.onlineNow = now - seen < 90_000;
    byDevice.set(s.deviceId, entry);
  }
  return [...byDevice.values()];
}

// throttled last-seen (max once per 45s per session token)
const lastSeen = new Map();
function touch(token) {
  const now = Date.now();
  const h = hashToken(token);
  const prev = lastSeen.get(h) || 0;
  if (now - prev > 45_000) lastSeen.set(h, now);
}

function gc() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [h, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(h);
  }
}

module.exports = { COOKIE_NAME, SESSION_TTL_MS, issue, resolve, revokeDevice, telemetry };
