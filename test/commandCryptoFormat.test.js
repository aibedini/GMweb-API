// Command encryption wire format.
//
// PRODUCTION BUG this pins down: Android v3.4.x registers its command
// encryption key as DER SubjectPublicKeyInfo (`toSpkiB64`), but
// commandCrypto imported it with WebCrypto "raw", which expects an
// uncompressed point (0x04||X||Y). The browser raised
// DataError: Invalid keyData and the composer said
// "Could not encrypt this message."
//
// Confirmed against the live production key: 91 bytes, first byte 0x30,
// importKey("raw") THREW DataError / importKey("spki") OK.
import test from "node:test";
import assert from "node:assert/strict";
import { encryptCommand, importCommandPublicKey, CommandCryptoError } from "../web/src/lib/commandCrypto.ts";
import { binding } from "../web/src/lib/binary.ts";

const subtle = globalThis.crypto.subtle;
const RAW_P256_LENGTH = 65;
const SPKI_P256_LENGTH = 91;

/** Base64 with no padding, matching the Android encoder. */
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

/**
 * A P-256 ECDH keypair whose public key can be exported in BOTH wire formats,
 * mirroring what an Android device produces.
 */
async function androidLikeKeyPair() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pair, spkiB64: b64(spki), rawB64: b64(raw), spki, raw };
}

/** Decrypt a command envelope exactly as Android's CommandCrypto would. */
async function decryptCommand(envelopeB64, privateKey, type, idempotencyKey) {
  const envelope = JSON.parse(Buffer.from(envelopeB64, "base64").toString("utf8"));
  assert.equal(envelope.v, 1, "envelope version unchanged");
  assert.equal(envelope.kind, "command", "envelope kind unchanged");
  const ephemeralPublicKey = await subtle.importKey(
    "raw", Buffer.from(envelope.ephemeralPublicKey, "base64"),
    { name: "ECDH", namedCurve: "P-256" }, false, [],
  );
  const shared = new Uint8Array(await subtle.deriveBits(
    { name: "ECDH", public: ephemeralPublicKey }, privateKey, 256,
  ));
  const aad = binding("GMweb-command-v1", type, idempotencyKey);
  const material = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: aad },
    material, { name: "AES-GCM", length: 256 }, false, ["decrypt"],
  );
  const plaintext = new Uint8Array(await subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64"), additionalData: aad, tagLength: 128 },
    key, Buffer.from(envelope.ciphertext, "base64"),
  ));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ------------------------------------------------------- format detection

test("the production key shape (91-byte DER SPKI) imports successfully", async () => {
  const { spkiB64, spki } = await androidLikeKeyPair();
  assert.equal(spki.length, SPKI_P256_LENGTH);
  assert.equal(spki[0], 0x30, "DER SEQUENCE");
  // This is the exact call that used to throw DataError.
  await assert.doesNotReject(() => importCommandPublicKey(spkiB64, "spki-p256"));
  // And the reason it failed: raw import of SPKI bytes is invalid.
  await assert.rejects(
    () => subtle.importKey("raw", spki, { name: "ECDH", namedCurve: "P-256" }, false, []),
    (error) => error.name === "DataError",
    "raw import of an SPKI key must fail with DataError (the production symptom)",
  );
});

test("an explicit format is honoured and a contradiction is rejected", async () => {
  const { spkiB64, rawB64 } = await androidLikeKeyPair();
  await assert.doesNotReject(() => importCommandPublicKey(rawB64, "raw-p256"));
  // Declaring the wrong format is a protocol error, not something to guess past.
  await assert.rejects(() => importCommandPublicKey(spkiB64, "raw-p256"),
    (e) => e instanceof CommandCryptoError && e.code === "COMMAND_KEY_INVALID");
  await assert.rejects(() => importCommandPublicKey(rawB64, "spki-p256"),
    (e) => e instanceof CommandCryptoError && e.code === "COMMAND_KEY_INVALID");
});

test("backward compatibility: format absent is sniffed, both shapes work", async () => {
  const { spkiB64, rawB64 } = await androidLikeKeyPair();
  await assert.doesNotReject(() => importCommandPublicKey(spkiB64), "old server + new key");
  await assert.doesNotReject(() => importCommandPublicKey(rawB64), "new server + old device");
  await assert.doesNotReject(() => importCommandPublicKey(spkiB64, undefined));
  await assert.doesNotReject(() => importCommandPublicKey(rawB64, null));
});

test("invalid keys raise distinct machine-readable codes, never a blanket failure", async () => {
  const { spki } = await androidLikeKeyPair();
  const cases = [
    ["", "COMMAND_KEY_UNAVAILABLE"],
    ["!!!not-base64!!!", null],
    [Buffer.from("hello world").toString("base64"), "COMMAND_KEY_FORMAT_UNSUPPORTED"],
    [Buffer.from(spki.subarray(0, 40)).toString("base64"), "COMMAND_KEY_FORMAT_UNSUPPORTED"],
  ];
  for (const [value, code] of cases) {
    await assert.rejects(() => importCommandPublicKey(value), (error) => {
      assert.ok(error instanceof CommandCryptoError, `${value} should raise CommandCryptoError`);
      if (code) assert.equal(error.code, code);
      // Diagnostics must be safe: no key material, ever.
      assert.doesNotMatch(error.diagnostics(), /[A-Za-z0-9+/]{40,}/);
      assert.match(error.diagnostics(), /stage=IMPORT_RECIPIENT_KEY/);
      return true;
    });
  }
});

test("a non-P-256 DER key is rejected rather than silently accepted", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" })
    .publicKey.export({ format: "der", type: "spki" });
  await assert.rejects(() => importCommandPublicKey(p384.toString("base64")), (error) => {
    assert.equal(error.code, "COMMAND_KEY_FORMAT_UNSUPPORTED");
    assert.equal(error.format, "unknown");
    return true;
  });
});

// ------------------------------------------------------------- roundtrip

test("SPKI recipient key: full encrypt -> decrypt roundtrip for every command type", async () => {
  const { pair, spkiB64 } = await androidLikeKeyPair();
  const payloads = {
    SEND_SMS: { type: "SEND_SMS", phone: "+989121234567", body: "تست تولید از وب 👋", clientMessageId: "c-1" },
    MARK_THREAD_READ: { type: "MARK_THREAD_READ", conversationId: "conv-1" },
    REFRESH_DEVICE_TELEMETRY: { type: "REFRESH_DEVICE_TELEMETRY", reason: "SIM_REFRESH", requestedAt: 1 },
  };
  for (const [type, payload] of Object.entries(payloads)) {
    const idempotencyKey = `key-${type}`;
    const envelope = await encryptCommand(spkiB64, type, idempotencyKey, payload, "spki-p256");
    const decrypted = await decryptCommand(envelope, pair.privateKey, type, idempotencyKey);
    assert.deepEqual(decrypted, payload, `${type} must round-trip exactly`);
  }
});

test("raw recipient key still round-trips (older enrolled devices)", async () => {
  const { pair, rawB64 } = await androidLikeKeyPair();
  const payload = { type: "SEND_SMS", phone: "+1", body: "legacy", clientMessageId: "c-2" };
  const envelope = await encryptCommand(rawB64, "SEND_SMS", "legacy-key", payload, "raw-p256");
  assert.deepEqual(await decryptCommand(envelope, pair.privateKey, "SEND_SMS", "legacy-key"), payload);
  // Format omitted: sniffing must still pick raw.
  const sniffed = await encryptCommand(rawB64, "SEND_SMS", "legacy-key-2", payload);
  assert.deepEqual(await decryptCommand(sniffed, pair.privateKey, "SEND_SMS", "legacy-key-2"), payload);
});

test("the AEAD binding is type- and idempotency-bound", async () => {
  const { pair, spkiB64 } = await androidLikeKeyPair();
  const payload = { type: "SEND_SMS", body: "x" };
  const envelope = await encryptCommand(spkiB64, "SEND_SMS", "key-a", payload, "spki-p256");
  // A different type or idempotency key must not decrypt: the AAD differs.
  await assert.rejects(() => decryptCommand(envelope, pair.privateKey, "MARK_THREAD_READ", "key-a"));
  await assert.rejects(() => decryptCommand(envelope, pair.privateKey, "SEND_SMS", "key-b"));
  // The genuine pair still works.
  assert.deepEqual(await decryptCommand(envelope, pair.privateKey, "SEND_SMS", "key-a"), payload);
});

test("the envelope keeps its wire shape and the ephemeral key stays raw", async () => {
  const { spkiB64 } = await androidLikeKeyPair();
  const envelopeB64 = await encryptCommand(spkiB64, "SEND_SMS", "k", { type: "SEND_SMS" }, "spki-p256");
  const envelope = JSON.parse(Buffer.from(envelopeB64, "base64").toString("utf8"));
  assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "ephemeralPublicKey", "iv", "kind", "v"]);
  const ephemeral = Buffer.from(envelope.ephemeralPublicKey, "base64");
  assert.equal(ephemeral.length, RAW_P256_LENGTH, "ephemeral key stays a raw uncompressed point");
  assert.equal(ephemeral[0], 0x04);
  assert.equal(Buffer.from(envelope.iv, "base64").length, 12);
});
