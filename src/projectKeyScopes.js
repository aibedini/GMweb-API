"use strict";

const PROJECT_KEY_SCOPES = Object.freeze([
  "sms.send",
  "sms.status",
  "sms.cancel",
  "sms.capacity",
  "conversations.read",
  "events.read",
  "commands.create",
  "commands.read",
]);

// Existing project keys predate scopes. Limit them to the documented legacy
// consumer surface; command-engine access always requires an explicit opt-in.
const DEFAULT_PROJECT_KEY_SCOPES = Object.freeze([
  "sms.send",
  "sms.status",
  "sms.cancel",
  "sms.capacity",
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
  if (verb === "POST" && pathname.startsWith("/send/cancel/")) return "sms.cancel";
  if (verb === "GET" && (pathname === "/send/capacity" || pathname === "/ready")) return "sms.capacity";
  if (verb === "GET" && pathname === "/events") return "events.read";
  if (pathname === "/conversations" || pathname.startsWith("/conversations/") ||
      pathname === "/messages/active") return "conversations.read";
  if (verb === "POST" && pathname === "/api/v1/commands") return "commands.create";
  if (verb === "GET" && (pathname === "/api/v1/commands" || pathname.startsWith("/api/v1/commands/"))) {
    return "commands.read";
  }
  return null;
}

module.exports = {
  DEFAULT_PROJECT_KEY_SCOPES,
  PROJECT_KEY_SCOPES,
  normalizeProjectKeyScopes,
  requiredProjectKeyScope,
};
