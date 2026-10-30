"use strict";
// Older pages are prepended above the reader. The reader's place must stay put:
// scrollTop moves by exactly how far the first previously visible message moved.
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../web/src/lib/threadScrollAnchor.ts");
const day = (key) => ({ kind: "day", key });
const msg = (key) => ({ kind: "message", key });
const startsOf = (rows, size = 60) => (index) => index * size;

test("prepending older messages shifts by the anchor's new offset", async () => {
  const { firstMessageAnchor, prependScrollDelta } = await load();
  const before = [day("d1"), msg("m5"), msg("m6")];
  const anchor = firstMessageAnchor(before, startsOf(before));
  assert.deepEqual(anchor, { key: "m5", start: 60 });
  // Older messages of the SAME day land under the unchanged day separator.
  const after = [day("d1"), msg("m1"), msg("m2"), msg("m3"), msg("m4"), msg("m5"), msg("m6")];
  assert.equal(prependScrollDelta(anchor, after, startsOf(after)), 240);
});

test("no shift when nothing was prepended, on a thread switch, or without an anchor", async () => {
  const { firstMessageAnchor, prependScrollDelta } = await load();
  const rows = [msg("a"), msg("b")];
  const anchor = firstMessageAnchor(rows, startsOf(rows));
  assert.equal(prependScrollDelta(anchor, [msg("a"), msg("b"), msg("c")], startsOf(rows)), 0, "append");
  assert.equal(prependScrollDelta(anchor, [msg("x"), msg("y")], startsOf(rows)), 0, "other thread");
  assert.equal(prependScrollDelta(null, rows, startsOf(rows)), 0);
  assert.equal(firstMessageAnchor([day("d")], () => 0), null);
});
