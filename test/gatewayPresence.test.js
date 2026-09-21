"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GatewayPresenceTracker, requestToken, sanitizeDeviceId } = require("../src/gatewayPresence");

test("gateway presence tracks pull lifecycle without leaking active polls", () => {
  let now = 1_700_000_000_000;
  const tracker = new GatewayPresenceTracker({ now: () => now });
  const pull = tracker.startPull("phone-a");
  assert.equal(tracker.snapshot().activeLongPolls, 1);
  now += 25;
  tracker.finishPull(pull, { task: null });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.activeLongPolls, 0);
  assert.equal(snapshot.lastSuccessfulPullAt, new Date(now).toISOString());
  assert.equal(snapshot.lastEmptyPullAt, snapshot.lastSuccessfulPullAt);
  assert.equal(snapshot.distinctDevices, 1);
});

test("failed pull releases active accounting and records a safe failure kind", () => {
  const tracker = new GatewayPresenceTracker();
  const pull = tracker.startPull("phone-a");
  tracker.finishPull(pull, { status: 500, failureKind: "pull_failed" });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.activeLongPolls, 0);
  assert.equal(snapshot.lastFailureKind, "pull_failed");
  assert.equal(snapshot.consecutivePullFailures, 1);
});

test("gateway presence excludes expired devices and bounds storage", () => {
  let now = 0;
  const tracker = new GatewayPresenceTracker({ now: () => now, deviceTtlMs: 100, maxDevices: 2 });
  for (const id of ["a", "b", "c"]) {
    const pull = tracker.startPull(id);
    tracker.finishPull(pull);
    now += 10;
  }
  assert.equal(tracker.snapshot().distinctDevices, 2);
  now += 100;
  assert.equal(tracker.snapshot().distinctDevices, 0);
});

test("legacy callers are supported but are not fabricated as distinct devices", () => {
  const tracker = new GatewayPresenceTracker();
  const pull = tracker.startPull(null);
  tracker.finishPull(pull);
  assert.equal(tracker.snapshot().distinctDevices, null);
  assert.deepEqual(tracker.deviceSnapshot(), []);
});

test("request IDs become short irreversible tokens and device IDs are sanitized", () => {
  assert.match(requestToken("private-request-id"), /^[a-f0-9]{8}$/);
  assert.notEqual(requestToken("private-request-id"), "private-request-id");
  assert.equal(sanitizeDeviceId(" phone\u0000-a "), "phone-a");
  assert.equal(sanitizeDeviceId("x".repeat(200)).length, 128);
});

test("telemetry snapshots never contain raw request IDs, keys, recipients or message bodies", () => {
  const tracker = new GatewayPresenceTracker();
  const rawRequestId = "request-secret-canary";
  tracker.recordValidate(rawRequestId, { status: "valid", valid: true });
  tracker.recordAck("phone-a", rawRequestId, { outcome: "sent", newlyRecorded: true });
  const json = JSON.stringify({ bridge: tracker.snapshot(), devices: tracker.deviceSnapshot() });
  for (const secret of [rawRequestId, "api-key-canary", "+989121234567", "private sms body"]) {
    assert.equal(json.includes(secret), false);
  }
});
