"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const pairing = require("../src/pairingSessions");
const { certificateValidationReason, validateCertificate } = require("../src/pairingCertificate");
const { verifyP256 } = require("../src/pairingRoutes");
const { canonicalCertificate } = require("../shared/pairingProtocol.mjs");

function fixture() {
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
    capabilities: ["READ_MESSAGES", "SEND_MESSAGES", "MARK_READ", "RECEIVE_NOTIFICATIONS", "READ_OTP"],
    historyGrant: "FULL_HISTORY", trustSequence: 1, issuedAt: Date.now(),
    expiresAt: Date.now() + 86400000, pairingTranscriptHash: session.transcriptHash,
    pairingSessionId: session.pairingSessionId, apiOrigin: session.apiOrigin, webOrigin: session.webOrigin,
  };
  return { session, certificate };
}

test("Android linked-browser capabilities validate and the DER root signature verifies", () => {
  const { session, certificate } = fixture();
  const root = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const bytes = Buffer.from(canonicalCertificate(certificate), "utf8");
  certificate.rootSignature = crypto.sign("sha256", bytes, root.privateKey).toString("base64");
  const publicKey = root.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  assert.equal(validateCertificate(certificate, session), true);
  assert.equal(verifyP256(bytes, certificate.rootSignature, publicKey), true);
  assert.match(crypto.createHash("sha256").update(bytes).digest("hex"), /^[0-9a-f]{64}$/);
  certificate.historyGrant = "FROM_NOW_ON";
  assert.equal(verifyP256(Buffer.from(canonicalCertificate(certificate)), certificate.rootSignature, publicKey), false);
});

test("certificate validation reports the first safe failed predicate", () => {
  const cases = [
    ["certificate_capability_invalid", c => { c.capabilities.push("UNKNOWN"); }],
    ["certificate_capability_invalid", c => { c.capabilities.push("READ_MESSAGES"); }],
    ["transcript_hash_mismatch", c => { c.pairingTranscriptHash = "changed"; }],
    ["web_device_binding_mismatch", c => { c.deviceId = "changed"; }],
    ["certificate_signing_key_mismatch", c => { c.signingPublicKey = "changed"; }],
    ["certificate_encryption_key_mismatch", c => { c.encryptionPublicKey = "changed"; }],
    ["certificate_origin_mismatch", c => { c.webOrigin = "https://changed.example"; }],
  ];
  for (const [reason, mutate] of cases) {
    const { session, certificate } = fixture();
    mutate(certificate);
    assert.equal(certificateValidationReason(certificate, session), reason);
  }
});
