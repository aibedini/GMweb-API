"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("65 messages traverse 10/20/20/15 without omissions or duplicates", async () => {
  const { mergeThreadEvents, assertHistoryProgress } = await import("../web/src/lib/threadHistory.ts");
  const all = Array.from({ length: 65 }, (_, index) => ({
    eventId: `event-${index + 1}`, messageId: `message-${index + 1}`, sequence: index + 1
  }));
  let shown = all.slice(55);
  let cursor = 56;
  for (const [start, end, next, hasMore] of [
    [35, 55, 36, true], [15, 35, 16, true], [0, 15, undefined, false]
  ]) {
    const page = { items: all.slice(start, end), hasMore, next };
    assertHistoryProgress(cursor, page);
    shown = mergeThreadEvents(shown, page.items);
    cursor = next;
  }
  assert.deepEqual(shown.map(row => row.eventId), all.map(row => row.eventId));
  assert.equal(new Set(shown.map(row => row.messageId)).size, 65);
  assert.equal(mergeThreadEvents(shown, [all[0]]).length, 65);
  for (const page of [
    { items: [all[0]], hasMore: true, next: 16 },
    { items: [], hasMore: true, next: 15 },
    { items: [all[0]], hasMore: true }
  ]) assert.throws(() => assertHistoryProgress(16, page), /PAGINATION_STALLED/);
});
