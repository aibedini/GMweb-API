"use strict";
const { PROTOCOL, canonicalCertificate } = require("../shared/pairingProtocol.mjs");
const CAPABILITIES = new Set(["READ_MESSAGES", "SEND_MESSAGES", "MANAGE_DEVICES", "READ_OTP",
  "READ_BANK_SECURITY", "READ_PASSWORD_RESET", "READ_AUTH_CODES", "READ_FINANCIAL_NOTIFICATIONS"]);
function validateCertificate(c, session, now = Date.now()) {
  try {
    canonicalCertificate(c); // Strict string, integer, and capability encoding.
    return c.protocol === PROTOCOL && c.accountId === "default" && c.deviceType === "WEB_PWA" &&
      c.deviceId === session.webDeviceId && c.pairingSessionId === session.pairingSessionId &&
      c.signingPublicKey === session.webSigningPublicKey && c.encryptionPublicKey === session.webEncryptionPublicKey &&
      c.pairingTranscriptHash === session.transcriptHash && c.apiOrigin === session.apiOrigin &&
      c.webOrigin === session.webOrigin && c.trustSequence > 0 && c.issuedAt <= now + 90000 &&
      c.issuedAt >= session.createdAt - 90000 && c.expiresAt > now && c.expiresAt > c.issuedAt &&
      c.expiresAt - c.issuedAt <= 180 * 86400000 && c.capabilities.includes("READ_MESSAGES") &&
      c.capabilities.every(cap => CAPABILITIES.has(cap)) && ["FULL_HISTORY", "FROM_NOW_ON"].includes(c.historyGrant);
  } catch { return false; }
}
module.exports = { validateCertificate };
