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

test("v3 FULL_HISTORY needs one origin-bound browser history key", async () => {
  global.indexedDB = indexedDB;
  const { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } = await import("@hpke/core");
  const keysModule = await import("../web/src/lib/deviceKeys.ts");
  const messageCrypto = await import("../web/src/lib/messageCrypto.ts");
  await keysModule.wipeDeviceKeys();
  const generated = await keysModule.getOrCreateDeviceKeys();
  const recipient = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits", "deriveKey"]
  );
  const root = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const recipientPublicRaw = Buffer.from(await crypto.subtle.exportKey("raw", recipient.publicKey)).toString("base64");
  const rootPublicSpki = Buffer.from(await crypto.subtle.exportKey("spki", root.publicKey)).toString("base64");
  const certificate = {
    webOrigin: "https://gmweb.example", trustSequence: 41, pairingTranscriptHash: "transcript-41",
  };
  await keysModule.saveCryptoRecord("primary", {
    ...generated, deviceId: "browser-v3", encryptionPrivateKey: recipient.privateKey,
    encryptionPublicKey: recipient.publicKey, encryptionPublicKeyB64: recipientPublicRaw,
  });
  await keysModule.saveCryptoRecord("verified-primary", {
    deviceId: "browser-v3", root: rootPublicSpki,
    encryptionPublicKey: recipientPublicRaw, certificate,
  });

  const historyKey = crypto.getRandomValues(new Uint8Array(32));
  const grantFields = ["history-1", "browser-v3", certificate.webOrigin,
    String(certificate.trustSequence), certificate.pairingTranscriptHash, recipientPublicRaw];
  const suite = new CipherSuite({
    kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm(),
  });
  const sender = await suite.createSenderContext({
    recipientPublicKey: recipient.publicKey,
    info: messageCrypto.binding("GMweb-history-key-v3", ...grantFields),
  });
  const sealedKey = new Uint8Array(await sender.seal(historyKey));
  const wrappedKey = Buffer.concat([Buffer.from(sender.enc), Buffer.from(sealedKey)]).toString("base64");
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, root.privateKey,
    messageCrypto.binding("GMweb-history-key-signature-v3", ...grantFields, wrappedKey)
  ));
  const event = (type, id, aggregateId, envelope, cryptoVersion = 3) => ({
    sequence: 1, eventId: id, type, aggregateId, sourceDeviceId: "android",
    createdAt: 1, encoding: `envelope.v${cryptoVersion}`, schemaVersion: 1, cryptoVersion,
    ciphertext: Buffer.from(JSON.stringify(envelope)).toString("base64"),
  });
  const grant = {
    v: 3, kind: "history-key-grant", keyId: grantFields[0], deviceId: grantFields[1],
    origin: grantFields[2], trustSequence: 41, encryptionPublicKey: recipientPublicRaw,
    pairingTranscriptHash: certificate.pairingTranscriptHash,
    wrappedKey, rootSignature: rawEcdsaToDer(rawSignature).toString("base64"),
  };
  assert.deepEqual(await messageCrypto.receiveKeyGrant(
    event("HISTORY_KEY_GRANT", "grant-1", "__history_master__", grant)
  ), { state: "key-grant", reason: "Authorized history key stored" });

  const fields = ["history-1", "live-1", "READ_MESSAGES", "message-1", "MESSAGE_CREATED", "thread-1"];
  const seal = async (keyBytes, plaintext, aad) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, plaintext);
    return { iv: Buffer.from(iv).toString("base64"), ciphertext: Buffer.from(ciphertext).toString("base64") };
  };
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const liveKey = crypto.getRandomValues(new Uint8Array(32));
  const payload = new TextEncoder().encode(JSON.stringify({ messageId: "m1", body: "full history" }));
  const body = await seal(dek, payload, messageCrypto.binding("GMweb-message-v3", ...fields));
  const historyWrap = await seal(historyKey, dek, messageCrypto.binding("GMweb-history-DEK-v3", ...fields));
  const liveWrap = await seal(liveKey, dek,
    messageCrypto.binding("GMweb-live-DEK-v3", ...fields));
  const messageEnvelope = {
    v: 3, kind: "message", historyKeyId: "history-1", liveKeyId: "live-1", domain: "READ_MESSAGES",
    eventId: "message-1", type: "MESSAGE_CREATED", conversationId: "thread-1",
    iv: body.iv, ciphertext: body.ciphertext,
    historyWrapIv: historyWrap.iv, historyWrappedDek: historyWrap.ciphertext,
    liveWrapIv: liveWrap.iv, liveWrappedDek: liveWrap.ciphertext,
  };
  const decrypted = await messageCrypto.decryptMessage(
    event("MESSAGE_CREATED", "message-1", "thread-1", messageEnvelope)
  );
  assert.equal(decrypted.state, "decrypted");
  assert.deepEqual(decrypted.payload, { messageId: "m1", body: "full history" });

  await keysModule.saveCryptoRecord(`history-key:browser-v3:${rootPublicSpki}:history-1`, null);
  const liveCryptoKey = await crypto.subtle.importKey("raw", liveKey, "AES-GCM", false, ["decrypt"]);
  await keysModule.saveCryptoRecord(`account-key:browser-v3:${rootPublicSpki}:live-1`, {
    key: liveCryptoKey, domain: "READ_MESSAGES",
  });
  const fromNowOn = await messageCrypto.decryptMessage(
    event("MESSAGE_CREATED", "message-1", "thread-1", messageEnvelope)
  );
  assert.equal(fromNowOn.state, "decrypted");

  assert.deepEqual(await messageCrypto.receiveKeyGrant(
    event("HISTORY_KEY_GRANT", "grant-2", "__history_master__", { ...grant, origin: "https://evil.example" })
  ), { state: "invalid", reason: "History grant pairing binding mismatch" });
});
