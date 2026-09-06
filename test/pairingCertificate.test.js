"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const pairing = require("../src/pairingSessions");
const {
  certificateFailureReport,
  certificateValidationReason,
  validateCertificate,
  REQUIRED_CAPABILITIES,
  SENSITIVE_CAPABILITIES,
} = require("../src/pairingCertificate");
const { verifyP256 } = require("../src/pairingRoutes");
const { canonicalCertificate } = require("../shared/pairingProtocol.mjs");

function fixture(capabilities = [...REQUIRED_CAPABILITIES, "READ_OTP"]) {
  pairing._reset();
  const created = pairing.createSession({
    webDeviceId: "android-compatible-web",
    webSigningPublicKey: "signing-key",
    webEncryptionPublicKey: "encryption-key",
    ephemeralPublicKey: "ephemeral-key",
    nonce: "nonce",
  }, { ip: "127.0.0.1", origin: "https://web.example", apiOrigin: "https://api.example" });
  const session = pairing.getSession(created.pairingSessionId);
  const certificate = {
    protocol: session.protocol, accountId: "default", deviceId: session.webDeviceId,
    deviceType: "WEB_PWA", signingPublicKey: session.webSigningPublicKey,
    encryptionPublicKey: session.webEncryptionPublicKey,
    capabilities,
    historyGrant: "FULL_HISTORY", trustSequence: 1, issuedAt: Date.now(),
    expiresAt: Date.now() + 86400000, pairingTranscriptHash: session.transcriptHash,
    pairingSessionId: session.pairingSessionId, apiOrigin: session.apiOrigin, webOrigin: session.webOrigin,
  };
  return { session, certificate };
}

test("REAL Android certificate: base + READ_OTP validates, canonicalizes and verifies DER root signature", () => {
  // Capabilities are exactly what LinkedDevicesScreen.kt puts in the
  // certificate today (READ_MESSAGES, SEND_MESSAGES, MARK_READ,
  // RECEIVE_NOTIFICATIONS + one selected sensitive grant).
  const { session, certificate } = fixture(["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS", "READ_OTP"]);
  const root = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bytes = Buffer.from(canonicalCertificate(certificate), "utf8");
  certificate.rootSignature = crypto.sign("sha256", bytes, root.privateKey).toString("base64");
  const publicKey = root.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(validateCertificate(certificate, session), true);
  assert.equal(verifyP256(bytes, certificate.rootSignature, publicKey), true);
  assert.match(crypto.createHash("sha256").update(bytes).digest("hex"), /^[0-9a-f]{64}$/);
  // Tampering AFTER signing must fail root verification (no canonical re-sign).
  certificate.historyGrant = "FROM_NOW_ON";
  assert.equal(verifyP256(Buffer.from(canonicalCertificate(certificate)), certificate.rootSignature, publicKey), false);
});

test("every user-selectable sensitive grant validates on top of the Android base set", () => {
  for (const sensitive of SENSITIVE_CAPABILITIES) {
    const { session, certificate } = fixture([...REQUIRED_CAPABILITIES, sensitive]);
    assert.equal(validateCertificate(certificate, session), true, `${sensitive} must be accepted`);
  }
});

test("base-only certificate (no sensitive grants) is the minimal accepted Android output", () => {
  const { session, certificate } = fixture([...REQUIRED_CAPABILITIES]);
  assert.equal(validateCertificate(certificate, session), true);
});

test("certificate validation reports the first safe failed predicate and names the offending capability", () => {
  const cases = [
    ["certificate_capability_invalid", c => { c.capabilities.push("UNKNOWN_CAP"); }, /UNKNOWN_CAP/],
    ["certificate_capability_invalid", c => { c.capabilities.push("READ_MESSAGES"); }, /duplicate/],
    ["certificate_capability_invalid", c => { c.capabilities = c.capabilities.filter(x => x !== "SEND_MESSAGES"); }, /SEND_MESSAGES/],
    ["certificate_protocol_mismatch", c => { c.protocol = "GMweb-Pairing-v2"; }, null],
    ["transcript_hash_mismatch", c => { c.pairingTranscriptHash = "changed"; }, null],
    ["web_device_binding_mismatch", c => { c.deviceId = "changed"; }, null],
    ["certificate_signing_key_mismatch", c => { c.signingPublicKey = "changed"; }, null],
    ["certificate_encryption_key_mismatch", c => { c.encryptionPublicKey = "changed"; }, null],
    ["certificate_origin_mismatch", c => { c.webOrigin = "https://changed.example"; }, null],
    ["certificate_history_grant_invalid", c => { c.historyGrant = "PARTIAL"; }, null],
    ["certificate_parse_failed", c => { c.issuedAt = "not-a-number"; }, null],
    ["certificate_time_invalid", c => { c.issuedAt = Date.now() - 400 * 86400000; }, null],
  ];
  for (const [reason, mutate, metaPattern] of cases) {
    const { session, certificate } = fixture();
    mutate(certificate);
    assert.equal(certificateValidationReason(certificate, session), reason);
    const report = certificateFailureReport(certificate, session);
    assert.equal(report.reason, reason);
    if (metaPattern) {
      assert.match(JSON.stringify(report.meta), metaPattern, `${reason} meta must name the capability`);
    }
  }
});

test("non-object / missing certificate is rejected safely, never a crash", () => {
  const { session } = fixture();
  for (const bad of [null, undefined, 42, "text"]) {
    assert.equal(certificateValidationReason(bad, session), "certificate_parse_failed");
  }
  // An array is technically an object but carries no protocol → fail closed.
  assert.equal(certificateValidationReason([], session), "certificate_protocol_mismatch");
});

