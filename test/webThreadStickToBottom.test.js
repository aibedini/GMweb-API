"use strict";
// The thread follows the newest message unless the reader scrolls up.
const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../web/src/lib/threadStickToBottom.ts");
const at = (scrollTop, scrollHeight = 2000, clientHeight = 500) => ({ scrollTop, scrollHeight, clientHeight });

test("near the bottom is always pinned", async () => {
  const { nextPinned } = await load();
  assert.equal(nextPinned(false, at(1480), 1000), true);
});

test("only an upward scroll away from the bottom unpins", async () => {
  const { nextPinned } = await load();
  assert.equal(nextPinned(true, at(1200), 1500), false, "reader scrolled up");
  // Content grew below (new message, rows re-measured): scrollTop unchanged.
  assert.equal(nextPinned(true, at(1500, 2400), 1500), true);
  // Smooth scroll toward the bottom moves down: stays pinned.
  assert.equal(nextPinned(true, at(1700, 2400), 1500), true);
  // Once unpinned, moving down but still far away keeps it unpinned.
  assert.equal(nextPinned(false, at(900), 800), false);
});

test("appendedNewest detects a new last row only within the same list", async () => {
  const { appendedNewest } = await load();
  const rows = (...keys) => keys.map((key) => ({ key }));
  assert.equal(appendedNewest("b", rows("a", "b", "c")), true);
  assert.equal(appendedNewest("c", rows("a", "b", "c")), false, "nothing new");
  assert.equal(appendedNewest("c", rows("x", "y")), false, "thread switch");
  assert.equal(appendedNewest(null, rows("a")), false, "first paint");
  assert.equal(appendedNewest("c", rows("z", "a", "b", "c")), false, "prepend only");
});
