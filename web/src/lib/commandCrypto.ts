import { binding, unb64 } from "./messageCrypto";

function b64(value: Uint8Array): string {
  return btoa(Array.from(value, byte => String.fromCharCode(byte)).join(""));
}

/** Encrypt a command to Android's non-exportable operational ECDH key. */
export async function encryptCommand(
  publicKeyB64: string,
  type: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const recipient = await crypto.subtle.importKey(
    "raw", unb64(publicKeyB64), { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
  );
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipient }, ephemeral.privateKey, 256,
  ));
  const aad = binding("GMweb-command-v1", type, idempotencyKey);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  shared.fill(0);
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: aad },
    material, { name: "AES-GCM", length: 256 }, false, ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
    key, new TextEncoder().encode(JSON.stringify(payload)),
  ));
  const ephemeralPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const envelope = { v: 1, kind: "command", ephemeralPublicKey: b64(ephemeralPublicKey), iv: b64(iv), ciphertext: b64(ciphertext) };
  return b64(new TextEncoder().encode(JSON.stringify(envelope)));
}
