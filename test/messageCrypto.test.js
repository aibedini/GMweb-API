const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const vector = require('../shared/message-crypto-v1.json');

test('Tink Android HPKE grant decrypts with non-extractable WebCrypto key; AEAD and grant tampering fail closed', async () => {
  global.indexedDB = indexedDB;
  const keysModule = await import('../web/src/lib/deviceKeys.ts');
  const cryptoModule = await import('../web/src/lib/messageCrypto.ts');
  const inbox = await import('../web/src/lib/inbox.ts');
  const keys = await keysModule.getOrCreateDeviceKeys();
  const privateKey = await crypto.subtle.importKey('pkcs8', Buffer.from(vector.recipientPrivatePkcs8, 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
  const publicKey = await crypto.subtle.importKey('raw', Buffer.from(vector.recipientPublicRaw, 'base64'),
    { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  await keysModule.saveCryptoRecord('primary', { ...keys, deviceId: 'device-test', encryptionPrivateKey: privateKey,
    encryptionPublicKey: publicKey, encryptionPublicKeyB64: vector.recipientPublicRaw });
  await keysModule.saveCryptoRecord('verified-primary', { deviceId: 'device-test', root: vector.rootPublicSpki,
    encryptionPublicKey: vector.recipientPublicRaw });
  const event = (type, envelope) => ({ sequence: 1, eventId: type === 'KEY_GRANT' ? 'grant-test' : 'event-test',
    type, aggregateId: 'conversation-test', createdAt: 100, encoding: 'envelope.v1', schemaVersion: 1,
    cryptoVersion: 1, ciphertext: Buffer.from(JSON.stringify(envelope)).toString('base64') });
  const message = event('MESSAGE_CREATED', vector.message);
  assert.equal((await cryptoModule.decryptMessage(message)).state, 'locked');
  const forgedGrant = event('KEY_GRANT', { ...vector.grant, historyFloor: 100 });
  assert.equal((await cryptoModule.receiveKeyGrant(forgedGrant)).state, 'invalid');
  assert.equal((await cryptoModule.receiveKeyGrant(event('KEY_GRANT', vector.grant))).state, 'key-grant');
  const decrypted = await cryptoModule.decryptMessage(message);
  assert.equal(decrypted.state, 'decrypted', JSON.stringify(decrypted));
  assert.deepEqual(decrypted.payload, vector.payload);
  assert.equal(inbox.buildConversations([{ ...message, decryption: decrypted }])[0].preview, vector.payload.body);
  const ciphertext = Buffer.from(vector.message.ciphertext, 'base64'); ciphertext[0] ^= 1;
  assert.equal((await cryptoModule.decryptMessage(event('MESSAGE_CREATED', { ...vector.message, ciphertext: ciphertext.toString('base64') }))).state, 'invalid');
  assert.equal((await cryptoModule.decryptMessage({ ...message, type: 'MESSAGE_DELETED' })).state, 'invalid');
  await assert.rejects(crypto.subtle.exportKey('pkcs8', privateKey));
});
