// Pairing Protocol v1. UTF-8 netstrings, fixed field order, no JSON serializer.
// Each value is <decimal UTF-8 byte length>:<value>,. No normalization.
export const PROTOCOL = "GMweb-Pairing-v1";
function text(value) {
  if (typeof value !== "string" || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Error("invalid protocol string");
  }
  return value;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid protocol integer");
  return String(value);
}
function encode(kind, fields) {
  return `${PROTOCOL}:${kind}\n` + fields.map(v => {
    const s = text(v);
    return `${new TextEncoder().encode(s).length}:${s},`;
  }).join("");
}
export function canonicalTranscript(t) {
  if (t.protocol !== PROTOCOL) throw new Error("unsupported_pairing_protocol");
  return encode("transcript", [t.pairingSessionId, t.webDeviceId, t.webSigningPublicKey,
    t.webEncryptionPublicKey, t.ephemeralPublicKey, t.nonce, t.apiOrigin, t.webOrigin, integer(t.expiresAt)]);
}
export function canonicalCertificate(c) {
  if (c.protocol !== PROTOCOL || !Array.isArray(c.capabilities)) throw new Error("unsupported_pairing_protocol");
  const caps = c.capabilities.map(text).sort();
  if (new Set(caps).size !== caps.length) throw new Error("duplicate capability");
  return encode("certificate", [c.accountId, c.deviceId, c.deviceType, c.signingPublicKey,
    c.encryptionPublicKey, integer(caps.length), ...caps, c.historyGrant, integer(c.trustSequence),
    integer(c.issuedAt), integer(c.expiresAt), c.pairingTranscriptHash, c.pairingSessionId,
    c.apiOrigin, c.webOrigin]);
}
export function canonicalEnrollment(c) {
  return encode("enrollment", [c.claim, c.deviceId, c.publicKeys.signing,
    c.publicKeys.encryption, c.publicKeys.trustRoot, c.apiOrigin]);
}
export function canonicalChallenge(c) {
  return encode("challenge", [c.pairingSessionId, c.deviceId, c.challenge,
    c.apiOrigin, c.webOrigin, integer(c.issuedAt)]);
}
