"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { EventStore } = require("../src/eventStore");
const { traceEvent } = require("../scripts/trace-replica-event");

test("event trace distinguishes retained raw event from snapshot state without exposing ciphertext", () => {
  const db = new Database(":memory:");
  try {
    const store = new EventStore(db);
    store.ingestBatch({ accountId: "a", sourceDeviceId: "phone-secret", events: [{
      eventId: "legacy", type: "MESSAGE_CREATED", conversationId: "thread",
      payload: Buffer.from("private ciphertext"), cryptoVersion: 3,
    }] });
    const found = traceEvent(db, "a", "legacy");
    assert.equal(found.serverSequence, 1);
    assert.equal(found.snapshotVisibility, "NOT_CURRENT_STATE");
    assert.equal(found.rawReplicaVisibleFromCursor, true);
    assert.equal(found.keyRef, "NOT_INDEXED_SERVER_SIDE");
    assert.equal(JSON.stringify(found).includes("private ciphertext"), false);
    assert.equal(JSON.stringify(found).includes("phone-secret"), false);
    assert.equal(traceEvent(db, "other", "legacy").presentInRetainedEvents, false);
    assert.equal(traceEvent(db, "a", "missing").receipt, "UNKNOWN_AFTER_COMPACTION");
  } finally { db.close(); }
});
