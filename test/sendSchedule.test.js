const test = require("node:test");
const assert = require("node:assert/strict");
const { sendSchedule, sendGate, zonedClock } = require("../src/sendSchedule");

// Use UTC so the clock is deterministic (no DST/zone ambiguity in assertions).
const TZ = "UTC";
const START = 2;
const END = 8;

test("blocks sends inside quiet hours", () => {
  const now = new Date("2026-01-15T03:00:00Z");
  const result = sendSchedule(now, { timeZone: TZ, startHour: START, endHour: END });
  assert.equal(result.blocked, true);
  assert.equal(result.localHour, 3);
});

test("allows sends outside quiet hours", () => {
  const now = new Date("2026-01-15T10:00:00Z");
  const result = sendSchedule(now, { timeZone: TZ, startHour: START, endHour: END });
  assert.equal(result.blocked, false);
  assert.equal(result.releaseAt, null);
});

test("startHour is inclusive and endHour is exclusive", () => {
  assert.equal(
    sendSchedule(new Date("2026-01-15T02:00:00Z"), { timeZone: TZ, startHour: START, endHour: END }).blocked,
    true
  );
  assert.equal(
    sendSchedule(new Date("2026-01-15T08:00:00Z"), { timeZone: TZ, startHour: START, endHour: END }).blocked,
    false
  );
});

test("releaseAt targets the quiet-window end", () => {
  const now = new Date("2026-01-15T03:00:00Z");
  const result = sendSchedule(now, { timeZone: TZ, startHour: START, endHour: END });
  assert.equal(result.releaseAt.getTime() - now.getTime(), 5 * 60 * 60 * 1000);
});

test("a fresh high-priority send bypasses quiet hours", () => {
  const now = new Date("2026-01-15T03:00:00Z");
  const result = sendGate(now, { timeZone: TZ, startHour: START, endHour: END, highPriority: true, delayedRetry: false });
  assert.equal(result.blocked, false);
  assert.equal(result.bypassed, true);
});

test("a delayed high-priority retry is still held", () => {
  const now = new Date("2026-01-15T03:00:00Z");
  const result = sendGate(now, { timeZone: TZ, startHour: START, endHour: END, highPriority: true, delayedRetry: true });
  assert.equal(result.blocked, true);
  assert.equal(result.bypassed, false);
});

test("zonedClock parses UTC hour deterministically", () => {
  const clock = zonedClock(new Date("2026-01-15T21:30:45Z"), TZ);
  assert.equal(clock.hour, 21);
  assert.equal(clock.minute, 30);
  assert.equal(clock.second, 45);
});
