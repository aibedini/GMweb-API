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

test("saving settings wakes a paced send and applies the new rate immediately", async () => {
  const pacing = new SendPacingController({ minuteMs: 120, defaults: { maxPerMinute: 1 }, random: () => 0 });
  await pacing.wait();
  const startedAt = Date.now();
  const waiting = pacing.wait();
  await new Promise((resolve) => setTimeout(resolve, 15));
  await pacing.update({ maxPerMinute: 60, randomDelayEnabled: false, randomExtraSeconds: 0 });
  await waiting;
  assert.ok(Date.now() - startedAt < 90, "the old 120ms pacing timer should have been interrupted");
});
