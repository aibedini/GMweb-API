"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");
const { EventStore } = require("../src/eventStore");

test("encrypted replica has no plaintext message columns or canary values", () => {
  const db = new Database(":memory:");
  const store = new EventStore(db);
  const canaryPhone = "+989991234567";
  const canaryBody = "SECURITY_CANARY_SMS_7f912c";
  store.ingestBatch({ accountId: "a", events: [{
    eventId: "opaque-event", type: "MESSAGE_CREATED", messageId: "opaque-message",
    conversationId: "opaque-conversation", revision: 1, sortKey: 1,
    payload: Buffer.from("opaque-authenticated-ciphertext"), cryptoVersion: 3,
  }] });
  const columns = db.prepare("PRAGMA table_info(encrypted_message_state)").all().map(row => row.name);
  assert.equal(columns.includes("body"), false);
  assert.equal(columns.includes("address"), false);
  const stored = JSON.stringify(db.prepare(`
    SELECT account_id, message_id, conversation_id, revision, sort_key,
           hex(envelope) envelope FROM encrypted_message_state`).all());
  const response = JSON.stringify(store.messages("a", "opaque-conversation"));
  for (const sentinel of [canaryPhone, canaryBody]) {
    assert.equal(stored.includes(sentinel), false);
    assert.equal(response.includes(sentinel), false);
  }
});
