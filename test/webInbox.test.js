const test = require('node:test');
const assert = require('node:assert/strict');

function event(sequence, type, payload, aggregateId = 'thread') {
  return { sequence, eventId: `event-${sequence}`, type, aggregateId, sourceDeviceId: 'phone',
    createdAt: sequence, encoding: 'envelope.v1', schemaVersion: 1, cryptoVersion: 0,
    ciphertext: Buffer.from(JSON.stringify({ cryptoVersion: 0, encoding: 'application/json',
      ciphertextB64: Buffer.from(JSON.stringify(payload)).toString('base64') })).toString('base64') };
}

test('canonical projection updates, reads, deletes and deduplicates without empty threads', async () => {
  const { buildConversations, messagesForAggregate, decodeEventPayload, eventDecodeState } = await import('../web/src/lib/inbox.ts');
  const created = event(1, 'MESSAGE_CREATED', { messageId: 'm', body: 'Hello', address: '+123', dateMs: 100, direction: 'out' });
  const updated = event(2, 'MESSAGE_UPDATED', { messageId: 'm', body: 'Edited', address: '+123', dateMs: 100, direction: 'out' });
  const rows = [created, created, updated,
    event(3, 'MESSAGE_STATUS_CHANGED', { messageId: 'm', status: 2 }),
    event(4, 'THREAD_READ', { readAtMs: 200 }),
    event(5, 'MESSAGE_STATUS_CHANGED', { messageId: 'unknown', status: 1 }, 'noise')];
  assert.equal(decodeEventPayload(created).body, 'Hello');
  assert.equal(eventDecodeState(created), 'Legacy/plaintext-envelope');
  assert.deepEqual(buildConversations(rows), [{ aggregateId: 'thread', title: '+123', preview: 'Edited', lastAt: 100, read: true }]);
  const messages = messagesForAggregate(rows, 'thread');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].payload.status, 2);
  assert.deepEqual(buildConversations([...rows, event(6, 'MESSAGE_DELETED', { messageId: 'm' })]), []);
  assert.deepEqual(buildConversations([event(7, 'THREAD_READ', { readAtMs: 300 })]), []);
});

test('unsupported crypto is locked, corrupt legacy fails closed, neither claims E2EE', async () => {
  const { decodeEventPayload, eventDecodeState, buildConversations } = await import('../web/src/lib/inbox.ts');
  const encrypted = { ...event(1, 'MESSAGE_CREATED', { body: 'do not decode' }), cryptoVersion: 1 };
  assert.equal(decodeEventPayload(encrypted), null);
  assert.equal(eventDecodeState(encrypted), 'Locked/unsupported crypto version');
  const corrupt = { ...encrypted, cryptoVersion: 0, ciphertext: 'bad!' };
  assert.equal(eventDecodeState(corrupt), 'Invalid/corrupt payload');
  assert.deepEqual(buildConversations([encrypted, corrupt]), []);
});
