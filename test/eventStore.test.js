"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { EventStore } = require("../src/eventStore");

describe("EventStore — per-account sequencing (LOCK 10) + partial ACK", () => {
  test("sequences are strictly monotonic per account within a batch", () => {
    const store = new EventStore(new Database(":memory:"));
    const res = store.ingestBatch({
      accountId: "acc1",
      sourceDeviceId: "agent-1",
      events: [
        { eventId: "e1", type: "MESSAGE_CREATED", payload: Buffer.from("a"), cryptoVersion: 3 },
        { eventId: "e2", type: "MESSAGE_STATUS_CHANGED", payload: Buffer.from("b"), cryptoVersion: 3 },
        { eventId: "e3", type: "THREAD_READ", payload: Buffer.from("c"), cryptoVersion: 3 },
      ],
    });
    assert.equal(res.accepted.length, 3);
    assert.deepEqual(res.accepted.map((a) => a.serverSequence), [1, 2, 3]);
  });

  test("duplicate event_uuid is skipped WITHOUT consuming a sequence", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "a", events: [{ eventId: "e1", type: "DEVICE_STATUS_CHANGED", payload: Buffer.from("x"), cryptoVersion: 1 }] });
    const res = store.ingestBatch({
      accountId: "a",
      events: [
        { eventId: "e1", type: "DEVICE_STATUS_CHANGED", payload: Buffer.from("x"), cryptoVersion: 1 }, // duplicate
        { eventId: "e2", type: "DEVICE_STATUS_CHANGED", payload: Buffer.from("y"), cryptoVersion: 1 },
      ],
    });
    assert.equal(res.accepted.length, 2);
    assert.deepEqual(res.accepted.map(row => row.serverSequence), [1, 2]); // lost ACK is safely replayed
    assert.equal(res.duplicates, 1);
    assert.equal(store.count("a"), 2);
  });

  test("accounts are fully isolated — both sequences and reads", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "a", events: [{ eventId: "x1", type: "DEVICE_STATUS_CHANGED", payload: Buffer.from("1"), cryptoVersion: 1 }] });
    store.ingestBatch({ accountId: "b", events: [{ eventId: "x2", type: "DEVICE_STATUS_CHANGED", payload: Buffer.from("2"), cryptoVersion: 1 }] });
    // b's sequence restarts at 1 — no cross-tenant visibility (LOCK 10)
    assert.equal(store.count("a"), 1);
    assert.equal(store.count("b"), 1);
    const forA = store.after("a", 0);
    assert.equal(forA.events.length, 1);
    assert.notEqual(forA.events[0].eventId, "x2");
  });

  test("cursor sync paginates with hasMore + nextCursor", () => {
    const store = new EventStore(new Database(":memory:"));
    const events = Array.from({ length: 7 }, (_, i) => ({
      eventId: `e${i + 1}`, type: "MESSAGE_CREATED", payload: Buffer.from(`p${i}`), cryptoVersion: 3,
    }));
    store.ingestBatch({ accountId: "acc", events });
    const page1 = store.after("acc", 0, 5);
    assert.equal(page1.events.length, 5);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.nextCursor, 5);
    const page2 = store.after("acc", page1.nextCursor, 5);
    assert.equal(page2.events.length, 2);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.nextCursor, 7);
  });

  test("ciphertext round-trips as base64 (opaque envelope, Phase 7 ready)", () => {
    const store = new EventStore(new Database(":memory:"));
    const payload = Buffer.from(JSON.stringify({ body: "سلام" }));
    store.ingestBatch({ accountId: "a", events: [{ eventId: "e1", type: "MESSAGE_CREATED", payload, encoding: "envelope.v3", cryptoVersion: 3 }] });
    const ev = store.after("a", 0).events[0];
    assert.deepEqual(Buffer.from(ev.ciphertext, "base64"), payload);
    assert.equal(ev.encoding, "envelope.v3");
    assert.equal(ev.cryptoVersion, 3);
  });

  test("unknown data-plane event types are rejected", () => {
    const store = new EventStore(new Database(":memory:"));
    assert.throws(() => store.ingestBatch({
      accountId: "acc1",
      sourceDeviceId: "agent-1",
      events: [
        { eventId: "in-1", type: "MESSAGE_RECEIVED", conversationId: "thread-1", payload: Buffer.from("incoming"), cryptoVersion: 1 },
      ],
    }), error => error.code === "unknown_event_type");
    assert.equal(store.count("acc1"), 0);
  });

  test("contacts snapshot, change, and grant events are accepted as opaque data", () => {
    const store = new EventStore(new Database(":memory:"));
    const result = store.ingestBatch({ accountId: "contacts", sourceDeviceId: "phone", events: [
      { eventId: "contacts-1", type: "CONTACTS_SNAPSHOT", conversationId: "contacts", payload: Buffer.from("cipher-1"), cryptoVersion: 1 },
      { eventId: "contacts-2", type: "CONTACTS_CHANGED", conversationId: "contacts", payload: Buffer.from("cipher-2"), cryptoVersion: 1 },
      { eventId: "contacts-key", type: "CONTACTS_KEY_GRANT", conversationId: "contacts",
        payload: Buffer.from(JSON.stringify({ deviceId: "web" })), cryptoVersion: 1 },
    ] });
    assert.equal(result.accepted.length, 3);
    assert.deepEqual(store.after("contacts", 0, 10).events.map(event => event.type),
      ["CONTACTS_SNAPSHOT", "CONTACTS_CHANGED", "CONTACTS_KEY_GRANT"]);
    assert.deepEqual(store.deviceGrantsAfter("contacts", "web", 0, 10).events.map(event => event.type),
      ["CONTACTS_KEY_GRANT"]);
  });

  test("grant bootstrap pages skip message traffic without advancing the raw sync cursor", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "grants", sourceDeviceId: "phone", events: [
      { eventId: "m1", type: "MESSAGE_CREATED", conversationId: "a", payload: Buffer.from("m"), cryptoVersion: 3 },
      { eventId: "g1", type: "KEY_GRANT", conversationId: "a", payload: Buffer.from(JSON.stringify({ deviceId: "web" })), cryptoVersion: 1 },
      { eventId: "m2", type: "MESSAGE_CREATED", conversationId: "b", payload: Buffer.from("m"), cryptoVersion: 3 },
      { eventId: "other", type: "KEY_GRANT", conversationId: "a", payload: Buffer.from(JSON.stringify({ deviceId: "other" })), cryptoVersion: 1 },
      { eventId: "g2", type: "CONTACTS_KEY_GRANT", conversationId: "contacts", payload: Buffer.from(JSON.stringify({ deviceId: "web" })), cryptoVersion: 1 },
    ] });
    const first = store.deviceGrantsAfter("grants", "web", 0, 1);
    assert.deepEqual(first.events.map(event => [event.sequence, event.type]), [[2, "KEY_GRANT"]]);
    assert.equal(first.nextCursor, 2);
    assert.equal(first.hasMore, true);
    const second = store.deviceGrantsAfter("grants", "web", first.nextCursor, 1);
    assert.deepEqual(second.events.map(event => [event.sequence, event.type]), [[5, "CONTACTS_KEY_GRANT"]]);
    assert.equal(second.hasMore, false);
    assert.equal(store.after("grants", 0, 1).events[0].sequence, 1);
  });

  test("v2/v3 keys are bounded, device-filtered, and independent of message cursor", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "keyring", sourceDeviceId: "phone", events: [
      { eventId: "m1", type: "MESSAGE_CREATED", conversationId: "a", payload: Buffer.from("cipher"), cryptoVersion: 2 },
      { eventId: "k1", type: "KEYRING_ENTRY", conversationId: "__account_keyring__",
        payload: Buffer.from(JSON.stringify({ deviceId: "web-a", keyId: "messages" })), encoding: "envelope.v2", cryptoVersion: 2 },
      { eventId: "k2", type: "KEYRING_ENTRY", conversationId: "__account_keyring__",
        payload: Buffer.from(JSON.stringify({ deviceId: "web-b", keyId: "messages" })), encoding: "envelope.v2", cryptoVersion: 2 },
      { eventId: "h1", type: "HISTORY_KEY_GRANT", conversationId: "__history_master__",
        payload: Buffer.from(JSON.stringify({ deviceId: "web-a", keyId: "history" })), encoding: "envelope.v3", cryptoVersion: 3 },
    ] });
    const page = store.deviceKeyring("keyring", "web-a");
    assert.deepEqual(page.events.map(event => event.eventId), ["k1", "h1"]);
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, 4);
    assert.equal(store.after("keyring", 0, 1).events[0].eventId, "m1");
  });

  test("empty batch is a no-op", () => {
    const store = new EventStore(new Database(":memory:"));
    const res = store.ingestBatch({ accountId: "a", events: [] });
    assert.deepEqual(res.accepted, []);
  });

  test("encrypted current state rejects stale history and pages by keyset", () => {
    const store = new EventStore(new Database(":memory:"));
    const event = (eventId, messageId, revision, sortKey, payload) => ({
      eventId, messageId, revision, sortKey, type: "MESSAGE_CREATED",
      conversationId: "opaque-conversation", payload: Buffer.from(payload), cryptoVersion: 3,
    });
    store.ingestBatch({ accountId: "a", events: [
      event("new", "message-1", 20, 200, "new-cipher"),
      event("stale", "message-1", 1, 100, "stale-cipher"),
      event("second", "message-2", 1, 150, "second-cipher"),
    ] });
    const page = store.messages("a", "opaque-conversation", null, 1);
    assert.equal(page.messages.length, 1);
    assert.equal(page.hasMore, true);
    assert.equal(Buffer.from(page.messages[0].envelope, "base64").toString(), "new-cipher");
    assert.equal(page.messages[0].revision, 20);
    const older = store.messages("a", "opaque-conversation", page.nextCursor, 1);
    assert.equal(older.messages[0].messageId, "message-2");
  });

  test("bootstrap captures a high watermark and encrypted conversation page", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "a", events: [{
      eventId: "conversation-1", type: "CONVERSATION_UPSERTED",
      conversationId: "opaque-1", revision: 7, sortKey: 99,
      payload: Buffer.from("encrypted-summary"), cryptoVersion: 3,
    }] });
    const bootstrap = store.bootstrap("a");
    assert.equal(bootstrap.protocolVersion, 3);
    assert.equal(bootstrap.highWatermark, 1);
    assert.equal(bootstrap.conversations[0].conversationId, "opaque-1");
    assert.equal(Buffer.from(bootstrap.conversations[0].envelope, "base64").toString(), "encrypted-summary");
  });

  test("compaction keeps key events and rebuildable contact history", () => {
    const store = new EventStore(new Database(":memory:"));
    const events = [
      { eventId: "contacts-snapshot", type: "CONTACTS_SNAPSHOT", payload: Buffer.from("snapshot"), cryptoVersion: 1, createdAt: 1 },
      ...Array.from({ length: 8 }, (_, index) => ({
        eventId: `message-${index}`, type: "MESSAGE_CREATED", conversationId: "thread",
        payload: Buffer.from(`cipher-${index}`), cryptoVersion: 3, createdAt: 1,
      })),
      { eventId: "contacts-change", type: "CONTACTS_CHANGED", payload: Buffer.from("change"), cryptoVersion: 1, createdAt: 1 },
      { eventId: "key", type: "KEY_GRANT", payload: Buffer.from(JSON.stringify({ deviceId: "web" })), cryptoVersion: 1, createdAt: 1 },
    ];
    store.ingestBatch({ accountId: "a", events });
    const metadata = store.replicaMetadata("a");
    store.acknowledgeClient("a", "web", 11, metadata.replicaGeneration, metadata.snapshotVersion);

    const report = store.compact("a", { retainEvents: 2, retainMs: 0, limit: 100 });
    assert.equal(report.rowsRemoved, 8);
    assert.equal(report.minimumAvailableSequence, 10);
    assert.deepEqual(store.after("a", 0, 20).events.map(event => event.eventId),
      ["contacts-snapshot", "contacts-change", "key"]);
    assert.deepEqual(store.bootstrap("a").contactEvents.map(event => event.eventId),
      ["contacts-snapshot", "contacts-change"]);
    assert.deepEqual(store.deviceGrantsAfter("a", "web", 0).events.map(event => event.eventId), ["key"]);
  });

  test("newer conversation tombstone cannot be resurrected by stale snapshot", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "a", events: [
      { eventId: "delete", type: "CONVERSATION_DELETED", conversationId: "c",
        revision: 10, sortKey: 10, payload: Buffer.from("delete"), cryptoVersion: 3 },
      { eventId: "old", type: "CONVERSATION_UPSERTED", conversationId: "c",
        revision: 1, sortKey: 1, payload: Buffer.from("old"), cryptoVersion: 3 },
    ] });
    const row = store.conversations("a", null, 1).conversations[0];
    assert.equal(row.tombstone, true);
    assert.equal(row.revision, 10);
  });

  test("diagnostic stats expose only aggregate pipeline counts per account and source device", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "account", sourceDeviceId: "phone-a", events: [
      { eventId: "m1", type: "MESSAGE_CREATED", conversationId: "thread-a", payload: Buffer.from("secret-a"), cryptoVersion: 1 },
      { eventId: "k1", type: "KEY_GRANT", payload: Buffer.from("secret-b"), cryptoVersion: 1 },
    ] });
    assert.throws(() => store.ingestBatch({ accountId: "account", sourceDeviceId: "phone-b", events: [
      { eventId: "u1", type: "MESSAGE_UPDATED", payload: Buffer.from("secret-c"), cryptoVersion: 0 },
    ] }), error => error.code === "encrypted_payload_required");

    const stats = store.diagnosticStats("account", "phone-a");
    assert.deepEqual(stats.account, {
      total: 2,
      messageCreated: 1,
      messageUpdated: 0,
      keyGrant: 1,
      byCryptoVersion: [{ value: 1, count: 2 }],
      maxSequence: 2,
    });
    assert.deepEqual(stats.sourceDevice, {
      total: 2,
      messageCreated: 1,
      messageUpdated: 0,
      keyGrant: 1,
      byCryptoVersion: [{ value: 1, count: 2 }],
      maxSequence: 2,
    });
    assert.equal(JSON.stringify(stats).includes("secret"), false);
    const linked = store.syncDiagnostics("account");
    assert.equal(linked.total, 2);
    assert.equal(linked.maxSequence, 2);
    assert.equal(linked.distinctAggregateCount, 1);
    assert.equal(linked.nullAggregateCount, 1);
    assert.deepEqual(linked.countsByType, [
      { type: "KEY_GRANT", count: 1 },
      { type: "MESSAGE_CREATED", count: 1 },
    ]);
    assert.equal(JSON.stringify(linked).includes("secret"), false);
    assert.equal(JSON.stringify(linked).includes("thread-a"), false);
  });
});
