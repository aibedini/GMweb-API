"use strict";

/**
 * ADR-007 BLOCKER 2 — server-side mirror of the canonical certificate
 * serialization (byte-for-byte contract with PrimaryTrustRoot.kt and
 * web/src/lib/trustRoot.ts).
 *
 * Used by the shared test vectors (pairingTranscriptVectors.test.js) to pin
 * the Kotlin ↔ TypeScript ↔ Node serialization.
 */

/** Compact JSON with fixed key order + sorted capabilities (mirrors both). */
function canonicalCertificate(c) {
  const caps = [...c.capabilities].sort();
  return JSON.stringify({
    accountId: c.accountId,
    deviceId: c.deviceId,
    deviceType: c.deviceType,
    signingPublicKey: c.signingPublicKey,
    encryptionPublicKey: c.encryptionPublicKey,
    capabilities: caps,
    historyGrant: c.historyGrant,
    trustSequence: c.trustSequence,
    issuedAt: c.issuedAt,
    expiresAt: c.expiresAt,
    pairingTranscriptHash: c.pairingTranscriptHash,
    origin: c.origin,
  });
}

/** Node-side ECDSA verification (mirrors verifyRootSignature in trustRoot.ts). */
async function verifyRootSignature(cert, trustRootPublicKeyB64) {
  const { rootSignature, ...rest } = cert;
  const canonical = canonicalCertificate(rest);
  try {
    const keyDer = Buffer.from(trustRootPublicKeyB64, "base64");
    const pubKey = crypto.createPublicKey({ key: keyDer, format: "der", type: "spki" });
    const sigBytes = Buffer.from(rootSignature, "base64");
    return crypto.verify("sha256", Buffer.from(canonical, "utf8"), pubKey, sigBytes);
  } catch {
    return false;
  }
}

const crypto = require("node:crypto");

module.exports = { canonicalCertificate, verifyRootSignature };
