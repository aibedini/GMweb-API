"use strict";
// PWA conversation-projection tests (pure projection logic — no IndexedDB).
// Store-level pagination over 100+ conversations is exercised in the browser
// (fake-indexeddb store tests hang under this repo's node runner), while the
// projection store itself is wired into every sync-page commit.
const test = require("node:test");
const assert = require("node:assert/strict");

function envelope(payload) {
  return Buffer.from(JSON.stringify({
    cryptoVersion: 0, encoding: "application/json",
    ciphertextB64: Buffer.from(JSON.stringify(payload)).toString("base64"),
  })).toString("base64");
}

function event(sequence, type, payload, aggregateId) {
  return {
    sequence, eventId: `evt-${sequence}`, type, aggregateId,
    sourceDeviceId: "phone", createdAt: sequence * 1000,
    encoding: "envelope.v3", schemaVersion: 1, cryptoVersion: 3,
    ciphertext: Buffer.from("ciphertext").toString("base64"),
    decryption: { state: "decrypted", payload },
  };
}

test("locked ciphertext stays visible as a locked projection until a grant arrives", async () => {
  const inbox = await import("../web/src/lib/inbox.ts");
  const encrypted = {
    ...event(1, "MESSAGE_CREATED", { body: "ignore" }, "locked-thread"),
    cryptoVersion: 1, ciphertext: Buffer.from("no-plaintext").toString("base64"), decryption: undefined,
  };
  const row = inbox.conversationProjectionFromEvents([encrypted], "locked-thread");
  assert.ok(row);
  assert.equal(row.decodeState, "locked");
  assert.equal(row.title, "Encrypted message");
});

test("fully deleted conversations produce no projection row", async () => {
  const inbox = await import("../web/src/lib/inbox.ts");
  const rows = [
    event(1, "MESSAGE_CREATED", { messageId: "gone", body: "hi", dateMs: 1, direction: "in" }, "del-thread"),
    event(2, "MESSAGE_DELETED", { messageId: "gone" }, "del-thread"),
  ];
  assert.equal(inbox.conversationProjectionFromEvents(rows, "del-thread"), null);
});

test("projection carries the latest message identity and decode state", async () => {
  const inbox = await import("../web/src/lib/inbox.ts");
  const rows = [
    event(1, "MESSAGE_CREATED", { messageId: "m1", body: "first", dateMs: 1, direction: "in" }, "t"),
    event(2, "MESSAGE_CREATED", { messageId: "m2", body: "second", dateMs: 2, direction: "out" }, "t"),
    event(3, "MESSAGE_STATUS_CHANGED", { messageId: "m2", status: 2 }, "t"),
  ];
  const row = inbox.conversationProjectionFromEvents(rows, "t");
  assert.ok(row);
  assert.equal(row.lastMessageId, "m2");
  assert.equal(row.preview, "second");
  assert.equal(row.decodeState, "ready");
});

