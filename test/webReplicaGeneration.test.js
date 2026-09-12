"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

test("replica generation mismatch reboots message state but preserves browser identity", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  let generation = "replica-generation-a";
  let highWatermark = 0;
  const originalFetch = global.fetch;
  global.fetch = async url => {
    const path = String(url);
    if (/\/linked-device\/(?:key-grants|keyring)/.test(path)) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/bootstrap")) return Response.json({
      protocolVersion: 3, replicaGeneration: generation, snapshotVersion: 1,
      minimumAvailableSequence: 1, highWatermark, contactEvents: [],
      conversations: [], nextCursor: null, hasMore: false,
    });
    if (path.includes("/sync?")) return Response.json({
      events: [], nextCursor: Number(new URL(path, "https://example.test").searchParams.get("after")),
      hasMore: false, replicaGeneration: generation, snapshotVersion: 1, minimumAvailableSequence: 1,
    });
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const keys = await import("../web/src/lib/deviceKeys.ts");
    const sync = await import("../web/src/lib/sync.ts");
    const before = await keys.getOrCreateDeviceKeys();
    await sync.syncStep();
    generation = "replica-generation-b";
    highWatermark = 5;
    await sync.syncNow();
    const after = await keys.getOrCreateDeviceKeys();
    assert.equal(await sync.getCursor(), 5);
    assert.equal(after.deviceId, before.deviceId);
    assert.equal(after.encryptionPublicKeyB64, before.encryptionPublicKeyB64);
  } finally {
    global.fetch = originalFetch;
  }
});
