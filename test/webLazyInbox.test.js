"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { indexedDB, IDBKeyRange } = require("fake-indexeddb");

const envelope = Buffer.from("opaque-ciphertext").toString("base64");
const conversation = (index) => ({ conversationId: `conversation-${index}`, revision: 1,
  sortKey: 200 - index, tombstone: false, envelope, encoding: "envelope.v3",
  schemaVersion: 1, cryptoVersion: 3, lastServerSequence: index + 1 });
const message = (index, revision = 1) => ({ messageId: `message-${index}`,
  conversationId: "conversation-0", type: "MESSAGE_CREATED", revision,
  sortKey: 100 - index, tombstone: false, envelope, encoding: "envelope.v3",
  schemaVersion: 1, cryptoVersion: 3, lastServerSequence: 1000 + revision });
const cursor = (sortKey, id) => Buffer.from(JSON.stringify([sortKey, id])).toString("base64url");

test("current-state projections preserve the AEAD-bound event identity", async () => {
  const { conversationStateEvent, messageStateEvent } = await import("../web/src/lib/sync/projection-engine.ts");
  const encrypted = (eventId, type) => Buffer.from(JSON.stringify({ v: 3, kind: "message",
    eventId, type, conversationId: "conversation-0", ciphertext: "opaque" })).toString("base64");
  assert.equal(conversationStateEvent({ ...conversation(0), envelope: encrypted("original-conversation-event", "CONVERSATION_UPSERTED") }).eventId,
    "original-conversation-event");
  assert.equal(messageStateEvent({ ...message(0), envelope: encrypted("original-message-event", "MESSAGE_CREATED") }).eventId,
    "original-message-event");
});

test("lazy inbox downloads summaries first and only the opened thread's bounded pages", async () => {
  const originalFetch = global.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(global, "navigator");
  global.indexedDB = indexedDB;
  global.IDBKeyRange = IDBKeyRange;
  Object.defineProperty(global, "navigator", { configurable: true, value: { onLine: true } });
  const calls = [];
  let newestRevision = 1;
  let highWatermark = 1126;
  global.fetch = async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.includes("/linked-device/keyring") || path.includes("/linked-device/key-grants")) {
      return Response.json({ events: [], nextCursor: 0, hasMore: false });
    }
    if (path.includes("/linked-device/contacts/events")) {
      assert.equal(new URL(path, "https://example.test").searchParams.get("limit"), "50");
      return Response.json({ events: [], nextBeforeSequence: null, hasMore: false });
    }
    if (path.includes("/web/bootstrap")) {
      const query = new URL(path, "https://example.test").searchParams;
      if (query.get("includeContacts") === "true") {
        assert.equal(query.get("limit"), "1");
        return Response.json({ protocolVersion: 3, replicaGeneration: "lazy-test-generation",
          snapshotVersion: 1, highWatermark, contactEvents: [],
          conversations: [conversation(0)], hasMore: true,
          nextCursor: cursor(200, "conversation-0") });
      }
      assert.equal(query.get("includeContacts"), "false");
      return Response.json({ protocolVersion: 3, replicaGeneration: "lazy-test-generation",
        snapshotVersion: 1, highWatermark, contactEvents: [],
        conversations: Array.from({ length: 100 }, (_, index) => conversation(index)),
        hasMore: true, nextCursor: cursor(101, "conversation-99") });
    }
    if (path.includes("/web/conversations/conversation-0/messages")) {
      const query = new URL(path, "https://example.test").searchParams;
      const limit = Number(query.get("limit"));
      if (query.has("before")) {
        assert.equal(limit, 20);
        return Response.json({ messages: Array.from({ length: 20 }, (_, index) => message(index + 10)),
          hasMore: false, nextCursor: null });
      }
      assert.equal(limit, 10);
      return Response.json({ messages: Array.from({ length: 10 }, (_, index) =>
        message(index, index === 0 ? newestRevision : 1)),
        hasMore: true, nextCursor: cursor(91, "message-9") });
    }
    if (path.includes("/web/conversations?")) {
      const query = new URL(path, "https://example.test").searchParams;
      assert.equal(query.get("limit"), "100");
      if (query.has("cursor")) {
        return Response.json({ conversations: Array.from({ length: 30 }, (_, index) => conversation(index + 100)),
          hasMore: false, nextCursor: null });
      }
      return Response.json({ conversations: Array.from({ length: 100 }, (_, index) => conversation(index)),
        hasMore: true, nextCursor: cursor(101, "conversation-99") });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  try {
    const sync = await import("../web/src/lib/sync.ts");
    await sync.resetLocal();
    assert.equal(await sync.syncVisibleInbox(), 1);
    assert.equal(await sync.getCursor(), 1126);
    assert.equal(calls.some(path => path.includes("/snapshot-v2")), false);
    assert.equal(calls.some(path => path.includes("/web/sync/ack")), false);
    assert.equal(calls.some(path => path.includes("/messages")), false);
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("gmweb-messages");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const count = () => new Promise((resolve, reject) => {
      const request = db.transaction("encrypted_message_state", "readonly")
        .objectStore("encrypted_message_state").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.equal(await count(), 0);
    const inbox = await sync.listConversations({ limit: 100 });
    assert.equal(inbox.items.length, 100);
    assert.equal((await sync.listConversations({ limit: 100, before: inbox.next })).items.length, 30);
    assert.equal(calls.some(path => path.includes("includeContacts=true")), false);
    await sync.loadContactsOnDemand();
    assert.equal(calls.some(path => path.includes("/linked-device/contacts/events")), true);
    const first = await sync.listAggregateEventsPage("conversation-0", { limit: 10 });
    assert.equal(first.items.length, 10);
    assert.equal(await count(), 10);
    const older = await sync.listAggregateEventsPage("conversation-0", { limit: 20, beforeState: first.next });
    assert.equal(older.items.length, 20);
    assert.equal(await count(), 30);
    newestRevision = 2;
    await sync.listAggregateEventsPage("conversation-0", { limit: 10 });
    newestRevision = 1; // a delayed, older response must not replace the newer cached row
    const stale = await sync.listAggregateEventsPage("conversation-0", { limit: 10 });
    assert.equal(stale.items[0].revision, 2);
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction("encrypted_message_state", "readonly")
        .objectStore("encrypted_message_state").get("message-0");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    assert.equal(stored.revision, 2);
    global.navigator.onLine = false;
    const offlineCalls = calls.length;
    assert.equal((await sync.listConversations({ limit: 100 })).items.length, 100);
    assert.equal((await sync.listAggregateEventsPage("conversation-0", { limit: 10 })).items.length, 10);
    assert.equal(calls.length, offlineCalls);
    global.navigator.onLine = true;
    assert.equal(await sync.syncVisibleInbox(), 0);
    highWatermark += 1;
    assert.equal(await sync.syncVisibleInbox(), 1);
    assert.equal(await sync.getCursor(), highWatermark);
    assert.equal(calls.some(path => path.includes("/snapshot-v2")), false);
    db.close();
  } finally {
    global.fetch = originalFetch;
    if (originalNavigator) Object.defineProperty(global, "navigator", originalNavigator);
    else delete global.navigator;
  }
});
