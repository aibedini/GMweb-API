// Conversation metadata repair: an existing "Unknown conversation" row must be
// repairable from a newer decrypted conversation metadata event, WITHOUT Android
// resending historical SMS.
import test from "node:test";
import assert from "node:assert/strict";
import { applyConversationMetadata } from "../web/src/lib/inbox.ts";
import { classifySender } from "../web/src/lib/senderIdentity.ts";

const unknownRow = (over = {}) => ({ aggregateId: "conv-1", title: "Unknown conversation",
  subtitle: undefined, preview: "", lastAt: 0, read: true, unreadCount: 0,
  lastMessageId: "conv-1", lastSequence: 5, decodeState: "ready", ...over });

test("repaired metadata turns Unknown into the real branded sender", () => {
  const repaired = applyConversationMetadata(unknownRow(),
    { sequence: 10, rawAddress: "PARSIANBANK", androidThreadId: 552 });
  assert.equal(repaired.title, "PARSIANBANK");
  assert.equal(repaired.subtitle, "PARSIANBANK");
  assert.equal(repaired.androidThreadId, 552);
  assert.equal(classifySender(repaired.rawAddress).kind, "ALPHANUMERIC");
});

test("short code and mixed alphanumeric stay exactly as published", () => {
  assert.equal(applyConversationMetadata(unknownRow(), { sequence: 1, rawAddress: "3000" }).title, "3000");
  assert.equal(applyConversationMetadata(unknownRow(), { sequence: 1, rawAddress: "Ssh3-652" }).title, "Ssh3-652");
  assert.notEqual(applyConversationMetadata(unknownRow(), { sequence: 1, rawAddress: "Ssh3-652" }).title, "3652");
});

test("a real contact name still outranks the number for a PHONE sender", () => {
  const repaired = applyConversationMetadata(unknownRow(), { sequence: 1,
    rawAddress: "+989121234567", contactName: "Ali" });
  assert.equal(repaired.title, "Ali");
  assert.equal(repaired.subtitle, "+989121234567");
});

test("a contact name never overrides an alphanumeric sender", () => {
  const repaired = applyConversationMetadata(unknownRow(), { sequence: 1,
    rawAddress: "PARSIANBANK", contactName: "Bank Contact" });
  assert.equal(repaired.title, "PARSIANBANK", "branded sender is its own identity");
});

test("older metadata cannot overwrite newer metadata", () => {
  const newer = applyConversationMetadata(unknownRow(),
    { sequence: 10, rawAddress: "PARSIANBANK", androidThreadId: 552 });
  const stale = applyConversationMetadata(newer, { sequence: 4, rawAddress: "ResalatBank", androidThreadId: 999 });
  assert.deepEqual(stale, newer, "a lower sequence is ignored entirely");
  // Equal sequence is also ignored (idempotent replay).
  assert.deepEqual(applyConversationMetadata(newer, { sequence: 10, rawAddress: "Other" }), newer);
});

test("partial metadata never erases known values (old Android compatibility)", () => {
  const base = applyConversationMetadata(unknownRow(),
    { sequence: 10, rawAddress: "PARSIANBANK", androidThreadId: 552 });
  // An event carrying only a thread id must not blank the title.
  const partial = applyConversationMetadata(base, { sequence: 11, androidThreadId: 553 });
  assert.equal(partial.title, "PARSIANBANK");
  assert.equal(partial.rawAddress, "PARSIANBANK");
  assert.equal(partial.androidThreadId, 553);
  // No metadata at all is a no-op.
  assert.deepEqual(applyConversationMetadata(base, null), base);
  assert.deepEqual(applyConversationMetadata(base, undefined), base);
});

test("an old event with no raw address stays backward compatible", () => {
  const row = unknownRow({ title: "Conversation abc1234" });
  const repaired = applyConversationMetadata(row, { sequence: 1 });
  // Content is untouched: no invented title, no invented thread id.
  assert.equal(repaired.title, "Conversation abc1234");
  assert.equal(repaired.subtitle, undefined);
  assert.equal(repaired.androidThreadId, undefined);
  // The sequence watermark still advances, so an OLDER metadata event cannot
  // later overwrite this row.
  assert.equal(repaired.metadataSequence, 1);
  assert.deepEqual(applyConversationMetadata(repaired, { sequence: 0, rawAddress: "OTHER" }), repaired);
});

test("a blank/whitespace address does not become a title", () => {
  const repaired = applyConversationMetadata(unknownRow(), { sequence: 1, rawAddress: "   " });
  assert.equal(repaired.title, "Unknown conversation");
  assert.equal(classifySender("   ").kind, "UNKNOWN");
});

test("androidThreadId is only ever decrypted metadata, never invented", () => {
  const row = applyConversationMetadata(unknownRow(), { sequence: 1, rawAddress: "PARSIANBANK" });
  assert.equal(row.androidThreadId, undefined, "absent stays absent, never guessed");
});
