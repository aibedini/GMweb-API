const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

test('latest N uses a descending cursor; concurrent/repeated sync is idempotent beyond 500 records', async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  let requests = 0;
  let grantRequests = 0;
  const rows = Array.from({ length: 1200 }, (_, i) => ({
    sequence: i + 1,
    eventId: `e${i}`,
    aggregateId: 'thread',
    type: i < 10 ? 'MESSAGE_CREATED' : 'DEVICE_STATUS_CHANGED',
    createdAt: i + 1,
    cryptoVersion: i < 10 ? 3 : 1,
    encoding: i < 10 ? 'envelope.v3' : 'envelope.v1',
    schemaVersion: 1,
    ciphertext: Buffer.from(i < 10 ? JSON.stringify({
      v: 3, kind: 'message', eventId: `e${i}`, type: 'MESSAGE_CREATED', conversationId: 'thread',
      iv: Buffer.alloc(12, 7).toString('base64'), ciphertext: Buffer.alloc(16, 7).toString('base64'),
      historyWrapIv: Buffer.alloc(12, 7).toString('base64'), historyWrappedDek: Buffer.alloc(16, 7).toString('base64'),
      liveWrapIv: Buffer.alloc(12, 7).toString('base64'), liveWrappedDek: Buffer.alloc(16, 7).toString('base64'),
    }) : 'status').toString('base64'),
  }));
  global.fetch = async url => {
    if (/\/linked-device\/(?:key-grants|keyring)/.test(String(url))) {
      grantRequests++;
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (/\/web\/bootstrap/.test(String(url))) {
      return Response.json({ protocolVersion: 3, snapshotVersion: 1, highWatermark: 0,
        replicaGeneration: 'test-generation', minimumAvailableSequence: 0,
        conversations: [], nextCursor: null, hasMore: false });
    }
    requests++;
    const after = Number(new URL(url, 'https://example.test').searchParams.get('after'));
    const events = rows.filter(row => row.sequence > after).slice(0, 500);
    const nextCursor = events.at(-1)?.sequence ?? after;
    return Response.json({ events, nextCursor, hasMore: nextCursor < rows.length });
  };
  try {
    const sync = await import('../web/src/lib/sync.ts');
    await sync.resetLocal();
    const first = sync.syncNow();
    assert.equal(first, sync.syncNow(), 'concurrent callers share one drain');
    assert.equal(await first, 1200);
    assert.equal(requests, 3);
    assert.equal(grantRequests, 2);
    const latest = await sync.listRecentEvents(500);
    assert.deepEqual(latest.map(row => row.sequence), Array.from({ length: 500 }, (_, i) => 1200 - i));
    assert.equal(await sync.getCursor(), 1200);
    assert.equal(await sync.syncNow(), 0);
    assert.equal((await sync.listAggregateEvents('thread')).length, 1200);
    const firstPage = await sync.listAggregateEventsPage('thread', { limit: 200 });
    assert.deepEqual(firstPage.items.map(row => row.sequence), Array.from({ length: 200 }, (_, i) => 1200 - i));
    assert.equal(firstPage.hasMore, true);
    assert.equal(firstPage.next, 1001);
    const olderPage = await sync.listAggregateEventsPage('thread', { limit: 200, beforeSequence: firstPage.next });
    assert.deepEqual(olderPage.items.map(row => row.sequence), Array.from({ length: 200 }, (_, i) => 1000 - i));
    assert.equal(olderPage.hasMore, true);
    assert.equal(olderPage.next, 801);
    assert.deepEqual(await sync.listAggregateEventsPage('missing'), { items: [], hasMore: false, next: undefined });
    assert.equal((await sync.listInboxEvents()).filter(e => e.type === 'MESSAGE_CREATED').length, 10,
      'more than 500 status/grant events must not displace message-bearing threads');
    assert.deepEqual(await sync.listRecentEvents(0), []);
    await assert.rejects(sync.listRecentEvents(-1), RangeError);
    global.fetch = async url => /\/linked-device\/(?:key-grants|keyring)/.test(String(url))
      ? Response.json({ events: [], nextCursor: 0, hasMore: false })
      : Response.json({ events: [{ sequence: 1201 }], nextCursor: 1199, hasMore: false });
    await assert.rejects(sync.syncNow(), /Invalid sync page/);
    assert.equal(await sync.getCursor(), 1200);
    assert.equal(sync.getBrowserSyncStatus().state, 'DEGRADED');
    global.fetch = async url => Response.json({ events: [], nextCursor: /\/linked-device\/(?:key-grants|keyring)/.test(String(url)) ? 0 : 1200, hasMore: false });
    assert.equal(await sync.syncNow(), 0);
    assert.equal(sync.getBrowserSyncStatus().state, 'UP_TO_DATE');

    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('gmweb-messages');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(['conversations', 'meta'], 'readwrite');
      transaction.objectStore('conversations').clear();
      transaction.objectStore('meta').put(0, sync.PROJECTION_CURSOR_KEY);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    await sync.repairConversationProjection();
    assert.equal(await sync.getProjectionCursor(), 1200);
    const repaired = await sync.listConversations();
    assert.equal(repaired.items.length, 1);
    assert.equal(repaired.items[0].aggregateId, 'thread');

    const seed = db.transaction('encrypted_message_state', 'readwrite');
    for (let i = 1; i <= 1050; i++) seed.objectStore('encrypted_message_state').put({
      messageId: `large-${String(i).padStart(4, '0')}`,
      conversationId: 'large-thread', type: 'MESSAGE_CREATED', tombstone: false,
      revision: 1, sortKey: i, envelope: Buffer.from('opaque').toString('base64'),
      encoding: 'envelope.v3', schemaVersion: 1, cryptoVersion: 3, lastServerSequence: i,
    });
    await new Promise((resolve, reject) => {
      seed.oncomplete = resolve;
      seed.onerror = () => reject(seed.error);
    });
    const pagedIds = [];
    let beforeState;
    do {
      const page = await sync.listAggregateEventsPage('large-thread', { limit: 50, beforeState });
      pagedIds.push(...page.items.map(item => item.messageId));
      beforeState = page.next;
      if (!page.hasMore) break;
    } while (true);
    assert.equal(pagedIds.length, 1050);
    assert.equal(new Set(pagedIds).size, 1050);
    assert.deepEqual(pagedIds.slice(0, 3), ['large-1050', 'large-1049', 'large-1048']);
    assert.deepEqual(pagedIds.slice(-3), ['large-0003', 'large-0002', 'large-0001']);
    db.close();
  } finally { global.fetch = originalFetch; }
});
