/**
 * ADR-007 P0-7 — web-side certificate verification (fail closed).
 *
 * PAIRING_APPROVED is NOT trusted until this module verifies:
 *   - the certificate binding (deviceId, transcript hash, origin, key
 *     binding to OUR local keys)
 *   - the root signature over the canonical certificate bytes, with the
 *     Trust Root public key.
 *
 * Until the Trust Root public key distribution lands (it arrives WITH the
 * pairing protocol's first Android release), this module runs in
 * VERIFICATION-PENDING mode: the UI must show CERTIFICATE_RECEIVED, not
 * READY. Nothing message-related unlocks from a merely RECEIVED certificate.
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

export type CertState =
  | { step: "CERTIFICATE_RECEIVED" }
  | { step: "CERTIFICATE_VERIFIED"; cert: DeviceCertificate }
  | { step: "REJECTED"; reason: string };

/**
 * Structural binding checks that are possible without the Trust Root key:
 * every field must match what THIS pairing exchange produced. Any mismatch
 * = substitution attack = fail closed.
 */
export function verifyCertificateBinding(
  cert: DeviceCertificate,
  expected: {
    deviceId: string;
    transcriptHash: string;
    origin: string;
    signingPublicKeyB64: string;
    encryptionPublicKeyB64: string;
  },
): CertState {
  const checks: Array<[boolean, string]> = [
    [cert.deviceId === expected.deviceId, "deviceId mismatch"],
    [cert.deviceType === "WEB_PWA", "deviceType must be WEB_PWA"],
    [
      cert.pairingTranscriptHash === expected.transcriptHash,
      "pairingTranscriptHash mismatch (substitution?)",
    ],
    [cert.origin === expected.origin, "certificate origin mismatch"],
    [
      cert.signingPublicKey === expected.signingPublicKeyB64,
      "signingPublicKey is not OUR key (key substitution?)",
    ],
    [
      cert.encryptionPublicKey === expected.encryptionPublicKeyB64,
      "encryptionPublicKey is not OUR key",
    ],
    [Array.isArray(cert.capabilities) && cert.capabilities.length > 0, "capabilities missing"],
    [typeof cert.trustSequence === "number" && cert.trustSequence > 0, "trustSequence invalid"],
    [cert.expiresAt > Date.now(), "certificate expired"],
  ];
  for (const [ok, reason] of checks) {
    if (!ok) return { step: "REJECTED", reason };
  }
  return { step: "CERTIFICATE_VERIFIED", cert };
}

/**
 * Full cryptographic verification (rootSignature over canonical bytes).
 * ACTIVE once the Trust Root public key is distributed to the web client;
 * until then the caller MUST treat the certificate as
 * CERTIFICATE_RECEIVED (not verified) — fail closed.
 */
export async function verifyRootSignature(
  cert: DeviceCertificate,
  trustRootPublicKey: CryptoKey,
): Promise<boolean> {
  // Canonical bytes: JSON with fixed key order (mirrors the Android side).
  const canonical = JSON.stringify({
    accountId: cert.accountId,
    deviceId: cert.deviceId,
    deviceType: cert.deviceType,
    signingPublicKey: cert.signingPublicKey,
    encryptionPublicKey: cert.encryptionPublicKey,
    capabilities: cert.capabilities,
    historyGrant: cert.historyGrant,
    trustSequence: cert.trustSequence,
    issuedAt: cert.issuedAt,
    expiresAt: cert.expiresAt,
    pairingTranscriptHash: cert.pairingTranscriptHash,
    origin: cert.origin,
  });
  try {
    const sigBytes = Uint8Array.from(atob(cert.rootSignature), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      trustRootPublicKey,
      sigBytes,
      new TextEncoder().encode(canonical),
    );
  } catch {
    return false;
  }
}
