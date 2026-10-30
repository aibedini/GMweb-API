"use strict";
// While the reader is scrolled up, the row they are reading stays put no matter
// what changes above it (older page prepended, rows re-measured).
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../web/src/lib/threadScrollAnchor.ts");
const layout = (sizes) => {
  let start = 0;
  return sizes.map(([key, size]) => { const row = { key, start, end: start + size }; start += size; return row; });
};

test("captures the first visible row and its offset", async () => {
  const { captureAnchor } = await load();
  const rows = layout([["a", 100], ["b", 100], ["c", 100]]);
  assert.deepEqual(captureAnchor(rows, 150), { key: "b", offset: -50 });
  assert.deepEqual(captureAnchor(rows, 0), { key: "a", offset: 0 });
  assert.equal(captureAnchor(rows, 999), null);
});

test("prepending older rows moves scrollTop by exactly the inserted height", async () => {
  const { captureAnchor, restoreScrollTop } = await load();
  const before = layout([["m5", 60], ["m6", 60]]);
  const anchor = captureAnchor(before, 30);
  const after = layout([["m1", 80], ["m2", 70], ["m3", 90], ["m4", 60], ["m5", 60], ["m6", 60]]);
  assert.equal(restoreScrollTop(anchor, after, 0), 300 + 30);
});

test("re-measured rows above the anchor are compensated; list offset is respected", async () => {
  const { captureAnchor, restoreScrollTop } = await load();
  const estimated = layout([["x", 62], ["y", 62], ["z", 62]]);
  const anchor = captureAnchor(estimated, 130);
  const measured = layout([["x", 120], ["y", 95], ["z", 62]]);
  assert.equal(restoreScrollTop(anchor, measured, 48), 48 + 215 + (130 - 124));
  assert.equal(restoreScrollTop(anchor, layout([["q", 10]]), 0), null, "anchor row gone");
  assert.equal(restoreScrollTop(null, measured, 0), null);
});

test("a day separator is never the anchor (it stays first when same-day rows are prepended)", async () => {
  const { captureAnchor, restoreScrollTop } = await load();
  const isMessage = (row) => !String(row.key).startsWith("day");
  const before = layout([["day-10", 40], ["m5", 60], ["m6", 60]]).map((row, index) => ({ ...row, index }));
  const anchor = captureAnchor(before, 10, isMessage);
  assert.equal(anchor.key, "m5");
  const after = layout([["day-10", 40], ["m3", 60], ["m4", 60], ["m5", 60], ["m6", 60]]);
  assert.equal(restoreScrollTop(anchor, after, 0), 10 + 120, "the reader still sees m5 where it was");
});
