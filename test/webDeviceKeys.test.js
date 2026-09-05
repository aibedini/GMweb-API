const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');

test('concurrent pairing generates one durable non-extractable identity', async () => {
  global.indexedDB = indexedDB;
  const { getOrCreateDeviceKeys } = await import('../web/src/lib/deviceKeys.ts');
  const [a, b] = await Promise.all([getOrCreateDeviceKeys(), getOrCreateDeviceKeys()]);
  assert.equal(a.deviceId, b.deviceId);
  assert.equal(a.signingPublicKeyB64, b.signingPublicKeyB64);
  const restored = await getOrCreateDeviceKeys();
  assert.equal(restored.deviceId, a.deviceId);
  assert.equal(restored.encryptionPublicKeyB64, a.encryptionPublicKeyB64);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', restored.encryptionPrivateKey));
  await assert.rejects(crypto.subtle.exportKey('pkcs8', restored.signingPrivateKey));
});
