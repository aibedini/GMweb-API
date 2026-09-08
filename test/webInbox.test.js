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
  assert.deepEqual(buildConversations(rows), [{ aggregateId: 'thread', title: '+123', preview: 'Edited', lastAt: 100, read: true, unreadCount: 0 }]);
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

test('contactName wins the conversation title and address becomes the subtitle', async () => {
  const { buildConversations } = await import('../web/src/lib/inbox.ts');
  const rows = [
    event(1, 'MESSAGE_CREATED', { messageId: 'm1', body: 'Salam', address: '+989121234567', contactName: 'Ali Rezaei', dateMs: 100, direction: 'in' }),
    event(2, 'MESSAGE_CREATED', { messageId: 'm2', body: 'Reply', address: '+989121234567', contactName: 'Ali Rezaei', dateMs: 200, direction: 'out' }),
  ];
  assert.deepEqual(buildConversations(rows), [{
    aggregateId: 'thread', title: 'Ali Rezaei', subtitle: '+989121234567',
    preview: 'Reply', lastAt: 200, read: false, unreadCount: 1,
  }]);
  // Unknown number (no contactName) keeps the phone-number fallback title.
  assert.deepEqual(buildConversations([event(9, 'MESSAGE_CREATED', {
    messageId: 'm9', body: 'Who?', address: '+989190000000', dateMs: 300, direction: 'in',
  })]), [{ aggregateId: 'thread', title: '+989190000000', preview: 'Who?', lastAt: 300, read: false, unreadCount: 1 }]);
});

test('incoming and outgoing events both project into one conversation with correct directions', async () => {
  const { messagesForAggregate } = await import('../web/src/lib/inbox.ts');
  const rows = [
    event(1, 'MESSAGE_CREATED', { messageId: 'in1', body: 'Hello from you', address: '+123', dateMs: 100, direction: 'in' }),
    event(2, 'MESSAGE_CREATED', { messageId: 'out1', body: 'Hello back', address: '+123', dateMs: 200, direction: 'out' }),
  ];
  const timeline = messagesForAggregate(rows, 'thread');
  assert.equal(timeline.length, 2);
  assert.deepEqual(timeline.map((item) => item.payload.direction), ['in', 'out']);
  assert.deepEqual(timeline.map((item) => item.payload.body), ['Hello from you', 'Hello back']);
});
