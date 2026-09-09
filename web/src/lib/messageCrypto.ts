import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { getOrCreateDeviceKeys, loadCryptoRecord, saveCryptoRecords } from "./deviceKeys.ts";
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
  const supported = event.schemaVersion === 1 && (
    (event.cryptoVersion === 1 && event.encoding === "envelope.v1") ||
    (event.cryptoVersion === 2 && event.encoding === "envelope.v2") ||
    (event.cryptoVersion === 3 && event.encoding === "envelope.v3")
  );
  if (!supported) throw new Error("Unsupported envelope");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(unb64(event.ciphertext)));
  if (!value || value.v !== event.cryptoVersion) throw new Error("Envelope binding mismatch");
  if (value.kind === "message" && value.conversationId !== event.aggregateId) throw new Error("Envelope binding mismatch");
  return value;
}
function string(o: Record<string, unknown>, key: string): string {
  if (typeof o[key] !== "string") throw new Error(`Missing ${key}`);
  return o[key] as string;
}
export type Decryption = { state: "decrypted"; payload: Record<string, unknown> } |
  { state: "locked" | "invalid" | "key-grant"; reason: string };
type PinnedPrimary = {
  deviceId: string;
  root: string;
  encryptionPublicKey: string;
  certificate?: { webOrigin?: string; trustSequence?: number; pairingTranscriptHash?: string };
};

async function receiveKeyGrantPage(events: SyncEvent[]): Promise<Decryption[]> {
  if (events.length === 0) return [];
  const keys = await getOrCreateDeviceKeys();
  const pinned = await loadCryptoRecord<PinnedPrimary>("verified-primary");
  let root: CryptoKey | null = null;
  if (pinned) {
    try {
      root = await crypto.subtle.importKey("spki", unb64(pinned.root),
        { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch { /* reported as an unavailable verified root below */ }
  }
  const records: Array<{ key: string; value: unknown }> = [];
  const results: Decryption[] = [];
  for (const event of events) {
    try {
      const o = envelope(event);
      const keyringEntry = event.type === "KEYRING_ENTRY" && o.kind === "keyring-entry" && event.cryptoVersion === 2;
      const historyGrant = event.type === "HISTORY_KEY_GRANT" && o.kind === "history-key-grant" && event.cryptoVersion === 3;
      const legacyGrant = (event.type === "KEY_GRANT" || event.type === "CONTACTS_KEY_GRANT") &&
        o.kind === "key-grant" && event.cryptoVersion === 1;
      if (!keyringEntry && !historyGrant && !legacyGrant) throw new Error("Not a key grant");
      if (o.deviceId !== keys.deviceId) { results.push({ state: "key-grant", reason: "Grant for another device" }); continue; }
      if (!pinned || pinned.deviceId !== keys.deviceId || pinned.encryptionPublicKey !== keys.encryptionPublicKeyB64 || !root) {
        results.push({ state: "locked", reason: "Pair again to verify the primary trust root" }); continue;
      }
      if (!keys.encryptionPrivateKey.usages.includes("deriveBits")) {
        results.push({ state: "locked", reason: "Legacy browser key: reset keys and pair again to enable E2EE" }); continue;
      }
      if (historyGrant) {
        if (!Number.isSafeInteger(o.trustSequence) || Number(o.trustSequence) < 1) throw new Error("Invalid trust sequence");
        const fields = [string(o, "keyId"), string(o, "deviceId"), string(o, "origin"),
          String(o.trustSequence), string(o, "pairingTranscriptHash"), string(o, "encryptionPublicKey")];
        if (fields[2] !== pinned.certificate?.webOrigin ||
            Number(o.trustSequence) !== pinned.certificate?.trustSequence ||
            fields[4] !== pinned.certificate?.pairingTranscriptHash ||
            fields[5] !== keys.encryptionPublicKeyB64) throw new Error("History grant pairing binding mismatch");
        const wrapped = string(o, "wrappedKey");
        const signature = new Uint8Array(derEcdsaToP1363(unb64(string(o, "rootSignature"))));
        if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, root,
          signature, binding("GMweb-history-key-signature-v3", ...fields, wrapped))) {
          throw new Error("Invalid history key signature");
        }
        const bytes = unb64(wrapped);
        if (bytes.length !== 113) throw new Error("Invalid HPKE history key length");
        const recipient = await suite.createRecipientContext({
          recipientKey: { privateKey: keys.encryptionPrivateKey, publicKey: keys.encryptionPublicKey },
          enc: bytes.slice(0, 65), info: binding("GMweb-history-key-v3", ...fields),
        });
        const raw = new Uint8Array(await recipient.open(bytes.slice(65)));
        try {
          if (raw.length !== 32) throw new Error("Invalid history key length");
          const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
          records.push({ key: `history-key:${keys.deviceId}:${pinned.root}:${fields[0]}`, value: { key } });
        } finally { raw.fill(0); }
        results.push({ state: "key-grant", reason: "Authorized history key stored" });
        continue;
      }
      if (keyringEntry) {
        if (!Number.isSafeInteger(o.generation) || Number(o.generation) < 0) throw new Error("Invalid key generation");
        const fields = [string(o, "keyId"), string(o, "domain"), string(o, "deviceId"), String(o.generation)];
        const wrapped = string(o, "wrappedKey");
        const signature = new Uint8Array(derEcdsaToP1363(unb64(string(o, "rootSignature"))));
        if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, root,
          signature, binding("GMweb-account-key-signature-v2", ...fields, wrapped))) {
          throw new Error("Invalid keyring signature");
        }
        const bytes = unb64(wrapped);
        if (bytes.length !== 113) throw new Error("Invalid HPKE keyring length");
        const recipient = await suite.createRecipientContext({
          recipientKey: { privateKey: keys.encryptionPrivateKey, publicKey: keys.encryptionPublicKey },
          enc: bytes.slice(0, 65), info: binding("GMweb-account-key-v2", ...fields),
        });
        const raw = new Uint8Array(await recipient.open(bytes.slice(65)));
        try {
          if (raw.length !== 32) throw new Error("Invalid account key length");
          const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
          records.push({ key: `account-key:${keys.deviceId}:${pinned.root}:${fields[0]}`,
            value: { key, domain: fields[1], generation: Number(o.generation) } });
        } finally { raw.fill(0); }
        results.push({ state: "key-grant", reason: "Authorized account key stored" });
        continue;
      }

      if (!Number.isSafeInteger(o.historyFloor) || Number(o.historyFloor) < 0) throw new Error("Invalid history boundary");
      const fields = [string(o, "epochId"), string(o, "conversationId"), string(o, "deviceId"), string(o, "category"), String(o.historyFloor)];
      const wrapped = string(o, "wrappedCke");
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
        records.push({ key: `cke:${keys.deviceId}:${pinned.root}:${fields[0]}`,
          value: { key: cke, conversationId: fields[1] } });
      } finally { raw.fill(0); }
      results.push({ state: "key-grant", reason: "Authorized epoch key stored" });
    } catch (e) { results.push({ state: "invalid", reason: e instanceof Error ? e.message : "Invalid key grant" }); }
  }
  await saveCryptoRecords(records);
  return results;
}

/** Verify and persist one server page with one key load and one IndexedDB commit. */
export async function receiveKeyGrants(events: SyncEvent[]): Promise<Decryption[]> {
  return receiveKeyGrantPage(events);
}

/** Authentication precedes HPKE decapsulation; the server cannot invent a CKE grant. */
export async function receiveKeyGrant(event: SyncEvent): Promise<Decryption> {
  return (await receiveKeyGrantPage([event]))[0];
}

export async function decryptMessage(event: SyncEvent): Promise<Decryption> {
  if (event.cryptoVersion !== 1 && event.cryptoVersion !== 2 && event.cryptoVersion !== 3) return { state: "locked", reason: "Unsupported crypto version" };
  try {
    const o = envelope(event);
    if (o.kind !== "message" || o.eventId !== event.eventId || o.type !== event.type) throw new Error("Message binding mismatch");
    const keys = await getOrCreateDeviceKeys();
    const pinned = await loadCryptoRecord<PinnedPrimary>("verified-primary");
    if (!pinned) return { state: "locked", reason: "Primary trust root unavailable; pair again" };
    if (event.cryptoVersion === 3) {
      const historyKeyId = string(o, "historyKeyId");
      const liveKeyId = string(o, "liveKeyId");
      const domain = string(o, "domain");
      if (domain !== "READ_MESSAGES") throw new Error("History domain mismatch");
      const fields = [historyKeyId, liveKeyId, domain, event.eventId, event.type, event.aggregateId!];
      const history = await loadCryptoRecord<{ key: CryptoKey }>(
        `history-key:${keys.deviceId}:${pinned.root}:${historyKeyId}`
      );
      const live = history ? null : await loadCryptoRecord<{ key: CryptoKey; domain: string }>(
        `account-key:${keys.deviceId}:${pinned.root}:${liveKeyId}`
      );
      if (!history && !live) return { state: "locked", reason: "Authorized history key unavailable" };
      if (live && live.domain !== domain) throw new Error("Account key domain mismatch");
      const wrapIv = unb64(string(o, history ? "historyWrapIv" : "liveWrapIv"));
      const wrappedDek = unb64(string(o, history ? "historyWrappedDek" : "liveWrappedDek"));
      const iv = unb64(string(o, "iv"));
      if (iv.length !== 12 || wrapIv.length !== 12) throw new Error("Invalid AEAD nonce length");
      const dek = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapIv,
        additionalData: binding(history ? "GMweb-history-DEK-v3" : "GMweb-live-DEK-v3", ...fields), tagLength: 128 },
        (history ?? live)!.key, wrappedDek));
      try {
        if (dek.length !== 32) throw new Error("Invalid DEK length");
        const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
        const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
          additionalData: binding("GMweb-message-v3", ...fields), tagLength: 128 }, key,
          unb64(string(o, "ciphertext")));
        const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid canonical payload");
        return { state: "decrypted", payload };
      } finally { dek.fill(0); }
    }
    const v2 = event.cryptoVersion === 2;
    const keyId = string(o, v2 ? "keyId" : "epochId");
    const domain = v2 ? string(o, "domain") : "";
    const entry = v2
      ? await loadCryptoRecord<{ key: CryptoKey; domain: string }>(`account-key:${keys.deviceId}:${pinned.root}:${keyId}`)
      : await loadCryptoRecord<{ key: CryptoKey; conversationId: string }>(`cke:${keys.deviceId}:${pinned.root}:${keyId}`);
    if (!entry) return { state: "locked", reason: "Authorized key grant unavailable" };
    if (v2 && "domain" in entry && entry.domain !== domain) throw new Error("Account key domain mismatch");
    if (!v2 && "conversationId" in entry && entry.conversationId !== event.aggregateId) throw new Error("CKE conversation mismatch");
    const fields = v2
      ? [keyId, domain, event.eventId, event.type, event.aggregateId!]
      : [keyId, event.eventId, event.type, event.aggregateId!];
    const wrapIv = unb64(string(o, "wrapIv"));
    const iv = unb64(string(o, "iv"));
    if (iv.length !== 12 || wrapIv.length !== 12) throw new Error("Invalid AEAD nonce length");
    const dek = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: wrapIv,
      additionalData: binding(v2 ? "GMweb-DEK-v2" : "GMweb-DEK-v1", ...fields), tagLength: 128 }, entry.key, unb64(string(o, "wrappedDek"))));
    try {
      if (dek.length !== 32) throw new Error("Invalid DEK length");
      const key = await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
        additionalData: binding(v2 ? "GMweb-message-v2" : "GMweb-message-v1", ...fields), tagLength: 128 }, key, unb64(string(o, "ciphertext")));
      const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid canonical payload");
      return { state: "decrypted", payload };
    } finally { dek.fill(0); }
  } catch (e) { return { state: "invalid", reason: e instanceof Error ? e.message : "AEAD authentication failed" }; }
}
