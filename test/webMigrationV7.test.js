"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test("v7 purges legacy plaintext state even when encrypted bootstrap is empty", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const legacy = indexedDB.open("gmweb-messages", 6);
  legacy.onupgradeneeded = () => {
    const db = legacy.result;
    const events = db.createObjectStore("events", { keyPath: "sequence" });
    events.createIndex("by_aggregate", "aggregateId");
    db.createObjectStore("meta");
    db.createObjectStore("contacts", { keyPath: "normalizedPhone" });
    const conversations = db.createObjectStore("conversations", { keyPath: "aggregateId" });
    conversations.createIndex("by_last_at", ["lastAt", "aggregateId"]);
  };
  const legacyDb = await requestResult(legacy);
  const seed = legacyDb.transaction(["events", "meta", "contacts", "conversations"], "readwrite");
  seed.objectStore("events").put({
    sequence: 1, eventId: "plaintext", type: "MESSAGE_CREATED", aggregateId: "thread",
    cryptoVersion: 0, encoding: "envelope.v1", schemaVersion: 1, ciphertext: "cGxhaW50ZXh0",
  });
  seed.objectStore("events").put({
    sequence: 2, eventId: "grant", type: "KEY_GRANT", aggregateId: "thread",
    cryptoVersion: 1, encoding: "envelope.v1", schemaVersion: 1, ciphertext: "Z3JhbnQ=",
  });
  seed.objectStore("meta").put(2, "sync_cursor");
  seed.objectStore("contacts").put({ normalizedPhone: "+98999", displayName: "Legacy Name" });
  seed.objectStore("conversations").put({
    aggregateId: "thread", title: "+98999", preview: "legacy body", lastAt: 1,
  });
  await new Promise((resolve, reject) => {
    seed.oncomplete = resolve;
    seed.onerror = () => reject(seed.error);
  });
  legacyDb.close();

  const originalFetch = global.fetch;
  global.fetch = async url => {
    const path = String(url);
    if (/\/linked-device\/(?:key-grants|keyring)/.test(path)) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/bootstrap")) return Response.json({
      protocolVersion: 3, replicaGeneration: "empty-bootstrap-generation", snapshotVersion: 1,
      minimumAvailableSequence: 1, highWatermark: 9, contactEvents: [],
      conversations: [], nextCursor: null, hasMore: false,
    });
    if (path.includes("/sync?after=9")) return Response.json({
      events: [], nextCursor: 9, hasMore: false,
      replicaGeneration: "empty-bootstrap-generation", snapshotVersion: 1, minimumAvailableSequence: 1,
    });
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.syncStep();
    const db = await requestResult(indexedDB.open("gmweb-messages"));
    assert.equal(await requestResult(db.transaction("events").objectStore("events").get(1)), undefined);
    assert.equal((await requestResult(db.transaction("events").objectStore("events").get(2))).eventId, "grant");
    assert.equal(await requestResult(db.transaction("conversations").objectStore("conversations").count()), 0);
    assert.equal(await requestResult(db.transaction("contacts").objectStore("contacts").count()), 0);
    assert.equal(await requestResult(db.transaction("meta").objectStore("meta").get("sync_cursor")), 9);
    assert.equal(await requestResult(db.transaction("meta").objectStore("meta").get("replica_migration_version")), 7);
    db.close();
  } finally {
    global.fetch = originalFetch;
  }
});
