"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("opened thread repairs stale sidebar preview and order without a refresh", async () => {
  const { reconcileConversationHead } = await import("../web/src/lib/inbox.ts");
  const rows = [
    { aggregateId: "other", preview: "other", lastAt: 150, lastSequence: 3 },
    { aggregateId: "selected", preview: "بله", lastAt: 100, lastSequence: 2 },
  ];
  const latest = { event: { sequence: 4 }, payload: {
    messageId: "new-message", dateMs: 200, body: "newest message",
  } };
  const result = reconcileConversationHead(rows, "selected", latest);
  assert.equal(result[0].aggregateId, "selected");
  assert.equal(result[0].preview, "newest message");
  assert.equal(result[0].lastAt, 200);
  assert.equal(rows[1].preview, "بله");
  assert.equal(reconcileConversationHead(result, "selected", {
    event: { sequence: 1 }, payload: { messageId: "older", dateMs: 99, body: "old" },
  })[0].preview, "newest message");
});
