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

/** Convert Android/Java's ASN.1 DER ECDSA signature to WebCrypto's r||s form. */
export function derEcdsaToP1363(signature: Uint8Array, coordinateSize = 32): Uint8Array {
  let offset = 0;
  const readLength = (): number => {
    const first = signature[offset++];
    if (first === undefined) throw new Error("truncated DER length");
    if ((first & 0x80) === 0) return first;
    const count = first & 0x7f;
    if (count === 0 || count > 2 || offset + count > signature.length) {
      throw new Error("invalid DER length");
    }
    let length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | signature[offset++];
    return length;
  };
  const readInteger = (): Uint8Array => {
    if (signature[offset++] !== 0x02) throw new Error("invalid DER integer");
    const length = readLength();
    if (length === 0 || offset + length > signature.length) throw new Error("truncated DER integer");
    let value = signature.slice(offset, offset + length);
    offset += length;
    while (value.length > 1 && value[0] === 0) value = value.slice(1);
    if (value.length > coordinateSize) throw new Error("ECDSA integer is too large");
    return value;
  };

  if (signature[offset++] !== 0x30) throw new Error("invalid DER sequence");
  const sequenceLength = readLength();
  if (offset + sequenceLength !== signature.length) throw new Error("invalid DER sequence length");
  const r = readInteger();
  const s = readInteger();
  if (offset !== signature.length) throw new Error("trailing DER data");
  const raw = new Uint8Array(coordinateSize * 2);
  raw.set(r, coordinateSize - r.length);
  raw.set(s, coordinateSize * 2 - s.length);
  return raw;
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
  // org.json (Android) escapes forward slashes by default — the signature
  // covers the ESCAPED bytes. Mirror that byte-for-byte.
  return JSON.stringify(o).replace(/\//g, "\\/");
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
    const derSignature = Uint8Array.from(atob(rootSignature), (c) => c.charCodeAt(0));
    const sigBytes = derEcdsaToP1363(derSignature);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pubKey,
      new Uint8Array(sigBytes).buffer,
      new TextEncoder().encode(canonical),
    );
  } catch {
    return false;
  }
}
