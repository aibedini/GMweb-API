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
        { eventId: "e1", type: "MESSAGE_CREATED", payload: Buffer.from("a") },
        { eventId: "e2", type: "MESSAGE_STATUS_CHANGED", payload: Buffer.from("b") },
        { eventId: "e3", type: "THREAD_READ", payload: Buffer.from("c") },
      ],
    });
    assert.equal(res.accepted.length, 3);
    assert.deepEqual(res.accepted.map((a) => a.serverSequence), [1, 2, 3]);
  });

  test("duplicate event_uuid is skipped WITHOUT consuming a sequence", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "a", events: [{ eventId: "e1", type: "T", payload: Buffer.from("x") }] });
    const res = store.ingestBatch({
      accountId: "a",
      events: [
        { eventId: "e1", type: "T", payload: Buffer.from("x") }, // duplicate
        { eventId: "e2", type: "T", payload: Buffer.from("y") },
      ],
    });
    assert.equal(res.accepted.length, 2);
    assert.deepEqual(res.accepted.map(row => row.serverSequence), [1, 2]); // lost ACK is safely replayed
    assert.equal(res.duplicates, 1);
    assert.equal(store.count("a"), 2);
  });

  test("accounts are fully isolated — both sequences and reads", () => {
    const store = new EventStore(new Database(":memory:"));
    store.ingestBatch({ accountId: "a", events: [{ eventId: "x1", type: "T", payload: Buffer.from("1") }] });
    store.ingestBatch({ accountId: "b", events: [{ eventId: "x2", type: "T", payload: Buffer.from("2") }] });
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
      eventId: `e${i + 1}`, type: "MESSAGE_CREATED", payload: Buffer.from(`p${i}`),
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
    store.ingestBatch({ accountId: "a", events: [{ eventId: "e1", type: "MESSAGE_CREATED", payload }] });
    const ev = store.after("a", 0).events[0];
    assert.deepEqual(Buffer.from(ev.ciphertext, "base64"), payload);
    assert.equal(ev.encoding, "envelope.v1");
    assert.equal(ev.cryptoVersion, 0);
  });

  test("MESSAGE_RECEIVED and MESSAGE_SENT are accepted (opaque relay, no type allowlist)", () => {
    const store = new EventStore(new Database(":memory:"));
    const res = store.ingestBatch({
      accountId: "acc1",
      sourceDeviceId: "agent-1",
      events: [
        { eventId: "in-1", type: "MESSAGE_RECEIVED", conversationId: "thread-1", payload: Buffer.from("incoming"), cryptoVersion: 1 },
        { eventId: "out-1", type: "MESSAGE_SENT", conversationId: "thread-1", payload: Buffer.from("outgoing"), cryptoVersion: 1 },
      ],
    });
    assert.equal(res.accepted.length, 2);
    assert.equal(res.duplicates, 0);
    const page = store.after("acc1", 0);
    assert.deepEqual(page.events.map((e) => e.type), ["MESSAGE_RECEIVED", "MESSAGE_SENT"]);
    // Re-ingesting the exact same IDs is a duplicate: no new sequence consumed.
    const replay = store.ingestBatch({
      accountId: "acc1",
      sourceDeviceId: "agent-1",
      events: [
        { eventId: "in-1", type: "MESSAGE_RECEIVED", conversationId: "thread-1", payload: Buffer.from("incoming"), cryptoVersion: 1 },
        { eventId: "out-1", type: "MESSAGE_SENT", conversationId: "thread-1", payload: Buffer.from("outgoing"), cryptoVersion: 1 },
      ],
    });
    assert.equal(replay.duplicates, 2);
    assert.equal(store.count("acc1"), 2);
  });

  test("contacts snapshot, change, and grant events are accepted as opaque data", () => {
    const store = new EventStore(new Database(":memory:"));
    const result = store.ingestBatch({ accountId: "contacts", sourceDeviceId: "phone", events: [
      { eventId: "contacts-1", type: "CONTACTS_SNAPSHOT", conversationId: "contacts", payload: Buffer.from("cipher-1"), cryptoVersion: 1 },
      { eventId: "contacts-2", type: "CONTACTS_CHANGED", conversationId: "contacts", payload: Buffer.from("cipher-2"), cryptoVersion: 1 },
      { eventId: "contacts-key", type: "CONTACTS_KEY_GRANT", conversationId: "contacts", payload: Buffer.from("grant"), cryptoVersion: 1 },
    ] });
    assert.equal(result.accepted.length, 3);
    assert.deepEqual(store.after("contacts", 0, 10).events.map(event => event.type),
      ["CONTACTS_SNAPSHOT", "CONTACTS_CHANGED", "CONTACTS_KEY_GRANT"]);
  });

  test("empty batch is a no-op", () => {
    const store = new EventStore(new Database(":memory:"));
    const res = store.ingestBatch({ accountId: "a", events: [] });
    assert.deepEqual(res.accepted, []);
  });
});
