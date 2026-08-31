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
    assert.equal(res.accepted.length, 1);
    assert.equal(res.accepted[0].serverSequence, 2); // NOT 3 — dedupe first
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

  test("empty batch is a no-op", () => {
    const store = new EventStore(new Database(":memory:"));
    const res = store.ingestBatch({ accountId: "a", events: [] });
    assert.deepEqual(res.accepted, []);
  });
});
