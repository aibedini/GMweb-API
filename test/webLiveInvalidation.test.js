"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("SSE wake-ups are coalesced and a reconnect always catches up", async () => {
  const previous = global.EventSource;
  const previousFetch = global.fetch;
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; streams.push(this); }
    close() { this.closed = true; }
  }
  global.EventSource = FakeEventSource;
  global.fetch = async () => Response.json({ authenticated: true });
  try {
    const { subscribeSyncAvailable } = await import("../web/src/lib/sync/live-invalidation.ts");
    let pulls = 0;
    const targets = [];
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    const dispose = subscribeSyncAvailable(async ids => {
      pulls += 1;
      targets.push(ids);
      if (pulls === 1) await first;
      return 1;
    }, () => {}, () => {});
    streams[0].onopen();
    for (let index = 0; index < 100; index++)
      streams[0].onmessage({ data: '{"type":"sync.available","conversationIds":["opaque-thread"]}' });
    assert.equal(pulls, 1);
    finish();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pulls, 2);
    assert.deepEqual(targets, [undefined, ["opaque-thread"]]);
    streams[0].onerror();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(streams.length, 2);
    streams[1].onopen();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(pulls, 3);
    dispose();
  } finally {
    global.EventSource = previous;
    global.fetch = previousFetch;
  }
});
