"use strict";
// Certificate policy for POST /api/v1/pairing/approve.
//
// SINGLE SOURCE OF TRUTH: the allowed capability universe and the mandatory
// base set are read from shared/pairing-protocol-v1.json -> capability_definitions.
// No capability allowlist is hardcoded here or in pairingRoutes.js. The
// cross-repo drift guards are:
//   - test/pairingCapabilityContract.test.js  (schema == shared/pairingProtocol.mjs)
//   - .github/workflows CI (shared/pairing-protocol-v1.json == Messages protocol copy)
//   - Messages app PairingCapabilityContractTest (Android builder == schema)
const { PROTOCOL, canonicalCertificate } = require("../shared/pairingProtocol.mjs");
const CAPABILITY_DEFINITIONS = require("../shared/pairing-protocol-v1.json").capability_definitions;
if (!CAPABILITY_DEFINITIONS || !Array.isArray(CAPABILITY_DEFINITIONS.base) ||
    !Array.isArray(CAPABILITY_DEFINITIONS.sensitive) || !Array.isArray(CAPABILITY_DEFINITIONS.reserved)) {
  throw new Error("pairing-protocol-v1.json is missing capability_definitions (base/sensitive/reserved) — refusing to start");
}
const REQUIRED_CAPABILITIES = Object.freeze([...CAPABILITY_DEFINITIONS.base]);
const SENSITIVE_CAPABILITIES = Object.freeze([...CAPABILITY_DEFINITIONS.sensitive]);
const OPTIONAL_CAPABILITIES = Object.freeze([...CAPABILITY_DEFINITIONS.reserved]);
const CAPABILITIES = new Set([...REQUIRED_CAPABILITIES, ...SENSITIVE_CAPABILITIES, ...OPTIONAL_CAPABILITIES]);

/**
 * Fail-closed certificate validation. Returns `null` when every predicate
 * passes, otherwise a safe report: `{ reason, meta }`.
 *  - reason is one of the stable, client-safe reason codes.
 *  - meta may carry predicate + capability NAMES ONLY (no keys/secrets).
 * Never wraps predicates in a blind try/catch — the exact failed predicate is
 * the whole point of this function.
 */
function certificateFailureReport(c, session, now = Date.now()) {
  if (!c || typeof c !== "object") return { reason: "certificate_parse_failed", meta: { predicate: "certificate_object" } };
  if (c.protocol !== PROTOCOL) return { reason: "certificate_protocol_mismatch", meta: { predicate: "protocol" } };
  try {
    canonicalCertificate(c); // Strict string/integer + duplicate-capability encoding.
  } catch (error) {
    const message = String(error?.message || "");
    if (/duplicate capability/i.test(message)) {
      return { reason: "certificate_capability_invalid", meta: { predicate: "duplicate_capability" } };
    }
    return { reason: "certificate_parse_failed", meta: { predicate: "canonical_certificate", capabilityError: message } };
  }
  const capabilities = Array.isArray(c.capabilities) ? c.capabilities : [];
  const unknown = capabilities.filter(cap => !CAPABILITIES.has(String(cap)));
  if (unknown.length > 0) {
    return { reason: "certificate_capability_invalid", meta: { predicate: "unknown_capability", capability: unknown } };
  }
  const missing = REQUIRED_CAPABILITIES.filter(cap => !capabilities.includes(cap));
  if (missing.length > 0) {
    return { reason: "certificate_capability_invalid", meta: { predicate: "missing_base_capability", capability: missing } };
  }
  if (c.deviceId !== session.webDeviceId || c.pairingSessionId !== session.pairingSessionId) {
    return { reason: "web_device_binding_mismatch", meta: { predicate: "device_and_session_binding" } };
  }
  if (c.pairingTranscriptHash !== session.transcriptHash) {
    return { reason: "transcript_hash_mismatch", meta: { predicate: "pairing_transcript_hash" } };
  }
  if (c.signingPublicKey !== session.webSigningPublicKey) {
    return { reason: "certificate_signing_key_mismatch", meta: { predicate: "signing_public_key" } };
  }
  if (c.encryptionPublicKey !== session.webEncryptionPublicKey) {
    return { reason: "certificate_encryption_key_mismatch", meta: { predicate: "encryption_public_key" } };
  }
  if (c.apiOrigin !== session.apiOrigin || c.webOrigin !== session.webOrigin) {
    return { reason: "certificate_origin_mismatch", meta: { predicate: "origin_binding", fields: c.apiOrigin !== session.apiOrigin ? ["apiOrigin"] : ["webOrigin"] } };
  }
  if (!["FULL_HISTORY", "FROM_NOW_ON"].includes(c.historyGrant)) {
    return { reason: "certificate_history_grant_invalid", meta: { predicate: "history_grant" } };
  }
  if (c.accountId !== "default" || c.deviceType !== "WEB_PWA" || c.trustSequence <= 0 ||
      c.issuedAt > now + 90000 || c.issuedAt < session.createdAt - 90000 || c.expiresAt <= now ||
      c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > 180 * 86400000) {
    return { reason: "certificate_time_invalid", meta: { predicate: "time_and_scope_window" } };
  }
  return null;
}

function certificateValidationReason(c, session, now = Date.now()) {
  const report = certificateFailureReport(c, session, now);
  return report ? report.reason : null;
}

function validateCertificate(c, session, now = Date.now()) {
  return certificateFailureReport(c, session, now) === null;
}

module.exports = {
  CAPABILITIES,
  CAPABILITY_DEFINITIONS,
  REQUIRED_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  certificateFailureReport,
  certificateValidationReason,
  validateCertificate,
};

