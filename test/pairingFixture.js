const crypto = require("node:crypto");
const { canonicalCertificate } = require("../shared/pairingProtocol.mjs");
const pairing = require("../src/pairingSessions");
const root = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rootPublicKey = root.publicKey.export({ format: "der", type: "spki" }).toString("base64");
function certificate(id, key = root) {
  const s = pairing.getSession(id);
  const c = { protocol: s.protocol, accountId: "default", deviceId: s.webDeviceId, deviceType: "WEB_PWA",
    signingPublicKey: s.webSigningPublicKey, encryptionPublicKey: s.webEncryptionPublicKey,
    capabilities: ["READ_MESSAGES", "SEND_MESSAGES"], historyGrant: "FULL_HISTORY", trustSequence: 1,
    issuedAt: Date.now(), expiresAt: Date.now() + 86400000,
    pairingTranscriptHash: s.transcriptHash, pairingSessionId: id, apiOrigin: s.apiOrigin, webOrigin: s.webOrigin };
  c.rootSignature = crypto.sign("sha256", Buffer.from(canonicalCertificate(c)), key.privateKey).toString("base64");
  return JSON.stringify(c);
}
module.exports = { root, rootPublicKey, certificate };
