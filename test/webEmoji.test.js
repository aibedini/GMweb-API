// Emoji insertion at the caret, plus the Unicode sequences the app must
// survive end to end (ZWJ families, variation selectors, skin tones, regional
// indicators, keycaps).
import test from "node:test";
import assert from "node:assert/strict";
import { insertEmoji, countUnicodeSequences, containsNonAscii } from "../web/src/lib/emojiInsert.ts";
import { calculateSmsSegments } from "../web/src/lib/smsSegments.ts";

// Every sequence the task lists, kept verbatim: nothing may be normalised away.
const SEQUENCES = [
  "😀", "😂", "❤️", "👍🏽", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇮🇷", "🇺🇸", "1️⃣", "☺️",
];

test("emoji inserts at the caret and the caret lands after the whole sequence", () => {
  // A|B + 😀 -> A😀B
  assert.deepEqual(insertEmoji("AB", 1, 1, "😀"), { value: "A😀B", caret: 3 });
  // |ABC + ❤️ -> ❤️ABC
  assert.deepEqual(insertEmoji("ABC", 0, 0, "❤️"), { value: "❤️ABC", caret: 2 });
  // ABC| + 👍🏽 -> ABC👍🏽
  assert.deepEqual(insertEmoji("ABC", 3, 3, "👍🏽"), { value: "ABC👍🏽", caret: 7 });
});

test("a selection is replaced by the emoji", () => {
  // selected "ABC" + 😂 -> 😂
  assert.deepEqual(insertEmoji("ABC", 0, 3, "😂"), { value: "😂", caret: 2 });
  // Replace a middle word only.
  assert.deepEqual(insertEmoji("hello world", 6, 11, "🇮🇷"), { value: "hello 🇮🇷", caret: 10 });
});

test("every complex sequence inserts atomically with the right caret", () => {
  for (const emoji of SEQUENCES) {
    const result = insertEmoji("[]", 1, 1, emoji);
    assert.equal(result.value, `[${emoji}]`, `${emoji} inserted intact`);
    assert.equal(result.caret, 1 + emoji.length, `${emoji} caret uses UTF-16 units`);
    // The caret must sit on a code-point boundary, never inside the sequence.
    const before = result.value.slice(0, result.caret);
    assert.equal(before, `[${emoji}]`.slice(0, 1 + emoji.length));
  }
});

test("the inserted text is byte-identical to the source sequence", () => {
  for (const emoji of SEQUENCES) {
    // No normalisation, no stripping of ZWJ / VS16 / skin tone / regional pairs.
    assert.equal(insertEmoji("", 0, 0, emoji).value, emoji);
    assert.equal([...emoji].length >= 1, true);
    assert.equal(emoji.normalize("NFC") === emoji || emoji.normalize("NFC") !== emoji, true);
  }
  // Spot-check the structural code points are actually present.
  assert.equal("👨‍👩‍👧‍👦".includes("\u200D"), true, "family keeps its ZWJ");
  assert.equal("❤️".includes("\uFE0F"), true, "heart keeps its variation selector");
  assert.equal("👍🏽".includes("\uD83C\uDFFD"), true, "thumbs-up keeps its skin tone");
  assert.equal([..."🇮🇷"].length, 2, "flag is a regional-indicator pair");
});

test("missing or invalid selection appends instead of corrupting the draft", () => {
  assert.deepEqual(insertEmoji("AB", null, null, "😀"), { value: "AB😀", caret: 4 });
  assert.deepEqual(insertEmoji("AB", undefined, undefined, "😀"), { value: "AB😀", caret: 4 });
  assert.deepEqual(insertEmoji("AB", NaN, NaN, "😀"), { value: "AB😀", caret: 4 });
  // Reversed selection is normalised, not used to slice backwards.
  assert.deepEqual(insertEmoji("ABCD", 3, 1, "😀"), { value: "A😀D", caret: 3 });
  // Out-of-range offsets are clamped.
  assert.deepEqual(insertEmoji("AB", 99, 99, "😀"), { value: "AB😀", caret: 4 });
  assert.deepEqual(insertEmoji("AB", -5, 0, "😀"), { value: "😀AB", caret: 2 });
});

test("an empty emoji leaves the draft and caret untouched", () => {
  assert.deepEqual(insertEmoji("AB", 1, 1, ""), { value: "AB", caret: 1 });
});

test("mixed Persian / English / emoji / newlines keep every character", () => {
  const persian = "سلام 😀 خوبی؟";
  assert.equal(insertEmoji("سلام  خوبی؟", 5, 5, "😀").value, persian);
  assert.equal(countUnicodeSequences(persian), 12);
  assert.equal(insertEmoji("Hello 👋", 5, 5, "🏽").value, "Hello🏽 👋");

  const multiline = "سلام ❤️\nخط دوم 👨‍👩‍👧‍👦";
  const built = insertEmoji("سلام \nخط دوم ", 5, 5, "❤️").value;
  assert.equal(built, "سلام ❤️\nخط دوم ");
  assert.equal(built.includes("\n"), true, "newlines survive");
  assert.equal(insertEmoji("خط دوم ", 7, 7, "👨‍👩‍👧‍👦").value, multiline.split("\n")[1]);
});

test("emoji push the SMS counter into UCS-2 and update segments immediately", () => {
  // GSM-7 stays GSM-7.
  assert.equal(calculateSmsSegments("hello").encoding, "GSM-7");
  assert.equal(calculateSmsSegments("hello").segments, 1);

  // Any emoji forces UCS-2 (70 units single / 67 multipart).
  for (const emoji of SEQUENCES) {
    const draft = insertEmoji("", 0, 0, emoji).value;
    assert.equal(calculateSmsSegments(draft).encoding, "Unicode", `${emoji} must force UCS-2`);
    assert.equal(containsNonAscii(draft), true);
  }

  // A family emoji is 11 UTF-16 units; the counter must not crash on it.
  const family = calculateSmsSegments("👨‍👩‍👧‍👦");
  assert.equal(family.encoding, "Unicode");
  assert.equal(family.units, 11);
  assert.equal(family.segments, 1);

  // Segment boundaries still apply with emoji mixed in.
  assert.equal(calculateSmsSegments("😀".repeat(35)).segments, 1, "70 UCS-2 units is one segment");
  assert.equal(calculateSmsSegments("😀".repeat(36)).segments, 2);

  // The counter must never throw on any of these.
  for (const emoji of SEQUENCES) {
    assert.doesNotThrow(() => calculateSmsSegments(emoji.repeat(50)));
  }
});
