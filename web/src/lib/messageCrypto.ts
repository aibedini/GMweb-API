import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { getOrCreateDeviceKeys, loadCryptoRecord, saveCryptoRecord } from "./deviceKeys.ts";
import { derEcdsaToP1363 } from "./trustRoot.ts";
import type { SyncEvent } from "./api.ts";

const suite = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const encoder = new TextEncoder();
export function unb64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
function b64(value: Uint8Array): string { return btoa(Array.from(value, b => String.fromCharCode(b)).join("")); }
export function binding(domain: string, ...fields: string[]): Uint8Array<ArrayBuffer> {
  return encoder.encode([domain, ...fields.map(v => b64(encoder.encode(v)))].join("\n"));
}
function envelope(event: SyncEvent): Record<string, unknown> {
  if (event.cryptoVersion !== 1 || event.encoding !== "envelope.v1" || event.schemaVersion !== 1) throw new Error("Unsupported envelope");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(event.ciphertext)));
  if (!value || value.v !== 1 || value.conversationId !== event.aggregateId) throw new Error("Envelope binding mismatch");
  return value;
}
function string(o: Record<string, unknown>, key: string): string {
  if (typeof o[key] !== "string") throw new Error(`Missing ${key}`);
  return o[key] as string;
}
export type Decryption = { state: "decrypted"; payload: Record<string, unknown> } |
  { state: "locked" | "invalid" | "key-grant"; reason: string };
type PinnedPrimary = { deviceId: string; root: string; encryptionPublicKey: string };

/** Authentication precedes HPKE decapsulation; the server cannot invent a CKE grant. */
export async function receiveKeyGrant(event: SyncEvent): Promise<Decryption> {
  try {
    const o = envelope(event);
    if (event.type !== "KEY_GRANT" || o.kind !== "key-grant") throw new Error("Not a key grant");
    const keys = await getOrCreateDeviceKeys();
    if (o.deviceId !== keys.deviceId) return { state: "key-grant", reason: "Grant for another device" };
    const pinned = await loadCryptoRecord<PinnedPrimary>("verified-primary");
    if (!pinned || pinned.deviceId !== keys.deviceId || pinned.encryptionPublicKey !== keys.encryptionPublicKeyB64)
      return { state: "locked", reason: "Pair again to verify the primary trust root" };
    if (!keys.encryptionPrivateKey.usages.includes("deriveBits"))
      return { state: "locked", reason: "Legacy browser key: reset keys and pair again to enable E2EE" };
    if (!Number.isSafeInteger(o.historyFloor) || Number(o.historyFloor) < 0) throw new Error("Invalid history boundary");
    const fields = [string(o, "epochId"), string(o, "conversationId"), string(o, "deviceId"), string(o, "category"), String(o.historyFloor)];
    const wrapped = string(o, "wrappedCke");
    const root = await crypto.subtle.importKey("spki", unb64(pinned.root), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const signature = new Uint8Array(derEcdsaToP1363(unb64(string(o, "rootSignature"))));
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, root, signature,
      binding("GMweb-CKE-signature-v1", ...fields, wrapped))) throw new Error("Invalid key grant signature");
    const bytes = unb64(wrapped);
    if (bytes.length !== 113) throw new Error("Invalid HPKE grant length");
    const recipient = await suite.createRecipientContext({
      recipientKey: { privateKey: keys.encryptionPrivateKey, publicKey: keys.encryptionPublicKey },
      enc: bytes.slice(0, 65), info: binding("GMweb-CKE-v1", ...fields),
    });
    const raw = new Uint8Array(await recipient.open(bytes.slice(65)));
    try {
      if (raw.length !== 32) throw new Error("Invalid CKE length");
      const cke = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
      await saveCryptoRecord(`cke:${keys.deviceId}:${pinned.root}:${fields[0]}`, { key: cke, conversationId: fields[1] });
    } finally { raw.fill(0); }
    return { state: "key-grant", reason: "Authorized epoch key stored" };
  } catch (e) { return { state: "invalid", reason: e instanceof Error ? e.message : "Invalid key grant" }; }
}

export async function decryptMessage(event: SyncEvent): Promise<Decryption> {
  if (event.cryptoVersion !== 1) return { state: "locked", reason: "Unsupported crypto version" };
  try {
    const o = envelope(event);
    if (o.kind !== "message" || o.eventId !== event.eventId || o.type !== event.type) throw new Error("Message binding mismatch");
    const epoch = string(o, "epochId");
    const keys = await getOrCreateDeviceKeys();
    const pinned = await loadCryptoRecord<PinnedPrimary>("verified-primary");
    if (!pinned) return { state: "locked", reason: "Primary trust root unavailable; pair again" };
    const entry = await loadCryptoRecord<{ key: CryptoKey; conversationId: string }>(`cke:${keys.deviceId}:${pinned.root}:${epoch}`);
    if (!entry) return { state: "locked", reason: "Authorized key grant unavailable" };
    if (entry.conversationId !== event.aggregateId) throw new Error("CKE conversation mismatch");
    const fields = [epoch, event.eventId, event.type, event.aggregateId!];
    const wrapIv = unb64(string(o, "wrapIv"));
    const iv = unb64(string(o, "iv"));
    if (iv.length !== 12 || wrapIv.length !== 12) throw new Error("Invalid AEAD nonce length");
    const dek = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapIv,
      additionalData: binding("GMweb-DEK-v1", ...fields), tagLength: 128 }, entry.key, unb64(string(o, "wrappedDek"))));
    try {
      if (dek.length !== 32) throw new Error("Invalid DEK length");
      const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
        additionalData: binding("GMweb-message-v1", ...fields), tagLength: 128 }, key, unb64(string(o, "ciphertext")));
      const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid canonical payload");
      return { state: "decrypted", payload };
    } finally { dek.fill(0); }
  } catch (e) { return { state: "invalid", reason: e instanceof Error ? e.message : "AEAD authentication failed" }; }
}
