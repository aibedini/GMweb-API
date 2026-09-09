const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB } = require("fake-indexeddb");

function rawEcdsaToDer(raw) {
  const integer = (part) => {
    let value = Buffer.from(part);
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([integer(raw.subarray(0, 32)), integer(raw.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

test("v2 bounded account keyring unlocks an envelope without a conversation grant", async () => {
  global.indexedDB = indexedDB;
  const { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = await import("@hpke/core");
  const keysModule = await import("../web/src/lib/deviceKeys.ts");
  const messageCrypto = await import("../web/src/lib/messageCrypto.ts");
  const keys = await keysModule.getOrCreateDeviceKeys();
  const recipient = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]
  );
  const root = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const recipientPublicRaw = Buffer.from(await crypto.subtle.exportKey("raw", recipient.publicKey)).toString("base64");
  const rootPublicSpki = Buffer.from(await crypto.subtle.exportKey("spki", root.publicKey)).toString("base64");
  await keysModule.saveCryptoRecord("primary", {
    ...keys,
    deviceId: "browser-v2",
    encryptionPrivateKey: recipient.privateKey,
    encryptionPublicKey: recipient.publicKey,
    encryptionPublicKeyB64: recipientPublicRaw,
  });
  await keysModule.saveCryptoRecord("verified-primary", {
    deviceId: "browser-v2", root: rootPublicSpki, encryptionPublicKey: recipientPublicRaw,
  });

  const accountKey = crypto.getRandomValues(new Uint8Array(32));
  const fields = ["key-v2", "READ_MESSAGES", "browser-v2", "7"];
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
  });
  const sender = await suite.createSenderContext({
    recipientPublicKey: recipient.publicKey,
    info: messageCrypto.binding("GMweb-account-key-v2", ...fields),
  });
  const sealedKey = new Uint8Array(await sender.seal(accountKey));
  const wrappedKey = Buffer.concat([Buffer.from(sender.enc), Buffer.from(sealedKey)]).toString("base64");
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, root.privateKey,
    messageCrypto.binding("GMweb-account-key-signature-v2", ...fields, wrappedKey)
  ));
  const keyringEnvelope = {
    v: 2, kind: "keyring-entry", keyId: fields[0], domain: fields[1], deviceId: fields[2],
    generation: 7, wrappedKey, rootSignature: rawEcdsaToDer(rawSignature).toString("base64"),
  };
  const event = (type, id, aggregateId, envelope) => ({
    sequence: 1, eventId: id, type, aggregateId, sourceDeviceId: "android",
    createdAt: 1, encoding: "envelope.v2", schemaVersion: 1, cryptoVersion: 2,
    ciphertext: Buffer.from(JSON.stringify(envelope)).toString("base64"),
  });
  const accepted = await messageCrypto.receiveKeyGrant(
    event("KEYRING_ENTRY", "keyring-1", "__account_keyring__", keyringEnvelope)
  );
  assert.deepEqual(accepted, { state: "key-grant", reason: "Authorized account key stored" });

  const messageFields = ["key-v2", "READ_MESSAGES", "message-1", "MESSAGE_CREATED", "thread-1"];
  const seal = async (keyBytes, plaintext, aad) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext);
    return { iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") };
  };
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const payload = new TextEncoder().encode(JSON.stringify({ messageId: "m1", body: "hello" }));
  const body = await seal(dek, payload, messageCrypto.binding("GMweb-message-v2", ...messageFields));
  const wrappedDek = await seal(accountKey, dek, messageCrypto.binding("GMweb-DEK-v2", ...messageFields));
  const decrypted = await messageCrypto.decryptMessage(event("MESSAGE_CREATED", "message-1", "thread-1", {
    v: 2, kind: "message", keyId: "key-v2", domain: "READ_MESSAGES",
    eventId: "message-1", type: "MESSAGE_CREATED", conversationId: "thread-1",
    iv: body.iv, ciphertext: body.ciphertext, wrapIv: wrappedDek.iv, wrappedDek: wrappedDek.ciphertext,
  }));
  assert.equal(decrypted.state, "decrypted");
  assert.deepEqual(decrypted.payload, { messageId: "m1", body: "hello" });
});
