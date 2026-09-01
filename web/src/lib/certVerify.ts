/**
 * ADR-007 BLOCKER 1/7 — pairing runtime certificate verification.
 *
 * The runtime flow is now:
 *   PAIRING_PENDING -> CERTIFICATE_RECEIVED -> parse -> verify transcript
 *   binding -> verify rootSignature (Trust Root key pinned from the approval)
 *   -> CERTIFICATE_VERIFIED -> persist -> BOOTSTRAPPING_KEYS -> READY.
 *
 * Every failure is FAIL CLOSED: onLinked() fires only after
 * CERTIFICATE_VERIFIED, and no sync/SSE/push access is started otherwise.
 */

import { verifyRootSignature, type DeviceCertificate } from "./trustRoot";

export type CertState =
  | { step: "CERTIFICATE_RECEIVED" }
  | { step: "CERTIFICATE_VERIFIED"; cert: DeviceCertificate }
  | { step: "REJECTED"; reason: string };

export interface VerifyContext {
  deviceId: string;
  transcriptHash: string;
  origin: string;
  signingPublicKeyB64: string;
  encryptionPublicKeyB64: string;
  trustRootPublicKeyB64: string; // pinned from the pairing approval payload
}

/**
 * Verify a received certificate end-to-end (structural + cryptographic).
 * Order matters: cheap structural checks first, then root signature.
 */
export async function verifyCertificate(
  cert: DeviceCertificate,
  ctx: VerifyContext,
): Promise<CertState> {
  const checks: Array<[boolean, string]> = [
    [cert.deviceId === ctx.deviceId, "deviceId mismatch"],
    [cert.deviceType === "WEB_PWA", "deviceType must be WEB_PWA"],
    [
      cert.pairingTranscriptHash === ctx.transcriptHash,
      "pairingTranscriptHash mismatch (substitution?)",
    ],
    [cert.origin === ctx.origin, "certificate origin mismatch"],
    [
      cert.signingPublicKey === ctx.signingPublicKeyB64,
      "signingPublicKey is not OUR key (key substitution?)",
    ],
    [
      cert.encryptionPublicKey === ctx.encryptionPublicKeyB64,
      "encryptionPublicKey is not OUR key",
    ],
    [Array.isArray(cert.capabilities) && cert.capabilities.length > 0, "capabilities missing"],
    [typeof cert.trustSequence === "number" && cert.trustSequence > 0, "trustSequence invalid"],
    [cert.expiresAt > Date.now(), "certificate expired"],
  ];
  for (const [ok, reason] of checks) {
    if (!ok) return { step: "REJECTED", reason };
  }
  // Cryptographic: Trust Root signature over canonical bytes.
  const sigOk = await verifyRootSignature(cert, ctx.trustRootPublicKeyB64);
  if (!sigOk) return { step: "REJECTED", reason: "rootSignature verification failed" };
  return { step: "CERTIFICATE_VERIFIED", cert };
}

/** Canonical certificate bytes (mirror of PrimaryTrustRoot.kt). */
export { canonicalCertificate } from "./trustRoot";
