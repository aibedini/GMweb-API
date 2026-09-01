/**
 * ADR-007 BLOCKER 2 — web-side mirror of the Android canonical certificate
 * serialization + Trust Root signature verification.
 *
 * BYTE-FOR-BYTE CONTRACT with PrimaryTrustRoot.kt (canonicalCertificate):
 *   org.json's JSONObject.toString() is compact with insertion-ordered keys,
 *   so both sides build the object with the SAME key order and separators.
 *   capabilities are sorted then re-inserted as an array.
 *
 * Shared test vectors live in test/pairingTranscriptVectors.test.js (server)
 * and are referenced by the Android tests.
 */

export interface DeviceCertificate {
  accountId: string;
  deviceId: string;
  deviceType: string; // "WEB_PWA"
  signingPublicKey: string;
  encryptionPublicKey: string;
  capabilities: string[];
  historyGrant: string;
  trustSequence: number;
  issuedAt: number;
  expiresAt: number;
  pairingTranscriptHash: string;
  origin: string;
  rootSignature: string;
}

/** Mirror of PrimaryTrustRoot.canonicalCertificate — byte-for-byte. */
export function canonicalCertificate(
  c: Omit<DeviceCertificate, "rootSignature">,
): string {
  const caps = [...c.capabilities].sort();
  const o = {
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
  };
  return JSON.stringify(o);
}

/**
 * Verify the Trust Root signature over the canonical certificate bytes.
 * Returns true ONLY when [trustRootPublicKeyB64] is the pinned Android
 * Trust Root public key AND the signature is valid.
 */
export async function verifyRootSignature(
  cert: DeviceCertificate,
  trustRootPublicKeyB64: string,
): Promise<boolean> {
  const { rootSignature, ...rest } = cert;
  const canonical = canonicalCertificate(rest);
  try {
    const keyDer = Uint8Array.from(atob(trustRootPublicKeyB64), (c) => c.charCodeAt(0));
    const pubKey = await crypto.subtle.importKey(
      "spki",
      keyDer,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    const sigBytes = Uint8Array.from(atob(rootSignature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pubKey,
      sigBytes,
      new TextEncoder().encode(canonical),
    );
  } catch {
    return false;
  }
}
