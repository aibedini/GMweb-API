const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

test("key sync failure does not block durable ciphertext replica catch-up", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  const sync = await import("../web/src/lib/sync.ts");
  sync.resetLocal();
  let eventRequests = 0;

  global.fetch = async url => {
    const path = String(url);
    if (/\/linked-device\/(?:key-grants|keyring)/.test(path)) {
      throw new Error("key service unavailable");
    }
    if (/\/web\/snapshot-v2/.test(path)) {
      return Response.json({
        token: "degraded-key-snapshot",
        snapshotVersion: 1,
        baselineSequence: 0,
        replicaGeneration: "degraded-key-test-generation",
        expiresAt: Date.now() + 60_000,
        contactEvents: [],
        rows: [],
        nextCursor: null,
        hasMore: false,
      });
    }
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    eventRequests += 1;
    const after = Number(new URL(path, "https://example.test").searchParams.get("after") || 0);
    if (after === 0) {
      return Response.json({
        events: [{
          sequence: 1,
          eventId: "opaque-status-1",
          aggregateId: null,
          type: "DEVICE_STATUS_CHANGED",
          createdAt: 1,
          cryptoVersion: 1,
          encoding: "envelope.v1",
          schemaVersion: 1,
          ciphertext: Buffer.from("opaque").toString("base64"),
        }],
        nextCursor: 1,
        hasMore: false,
        replicaGeneration: "degraded-key-test-generation",
        snapshotVersion: 1,
      });
    }
    return Response.json({ events: [], nextCursor: after, hasMore: false });
  };

  try {
    assert.equal(await sync.syncNow(), 1);
    assert.equal(await sync.getCursor(), 1);
    assert.equal(eventRequests, 1);
    assert.equal(sync.getBrowserSyncStatus().state, "DEGRADED");
    assert.equal(sync.getBrowserSyncStatus().lastErrorPhase, "KEY_SYNC");
  } finally {
    global.fetch = originalFetch;
  }
});

test("a stalled key endpoint cannot indefinitely block ciphertext catch-up", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  const sync = await import("../web/src/lib/sync.ts");
  await sync.resetLocal();
  global.fetch = async url => {
    const path = String(url);
    if (path.includes("/linked-device/keyring")) return new Promise(() => {});
    if (path.includes("/web/snapshot-v2")) return Response.json({ token: "timeout-snapshot",
      replicaGeneration: "timeout-generation", snapshotVersion: 1, baselineSequence: 0,
      expiresAt: Date.now() + 60_000, contactEvents: [], rows: [], nextCursor: null, hasMore: false });
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    if (path.includes("/sync?after=0")) return Response.json({ events: [{ sequence: 1,
      eventId: "timeout-cipher", aggregateId: null, type: "DEVICE_STATUS_CHANGED",
      sourceDeviceId: "phone", createdAt: 1, cryptoVersion: 1, encoding: "envelope.v1",
      schemaVersion: 1, ciphertext: Buffer.from("opaque").toString("base64") }],
      nextCursor: 1, hasMore: false, replicaGeneration: "timeout-generation", snapshotVersion: 1 });
    throw new Error(`unexpected fetch ${path}`);
  };
  let timer;
  try {
    const bounded = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("key timeout did not release sync")), 5_000);
    });
    assert.equal(await Promise.race([sync.syncNow(), bounded]), 1);
    assert.equal(await sync.getCursor(), 1);
    assert.equal(sync.getBrowserSyncStatus().state, "DEGRADED");
    assert.equal(sync.getBrowserSyncStatus().lastErrorPhase, "KEY_SYNC");
  } finally {
    clearTimeout(timer);
    global.fetch = originalFetch;
  }
});
