"use strict";

const PROJECT_KEY_SCOPES = Object.freeze([
  "sms.send",
  "sms.status",
  "sms.cancel",
  "sms.capacity",
  "sms.invalidate",
  "conversations.read",
  "events.read",
  "commands.create",
  "commands.read",
  "transport:read",
]);

// Existing project keys predate scopes. Limit them to the documented legacy
// consumer surface; command-engine access always requires an explicit opt-in.
const DEFAULT_PROJECT_KEY_SCOPES = Object.freeze([
  "sms.send",
  "sms.status",
  "sms.cancel",
  "sms.capacity",
  // Lifecycle invalidation is part of the documented Eve surface: a project key
  // created before the scope existed must still be able to revoke a stale
  // reminder after a renewal, so it joins the legacy defaults.
  "sms.invalidate",
  "conversations.read",
  "events.read",
  // Transport health is the same story as invalidation above: the consumer's
  // key was minted before the scope existed. It is read-only operational data
  // about the very bridge that consumer drives, and without it the consumer's
  // health probe is answered with project_scope_denied and every delivery card
  // renders as "unknown".
  "transport:read",
]);

// The defaults that shipped BEFORE transport:read existed.
//
// A persisted key whose scopes are EXACTLY this set was created from these
// defaults - no operator chose them - so extending it is a migration, not a
// privilege grant. Any OTHER explicit set is a deliberate least-privilege
// choice and must never be widened: a key restricted to ["sms.send"] stays
// restricted forever.
const PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES = Object.freeze([
  "sms.send",
  "sms.status",
  "sms.cancel",
  "sms.capacity",
  "sms.invalidate",
  "conversations.read",
  "events.read",
]);

function normalizeProjectKeyScopes(scopes, fallback = DEFAULT_PROJECT_KEY_SCOPES) {
  const requested = Array.isArray(scopes) ? scopes : fallback;
  return [...new Set(requested.map(String).filter((scope) => PROJECT_KEY_SCOPES.includes(scope)))];
}

function requiredProjectKeyScope(method, requestUrl) {
  const verb = String(method || "GET").toUpperCase();
  const pathname = new URL(String(requestUrl || "/"), "http://localhost").pathname;
  if (verb === "POST" && pathname === "/send") return "sms.send";
  if (verb === "GET" && pathname.startsWith("/send/status/")) return "sms.status";
  // Bulk lifecycle invalidation is the same authority as cancelling one send.
  if (verb === "POST" && pathname === "/send/invalidate") return "sms.invalidate";
  if (verb === "POST" && pathname.startsWith("/send/cancel/")) return "sms.cancel";
  if (verb === "GET" && (pathname === "/send/capacity" || pathname === "/ready")) return "sms.capacity";
  if (verb === "GET" && pathname === "/events") return "events.read";
  if (pathname === "/conversations" || pathname.startsWith("/conversations/") ||
      pathname === "/messages/active") return "conversations.read";
  if (verb === "POST" && pathname === "/api/v1/commands") return "commands.create";
  if (verb === "GET" && (pathname === "/api/v1/commands" || pathname.startsWith("/api/v1/commands/"))) {
    return "commands.read";
  }
  // The consumer's own transport-health projection. Read-only by construction:
  // it reports the state of the active delivery transport and never accepts
  // input, so it can never change a delivery decision.
  if (verb === "GET" && pathname === "/eve/v1/transport-health") return "transport:read";
  return null;
}

/**
 * Extend a persisted key that still carries exactly the PREVIOUS defaults.
 *
 * Why this exists: `normalizeProjectKeyScopes` only applies the defaults when a
 * key has NO scopes array. A key persisted by the previous release has an
 * explicit array of the old defaults, so adding `transport:read` to
 * DEFAULT_PROJECT_KEY_SCOPES did NOT reach it and the consumer's health probe
 * was answered with project_scope_denied - the very failure the scope was added
 * to fix.
 *
 * Returns the migrated scope array, or null when nothing should change.
 * Order-insensitive and deduplicating, so a reordered or duplicated file
 * migrates, while a DIFFERENT set of the same size does not.
 */
function migratedProjectKeyScopes(scopes) {
  if (!Array.isArray(scopes)) return null; // load() applies the current defaults
  const stored = [...new Set(scopes.map(String))];
  if (stored.length !== PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES.length) return null;
  const previous = new Set(PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES);
  if (!stored.every((scope) => previous.has(scope))) return null;
  const extended = normalizeProjectKeyScopes([...stored, ...DEFAULT_PROJECT_KEY_SCOPES]);
  // Idempotent: once migrated the stored set is no longer the previous set, so
  // this returns null on every later load.
  return extended.length > stored.length ? extended : null;
}

module.exports = {
  DEFAULT_PROJECT_KEY_SCOPES,
  PREVIOUS_DEFAULT_PROJECT_KEY_SCOPES,
  PROJECT_KEY_SCOPES,
  normalizeProjectKeyScopes,
  migratedProjectKeyScopes,
  requiredProjectKeyScope,
};
