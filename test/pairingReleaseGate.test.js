const { test } = require("node:test");
const assert = require("node:assert/strict");
const { REQUIRED_STEPS, validate } = require("../scripts/check-pairing-release");
test("release evidence must cover every physical step and the exact artifacts", () => {
  const artifacts = { serverSha256: "server", apkSha256: "apk", fixtureSha256: "fixture" };
  const report = { ...artifacts, kind: "physical-phone-pairing-e2e", physicalDevice: true,
    tester: "unit test only", deviceModel: "test", androidVersion: "test", browserVersion: "test",
    steps: Object.fromEntries(REQUIRED_STEPS.map((step, i) => [step, { passed: true,
      at: new Date(Date.now() - 60000 + i * 1000).toISOString(), evidence: "synthetic validator test" }])) };
  assert.doesNotThrow(() => validate(report, artifacts));
  assert.throws(() => validate({ ...report, physicalDevice: false }, artifacts));
  assert.throws(() => validate(report, { ...artifacts, apkSha256: "different" }));
  assert.throws(() => validate(report, { ...artifacts, serverSha256: "different" }));
  assert.throws(() => validate({ ...report, steps: { ...report.steps, server_restart: { passed: false } } }, artifacts));
  assert.throws(() => validate({ ...report, steps: {} }, artifacts));
});
