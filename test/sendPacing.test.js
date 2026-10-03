const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SendPacingController, normalizeSendPacingSettings } = require("../src/sendPacing");

test("send pacing settings are normalized to safe dashboard limits", () => {
  assert.deepEqual(normalizeSendPacingSettings({
    maxPerMinute: 999,
    randomDelayEnabled: true,
    randomExtraSeconds: -4
  }), {
    maxPerMinute: 60,
    randomDelayEnabled: true,
    randomExtraSeconds: 0
  });
});

test("send pacing settings persist across controller instances", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gmweb-pacing-"));
  const filePath = path.join(directory, "send-settings.json");
  const first = new SendPacingController({ filePath });
  await first.update({ maxPerMinute: 7, randomDelayEnabled: true, randomExtraSeconds: 9 });

  const second = new SendPacingController({ filePath });
  const loaded = await second.load();
  assert.equal(loaded.maxPerMinute, 7);
  assert.equal(loaded.randomDelayEnabled, true);
  assert.equal(loaded.randomExtraSeconds, 9);
  await fs.rm(directory, { recursive: true, force: true });
});

// The previous version of this test asserted wall-clock elapsed time:
//     assert.ok(Date.now() - startedAt < 90)
// with a 15ms setTimeout in the middle and a 120ms pacing interval. That
// measures OS/event-loop scheduling delay, not pacing behaviour. Under a loaded
// event loop the 15ms sleep itself was observed arriving at 160ms, so the
// assertion failed while the pacing logic was working perfectly:
// on 80/80 loaded runs the waiter resolved via "settings_changed" (never the
// timer) and the new rate always applied.
//
// The clock is now injected, so the test proves the semantics with no timing
// budget at all.
test("saving settings wakes a paced send and applies the new rate immediately", async () => {
  let clock = 1_000_000;
  const pacing = new SendPacingController({
    minuteMs: 120, defaults: { maxPerMinute: 1 }, random: () => 0, now: () => clock
  });

  // Establishes lastSendStartedAt without consuming a real timer.
  await pacing.wait();

  clock += 2;
  const observed = [];
  const waiting = pacing.wait({ onWait: (info) => observed.push(info) });

  // An async body runs synchronously up to its first await, so the waiter is
  // already registered here. This is also what makes a lost wake impossible:
  // the revision is read and the waiter registered with no await between them.
  assert.equal(pacing.waiters.size, 1, "waiter registered synchronously");
  assert.equal(observed.length, 1);
  assert.equal(observed[0].settings.maxPerMinute, 1);
  assert.equal(observed[0].waitMs, 118, "first paced under the OLD rate");

  // Advance only far enough for the NEW interval (120/60 = 2ms) — nowhere near
  // the old 120ms, and without any real-time budget.
  clock += 2;
  await pacing.update({ maxPerMinute: 60, randomDelayEnabled: false, randomExtraSeconds: 0 });
  const result = await waiting;

  assert.equal(result.settings.maxPerMinute, 60, "recomputed with the new settings");
  assert.equal(result.waitMs, 0, "eligible immediately under the NEW rate");
  assert.equal(observed.length, 1, "no second wait under the old pacing");
  assert.equal(pacing.waiters.size, 0, "the old timer was cleared, nothing left hanging");
});

test("a settings change around waiter registration or re-registration is never lost", async () => {
  let clock = 9_000_000;
  const pacing = new SendPacingController({
    minuteMs: 120, defaults: { maxPerMinute: 1 }, random: () => 0, now: () => clock
  });
  await pacing.wait();
  clock += 2;

  const waiting = pacing.wait();
  assert.equal(pacing.waiters.size, 1, "registered before any await, so update() cannot slip in");

  // 1) update() lands in the same tick as registration. The rate is unchanged,
  //    so the loop must re-register and keep waiting rather than conclude.
  await pacing.update({ maxPerMinute: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pacing.waiters.size, 1, "still waiting after the woken iteration re-registered");

  // 2) the rate actually changes: the woken waiter must pick it up.
  clock += 2;
  await pacing.update({ maxPerMinute: 60 });
  const result = await waiting;
  assert.equal(result.settings.maxPerMinute, 60, "observed the revision change");
  assert.equal(result.waitMs, 0, "not left blocked under the old pacing");
  assert.equal(pacing.waiters.size, 0);
});
