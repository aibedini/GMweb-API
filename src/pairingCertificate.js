"use strict";
const { PROTOCOL, PAIRING_CAPABILITIES, canonicalCertificate } = require("../shared/pairingProtocol.mjs");
const CAPABILITIES = new Set(PAIRING_CAPABILITIES);
function certificateValidationReason(c, session, now = Date.now()) {
  if (!c || typeof c !== "object") return "certificate_parse_failed";
  if (c.protocol !== PROTOCOL) return "certificate_protocol_mismatch";
  try { canonicalCertificate(c); } catch (error) {
    return /capability/i.test(String(error?.message)) ? "certificate_capability_invalid" : "certificate_parse_failed";
  }
  if (!c.capabilities.includes("READ_MESSAGES") || !c.capabilities.every(cap => CAPABILITIES.has(cap)))
    return "certificate_capability_invalid";
  if (c.deviceId !== session.webDeviceId || c.pairingSessionId !== session.pairingSessionId)
    return "web_device_binding_mismatch";
  if (c.pairingTranscriptHash !== session.transcriptHash) return "transcript_hash_mismatch";
  if (c.signingPublicKey !== session.webSigningPublicKey) return "certificate_signing_key_mismatch";
  if (c.encryptionPublicKey !== session.webEncryptionPublicKey) return "certificate_encryption_key_mismatch";
  if (c.apiOrigin !== session.apiOrigin || c.webOrigin !== session.webOrigin) return "certificate_origin_mismatch";
  if (!["FULL_HISTORY", "FROM_NOW_ON"].includes(c.historyGrant)) return "certificate_history_grant_invalid";
  if (c.accountId !== "default" || c.deviceType !== "WEB_PWA" || c.trustSequence <= 0 ||
      c.issuedAt > now + 90000 || c.issuedAt < session.createdAt - 90000 || c.expiresAt <= now ||
      c.expiresAt <= c.issuedAt || c.expiresAt - c.issuedAt > 180 * 86400000) return "certificate_time_invalid";
  return null;
}
function validateCertificate(c, session, now = Date.now()) {
  return certificateValidationReason(c, session, now) === null;
}
module.exports = { CAPABILITIES, certificateValidationReason, validateCertificate };
