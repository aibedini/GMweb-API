const test = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');

test('latest N uses a descending cursor; concurrent/repeated sync is idempotent beyond 500 records', async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  let requests = 0;
  const rows = Array.from({ length: 1200 }, (_, i) => ({ sequence: i + 1, eventId: `e${i}`, aggregateId: 'thread', type: i < 10 ? 'MESSAGE_CREATED' : 'THREAD_READ' }));
  global.fetch = async url => {
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
    const latest = await sync.listRecentEvents(500);
    assert.deepEqual(latest.map(row => row.sequence), Array.from({ length: 500 }, (_, i) => 1200 - i));
    assert.equal(await sync.getCursor(), 1200);
    assert.equal(await sync.syncNow(), 0);
    assert.equal((await sync.listAggregateEvents('thread')).length, 1200);
    assert.equal((await sync.listInboxEvents()).filter(e => e.type === 'MESSAGE_CREATED').length, 10,
      'more than 500 status/grant events must not displace message-bearing threads');
    assert.deepEqual(await sync.listRecentEvents(0), []);
    await assert.rejects(sync.listRecentEvents(-1), RangeError);
    global.fetch = async () => Response.json({ events: [{ sequence: 1201 }], nextCursor: 1199, hasMore: false });
    await assert.rejects(sync.syncNow(), /Invalid sync page/);
    assert.equal(await sync.getCursor(), 1200);
  } finally { global.fetch = originalFetch; }
});
