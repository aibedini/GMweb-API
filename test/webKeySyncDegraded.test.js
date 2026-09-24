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
    const keys = await (await import("../web/src/lib/deviceKeys.ts")).getOrCreateDeviceKeys();
    const progress = await sync.getReplicationProgress(keys.deviceId);
    assert.equal(progress.snapshotComplete, true);
    assert.equal(progress.snapshotBaseline, 0);
    assert.equal(progress.keyringCursor, 0);
    assert.equal(progress.grantCursor, 0);
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
  let keyRequestAborted = false;
  global.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes("/linked-device/keyring")) return new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => {
        keyRequestAborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
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
    assert.equal(keyRequestAborted, true);
  } finally {
    clearTimeout(timer);
    global.fetch = originalFetch;
  }
});

test("rejected delta grant leaves the ciphertext cursor durable and reports degraded keys", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  const sync = await import("../web/src/lib/sync.ts");
  await sync.resetLocal();
  const grant = { sequence: 1, eventId: "bad-grant", aggregateId: "thread-1",
    type: "KEY_GRANT", sourceDeviceId: "phone", createdAt: 1, cryptoVersion: 1,
    encoding: "envelope.v1", schemaVersion: 1, ciphertext: Buffer.from("invalid").toString("base64") };
  global.fetch = async url => {
    const path = String(url);
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants"))
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    if (path.includes("/web/snapshot-v2")) return Response.json({ token: "grant-snapshot",
      replicaGeneration: "grant-generation", snapshotVersion: 1, baselineSequence: 0,
      expiresAt: Date.now() + 60_000, contactEvents: [], rows: [], nextCursor: null, hasMore: false });
    if (path.includes("/web/sync/ack")) return Response.json({ ok: true });
    const after = Number(new URL(path, "https://example.test").searchParams.get("after") || 0);
    return Response.json({ events: after ? [] : [grant], nextCursor: after || 1,
      hasMore: false, replicaGeneration: "grant-generation", snapshotVersion: 1 });
  };
  try {
    assert.equal(await sync.syncNow(), 1);
    assert.equal(await sync.getCursor(), 1);
    assert.equal(sync.getBrowserSyncStatus().state, "DEGRADED");
    assert.equal(sync.getBrowserSyncStatus().lastErrorPhase, "KEY_SYNC");
    const restarted = await import(`../web/src/lib/sync.ts?key-restart=${Date.now()}`);
    assert.equal(await restarted.getCursor(), 1);
  } finally { global.fetch = originalFetch; }
});

test("snapshot and key cursors remain separate for two browser identities", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const sync = await import("../web/src/lib/sync.ts");
  await sync.resetLocal();
  const db = await new Promise((resolve, reject) => {
    const open = indexedDB.open("gmweb-messages");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    const tx = db.transaction("meta", "readwrite");
    const meta = tx.objectStore("meta");
    meta.put(90, "sync_cursor");
    meta.put(80, "snapshot_baseline_v2");
    meta.put(true, "snapshot_complete_v2");
    meta.put(4, "account_keyring_v2_cursor:browser-a");
    meta.put(7, "key_grant_bootstrap_v2_cursor:browser-a");
    meta.put(2, "account_keyring_v2_cursor:browser-b");
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    assert.equal(await sync.getCursor(), 90);
    assert.deepEqual(await sync.getReplicationProgress("browser-a"), {
      snapshotComplete: true, snapshotBaseline: 80, keyringCursor: 4, grantCursor: 7,
    });
    assert.deepEqual(await sync.getReplicationProgress("browser-b"), {
      snapshotComplete: true, snapshotBaseline: 80, keyringCursor: 2, grantCursor: 0,
    });
    assert.equal(await sync.getCursor(), 90);
  } finally { db.close(); }
});
