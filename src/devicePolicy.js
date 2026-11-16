"use strict";

/**
 * XR-GA-008 / LDV-002 — device-type capability and command policy.
 *
 * SINGLE SOURCE OF TRUTH: shared/pairing-protocol-v1.json ->
 * capability_definitions + device_type_policy. This module NEVER encodes or
 * decodes a certificate; shared/pairingProtocol.mjs remains the only canonical
 * encoding. It answers exactly two questions:
 *
 *   1. May this device type hold this capability set?  (certificate policy)
 *   2. May this device type create this command type?  (command relay policy)
 *
 * Fail-closed: an unknown device type, an unknown capability, a forbidden
 * capability or a missing required capability is always a violation — there is
 * no default that grants anything. WEB_PWA behaviour is unchanged: base is
 * mandatory and every sensitive/reserved grant stays optional.
 *
 * The startup checks below make a one-sided schema edit impossible: every
 * capability in the universe must be classified exactly once per device type
 * as required / optional / forbidden, and the groups must not overlap.
 */

const SCHEMA = require("../shared/pairing-protocol-v1.json");
const CAPABILITY_DEFINITIONS = SCHEMA.capability_definitions;
const DEVICE_TYPE_POLICY = SCHEMA.device_type_policy;

if (!CAPABILITY_DEFINITIONS || !Array.isArray(CAPABILITY_DEFINITIONS.base) ||
    !Array.isArray(CAPABILITY_DEFINITIONS.sensitive) || !Array.isArray(CAPABILITY_DEFINITIONS.reserved) ||
    !Array.isArray(CAPABILITY_DEFINITIONS.ai)) {
  throw new Error("pairing-protocol-v1.json is missing capability_definitions (base/sensitive/reserved/ai) — refusing to start");
}
if (!DEVICE_TYPE_POLICY || typeof DEVICE_TYPE_POLICY !== "object" || Array.isArray(DEVICE_TYPE_POLICY)) {
  throw new Error("pairing-protocol-v1.json is missing device_type_policy — refusing to start");
}

const WEB_PWA = "WEB_PWA";
const AI_AGENT = "AI_AGENT";

const DEVICE_TYPES = Object.freeze(
  Object.keys(DEVICE_TYPE_POLICY).filter((key) => !key.startsWith("$"))
);

const CAPABILITY_UNIVERSE = new Set([
  ...CAPABILITY_DEFINITIONS.base,
  ...CAPABILITY_DEFINITIONS.sensitive,
  ...CAPABILITY_DEFINITIONS.reserved,
  ...CAPABILITY_DEFINITIONS.ai,
]);
if (CAPABILITY_UNIVERSE.size !==
    CAPABILITY_DEFINITIONS.base.length + CAPABILITY_DEFINITIONS.sensitive.length +
    CAPABILITY_DEFINITIONS.reserved.length + CAPABILITY_DEFINITIONS.ai.length) {
  throw new Error("capability_definitions groups overlap — refusing to start");
}

for (const deviceType of DEVICE_TYPES) {
  const policy = DEVICE_TYPE_POLICY[deviceType];
  if (!policy || !Array.isArray(policy.required_capabilities) ||
      !Array.isArray(policy.optional_capabilities) || !Array.isArray(policy.forbidden_capabilities) ||
      !Array.isArray(policy.history_grant)) {
    throw new Error(`device_type_policy.${deviceType} must declare required/optional/forbidden/history_grant arrays — refusing to start`);
  }
  const classified = [
    ...policy.required_capabilities,
    ...policy.optional_capabilities,
    ...policy.forbidden_capabilities,
  ];
  if (new Set(classified).size !== classified.length) {
    throw new Error(`device_type_policy.${deviceType} classifies a capability twice — refusing to start`);
  }
  if (classified.length !== CAPABILITY_UNIVERSE.size || classified.some((cap) => !CAPABILITY_UNIVERSE.has(cap))) {
    throw new Error(`device_type_policy.${deviceType} must classify every capability in capability_definitions exactly once — refusing to start`);
  }
}

const AI_COMMAND_ALLOWLIST = Object.freeze(["SUGGESTIONS_READY"]);
// Documented explicitly for reviewers/tests; AI_COMMAND_ALLOWLIST is authoritative.
const AI_FORBIDDEN_COMMAND_TYPES = Object.freeze(["SEND_SMS", "SEND_MESSAGES"]);

function deviceTypePolicy(deviceType) {
  if (typeof deviceType !== "string" || !Object.prototype.hasOwnProperty.call(DEVICE_TYPE_POLICY, deviceType)) {
    return null;
  }
  const policy = DEVICE_TYPE_POLICY[deviceType];
  return policy && typeof policy === "object" ? policy : null;
}

function normalizeCapabilities(capabilities) {
  return Array.isArray(capabilities) ? capabilities.map(String) : [];
}

/**
 * Certificate capability predicate. Returns `null` when the set is valid for
 * the device type, otherwise a safe report `{ predicate, capability }` naming
 * only predicate and capability NAMES (never key material).
 */
function capabilityViolation(deviceType, capabilities) {
  const policy = deviceTypePolicy(deviceType);
  if (!policy) return { predicate: "device_type" };
  const caps = normalizeCapabilities(capabilities);

  const unknown = caps.filter((cap) => !CAPABILITY_UNIVERSE.has(cap));
  if (unknown.length > 0) return { predicate: "unknown_capability", capability: unknown };

  const forbidden = caps.filter((cap) => policy.forbidden_capabilities.includes(cap));
  if (forbidden.length > 0) return { predicate: "forbidden_capability", capability: forbidden };

  const missing = policy.required_capabilities.filter((cap) => !caps.includes(cap));
  if (missing.length > 0) return { predicate: "missing_required_capability", capability: missing };

  // Redundant when the startup partition check holds; kept so a future policy
  // edit can never silently widen a device type before the server boots.
  const notAllowed = caps.filter((cap) => !policy.required_capabilities.includes(cap) &&
    !policy.optional_capabilities.includes(cap));
  if (notAllowed.length > 0) return { predicate: "capability_not_allowed", capability: notAllowed };

  return null;
}

function isAiDevice(deviceType) {
  return deviceType === AI_AGENT;
}

/**
 * Command-relay predicate for a linked device. WEB_PWA (and legacy sessions
 * with no deviceType) keep their existing per-route capability checks here;
 * AI_AGENT is restricted to the AI allowlist and must actually hold AI_SUGGEST.
 * Returns `null` when allowed, otherwise a safe violation report.
 */
function deviceCommandViolation({ deviceType, capabilities, type } = {}) {
  if (deviceType === undefined || deviceType === null || deviceType === WEB_PWA) return null;
  if (!isAiDevice(deviceType) || !deviceTypePolicy(deviceType)) {
    return { predicate: "unknown_device_type" };
  }
  const caps = normalizeCapabilities(capabilities);
  if (!caps.includes("AI_SUGGEST")) {
    return { predicate: "missing_capability", capability: "AI_SUGGEST" };
  }
  const commandType = typeof type === "string" ? type : String(type ?? "");
  if (!AI_COMMAND_ALLOWLIST.includes(commandType)) {
    return { predicate: "command_type_not_allowed", commandType };
  }
  return null;
}

function policyError(code, violation) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = 403;
  error.meta = violation;
  return error;
}

/**
 * Device-registry gate: called before a linked session is issued. Unknown
 * device types and AI_AGENT capability sets that are not exactly
 * READ_MESSAGES + AI_SUGGEST are rejected. WEB_PWA is left alone so the
 * existing browser/recovery sessions keep their semantics.
 */
function assertDeviceRegistration({ deviceType = WEB_PWA, capabilities = [] } = {}) {
  if (deviceType === WEB_PWA) return { deviceType: WEB_PWA };
  const violation = capabilityViolation(deviceType, capabilities);
  if (violation) throw policyError("device_registration_rejected", violation);
  return { deviceType };
}

/** Command-creation gate (defense in depth; the HTTP route checks first). */
function assertCommandAllowedForDevice({ deviceType = null, capabilities = null, type } = {}) {
  const violation = deviceCommandViolation({ deviceType, capabilities, type });
  if (violation) throw policyError("command_type_not_allowed_for_device", violation);
}

module.exports = {
  SCHEMA,
  CAPABILITY_DEFINITIONS,
  CAPABILITY_UNIVERSE,
  DEVICE_TYPE_POLICY,
  DEVICE_TYPES,
  WEB_PWA,
  AI_AGENT,
  AI_COMMAND_ALLOWLIST,
  AI_FORBIDDEN_COMMAND_TYPES,
  deviceTypePolicy,
  capabilityViolation,
  deviceCommandViolation,
  isAiDevice,
  assertDeviceRegistration,
  assertCommandAllowedForDevice,
};
