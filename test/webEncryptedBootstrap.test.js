"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

test("PWA commits encrypted bootstrap before advancing to its high watermark", async () => {
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  const originalFetch = global.fetch;
  global.fetch = async url => {
    const path = String(url);
    if (path.includes("/linked-session")) return Response.json({ authenticated: true, deviceId: "web" });
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants")) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/web/bootstrap")) return Response.json({
      protocolVersion: 3, snapshotVersion: 1, highWatermark: 77, hasMore: false, nextCursor: null,
      conversations: [{ conversationId: "opaque-c", revision: 1, sortKey: 10,
        envelope: Buffer.from("opaque-cipher").toString("base64"), encoding: "envelope.v3",
        schemaVersion: 1, cryptoVersion: 3, lastServerSequence: 70 }],
    });
    if (path.includes("/sync?after=77")) return Response.json({ events: [], nextCursor: 77, hasMore: false });
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.resetLocal();
    await sync.syncStep();
    assert.equal(await sync.getCursor(), 77);
    const page = await sync.listConversations();
    assert.equal(page.items[0].aggregateId, "opaque-c");
    assert.equal(page.items[0].decodeState, "locked");
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("gmweb-messages");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction("encrypted_conversation_state", "readonly")
        .objectStore("encrypted_conversation_state").get("opaque-c");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.equal(stored.envelope.includes("opaque-cipher"), false);
    assert.equal(stored.envelope, Buffer.from("opaque-cipher").toString("base64"));
    db.close();
  } finally {
    global.fetch = originalFetch;
  }
});
