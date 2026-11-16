"use strict";

/**
 * XR-GA-008 / `xr-ga-008-device-token` — linked-session authorization.
 *
 * ONE decision point for both linked-device credentials:
 *
 *   * `gmweb_linked_session` cookie — the browser (WEB_PWA) credential, with
 *     the original eight-branch capability whitelist.
 *   * `Authorization: Device <token>` — the native/AI_AGENT credential issued
 *     by `/api/v1/pairing/complete`. The device token is accepted ONLY on the
 *     same `/api/v1/` surface and goes through the SAME whitelist and the SAME
 *     `request.linkedDevice` binding as the cookie. It is never a substitute
 *     for Bearer/API-key/admin authentication.
 *
 * Security properties enforced here:
 *   - a valid cookie always wins (cookie behaviour is unchanged);
 *   - a `Device` header never falls through to the normal auth ladder — an
 *     invalid, expired or revoked token is a hard `401 invalid_device_token`,
 *     including on non-`/api/v1/` paths such as `/admin/*`;
 *   - a valid token outside the whitelist is `403 capability_denied`, exactly
 *     like an out-of-scope cookie request;
 *   - the raw token is only ever handed to `linkedSessions.observe`, which
 *     stores its SHA-256 hash; it is never logged, echoed or persisted here.
 *
 * Extracted from `src/server.js` so the production decision is injectable in
 * the test harness (server.js cannot be required by a test worker because it
 * opens the control-plane SQLite DB and BullMQ sockets at module load).
 */

const linkedSessions = require("./linkedSessions");

const DEVICE_AUTH_SCHEME = "device";

/**
 * Parse `Authorization: Device <token>` (scheme is case-insensitive per
 * RFC 9110). Returns `null` when the scheme is anything else — a Bearer header
 * must keep flowing to the existing auth ladder unchanged — and the token
 * string (possibly empty) when the Device scheme is present.
 */
function deviceTokenFromAuthorization(value) {
  const header = String(value || "").trim();
  if (!header) return null;
  // Linear scan (no regex): the Authorization value is attacker-controlled and
  // a nested-quantifier pattern here is a polynomial-ReDoS candidate.
  let split = -1;
  for (let index = 0; index < header.length; index++) {
    const code = header.charCodeAt(index);
    if (code === 0x20 || code === 0x09) { split = index; break; }
  }
  if (split === -1) {
    // A bare `Device` scheme is a present-but-empty credential: fail closed
    // instead of treating it as "no Device header" and falling through.
    return header.toLowerCase() === DEVICE_AUTH_SCHEME ? "" : null;
  }
  if (header.slice(0, split).toLowerCase() !== DEVICE_AUTH_SCHEME) return null;
  return header.slice(split + 1).trim();
}

/** Path-only helper (the auth decision never looks at query parameters). */
function pathOnly(url) {
  return String(url || "").split("?")[0] || "/";
}

/**
 * The linked-device capability whitelist. Unchanged from the cookie-era gate,
 * plus `POST /api/v1/sync/ack` for READ_MESSAGES (the AI_AGENT transport
 * acknowledges processed events; it exposes no additional data).
 */
function linkedSessionPathAllowed(session, method, path) {
  const caps = Array.isArray(session?.capabilities) ? session.capabilities : [];
  const p = String(path || "");
  return (
    (caps.includes("READ_MESSAGES") &&
      method === "GET" &&
      (p === "/api/v1/sync" ||
        p === "/api/v1/sse" ||
        p === "/api/v1/web/bootstrap" ||
        p === "/api/v1/web/snapshot-v2" ||
        p === "/api/v1/web/conversations" ||
        p.startsWith("/api/v1/web/conversations/") ||
        p === "/api/v1/linked-device/sync-diagnostics" ||
        p === "/api/v1/linked-device/sessions" ||
        p === "/api/v1/linked-device/key-grants" ||
        p === "/api/v1/linked-device/keyring" ||
        p === "/api/v1/linked-device/replication-capabilities" ||
        p === "/api/v1/linked-session" ||
        p.startsWith("/api/v1/trust/"))) ||
    (caps.includes("READ_MESSAGES") && method === "POST" &&
      (p === "/api/v1/sync/ack" ||
        p === "/api/v1/web/sync/ack" ||
        p === "/api/v1/web/snapshot-v2" ||
        p === "/api/v1/web/conversations/changed")) ||
    (caps.includes("READ_MESSAGES") && method === "GET" &&
      (p === "/api/v1/linked-device/telemetry" || p === "/api/v1/linked-device/status")) ||
    (caps.includes("CONTACTS_READ") && method === "GET" &&
      p === "/api/v1/linked-device/contacts/events") ||
    ((caps.includes("SEND_MESSAGES") || caps.includes("MARK_READ") || caps.includes("AI_SUGGEST")) &&
      method === "GET" &&
      p === "/api/v1/linked-device/command-key") ||
    ((caps.includes("SEND_MESSAGES") || caps.includes("MARK_READ") || caps.includes("AI_SUGGEST")) &&
      (p === "/api/v1/commands" || p.startsWith("/api/v1/commands/"))) ||
    (caps.includes("READ_PAIRING_DIAGNOSTICS") &&
      method === "GET" && p === "/api/v1/pairing/diagnostics") ||
    (p === "/api/v1/linked-session" && ["GET", "DELETE"].includes(method))
  );
}

/** Paths whose successful access counts as "content read" for presence. */
function linkedSessionDataRead(path) {
  const p = String(path || "");
  return p === "/api/v1/sync" ||
    p === "/api/v1/web/bootstrap" ||
    p === "/api/v1/web/snapshot-v2" ||
    p === "/api/v1/web/conversations" ||
    p.startsWith("/api/v1/web/conversations/") ||
    p === "/api/v1/linked-device/contacts/events";
}

/**
 * Apply the linked-session branch of the global `requireToken` hook.
 *
 * @returns {"allowed"|"denied"|"none"}
 *   `allowed` — `request.linkedDevice` (and `request.linkedDeviceToken`) are
 *               bound and the caller must continue the request (`done()`);
 *               presence was observed with the token's hash.
 *   `denied`  — the reply has already been sent; the caller must stop and must
 *               NOT fall through to any other authentication path.
 *   `none`    — no linked credential was presented; the caller keeps running
 *               the normal auth ladder. A present-but-invalid `Device` header
 *               never returns `none`.
 */
function authorizeLinkedSession(request, reply) {
  const cookieToken = request.cookies
    ? request.cookies[linkedSessions.COOKIE_NAME]
    : "";
  const cookieSession = linkedSessions.resolve(cookieToken);
  const path = pathOnly(request.url);

  if (cookieSession && path.startsWith("/api/v1/")) {
    if (!linkedSessionPathAllowed(cookieSession, request.method, path)) {
      // A linked browser must not silently fall through to bearer auth with
      // its cookie — fail closed for out-of-scope paths.
      reply.code(403).send({ error: "capability_denied" });
      return "denied";
    }
    request.linkedDevice = cookieSession;
    request.linkedDeviceToken = cookieToken;
    linkedSessions.observe(cookieToken, request.ip, request.headers?.["user-agent"],
      linkedSessionDataRead(path));
    return "allowed";
  }

  const deviceToken = deviceTokenFromAuthorization(request.headers?.authorization);
  // No Device credential, or the valid cookie already decided this request.
  if (deviceToken === null || cookieSession) return "none";

  const deviceSession = linkedSessions.resolve(deviceToken);
  if (!deviceSession) {
    reply.code(401).send({ error: "invalid_device_token" });
    return "denied";
  }
  // A device token is a linked-device API credential only. It must never be
  // considered by admin/dashboard/gateway/agent bearer handlers, not even when
  // the token itself is valid.
  if (!path.startsWith("/api/v1/")) {
    reply.code(401).send({ error: "unauthorized" });
    return "denied";
  }
  if (!linkedSessionPathAllowed(deviceSession, request.method, path)) {
    reply.code(403).send({ error: "capability_denied" });
    return "denied";
  }
  request.linkedDevice = deviceSession;
  request.linkedDeviceToken = deviceToken;
  // observe() hashes the token before touching linked_session_presence; the
  // raw value is never stored, logged or returned.
  linkedSessions.observe(deviceToken, request.ip, request.headers?.["user-agent"],
    linkedSessionDataRead(path));
  return "allowed";
}

module.exports = {
  DEVICE_AUTH_SCHEME,
  deviceTokenFromAuthorization,
  linkedSessionPathAllowed,
  linkedSessionDataRead,
  authorizeLinkedSession,
};
