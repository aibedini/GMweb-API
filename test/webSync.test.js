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
    type: i < 10 ? 'MESSAGE_CREATED' : 'THREAD_READ',
    createdAt: i + 1,
    cryptoVersion: 0,
    encoding: 'envelope.v1',
    schemaVersion: 1,
    ciphertext: '',
  }));
  global.fetch = async url => {
    if (String(url).includes('/linked-device/key-grants')) {
      grantRequests++;
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
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
    assert.equal(grantRequests, 1);
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
    global.fetch = async url => String(url).includes('/linked-device/key-grants')
      ? Response.json({ events: [], nextCursor: 0, hasMore: false })
      : Response.json({ events: [{ sequence: 1201 }], nextCursor: 1199, hasMore: false });
    await assert.rejects(sync.syncNow(), /Invalid sync page/);
    assert.equal(await sync.getCursor(), 1200);
    assert.equal(sync.getBrowserSyncStatus().state, 'DEGRADED');
    global.fetch = async url => Response.json({ events: [], nextCursor: String(url).includes('/linked-device/key-grants') ? 0 : 1200, hasMore: false });
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
    db.close();
  } finally { global.fetch = originalFetch; }
});
