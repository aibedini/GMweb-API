"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("GSM-7 counts extension septets and multipart boundaries", async () => {
  const { calculateSmsSegments: count } = await import("../web/src/lib/smsSegments.ts");
  assert.deepEqual(count(""), { encoding: "GSM-7", units: 0, segments: 0, perSegment: 160, remaining: 160 });
  assert.equal(count("Hello\nworld").units, 11);
  assert.equal(count("^{}\\[~]|€\f").units, 20);
  assert.equal(count("a".repeat(160)).segments, 1);
  assert.deepEqual([count("a".repeat(161)).segments, count("a".repeat(306)).segments,
    count("a".repeat(307)).segments], [2, 2, 3]);
});

test("Unicode counts UTF-16 units without splitting surrogate pairs", async () => {
  const { calculateSmsSegments: count } = await import("../web/src/lib/smsSegments.ts");
  assert.deepEqual([count("س".repeat(70)).segments, count("س".repeat(71)).segments], [1, 2]);
  assert.equal(count("Hello سلام").encoding, "Unicode");
  assert.deepEqual([count("😀").units, count("😀".repeat(35)).segments,
    count("😀".repeat(36)).segments], [2, 1, 2]);
  assert.equal(count("س".repeat(66) + "😀" + "س".repeat(66)).segments, 3);
});
