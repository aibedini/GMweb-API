// SIM refresh on the Web side: one liveness authority, honest copy, and a
// refresh that asks the phone instead of re-reading what we already have.
import test from "node:test";
import assert from "node:assert/strict";
import { authoritativePhonePresence, authoritativeTelemetryFreshness } from "../web/src/lib/deviceState.ts";
import {
  IDLE_SIM_REFRESH, REFRESH_COMMAND_TYPE, planSimRefresh, refreshFailureForCommand,
  simRefreshCopy, simRefreshInFlight, supportsRemoteRefresh, telemetryAdvanced,
} from "../web/src/lib/simRefresh.ts";
import { describeSimTelemetry } from "../web/src/lib/simTelemetry.ts";

const NOW = Date.now();
const DAY = 86_400_000;
const CAPABLE = { capabilities: { commandTypes: ["SEND_SMS", "MARK_THREAD_READ", REFRESH_COMMAND_TYPE] } };

const status = (phoneState, telemetryState = "OLD", lastActivityAt = NOW) =>
  ({ phone: { state: phoneState, lastActivityAt, lastActivitySource: "COMMAND_POLL", ageMs: 1_000,
    model: "SM-G998B", manufacturer: "samsung", androidVersion: "15", appVersion: "3.4.21" },
  telemetry: { state: telemetryState, receivedAt: NOW - 3 * DAY, ageMs: 3 * DAY, clockSkewMs: 0 }, now: NOW });

// 15 (the production incident) + 1
test("REGRESSION: fresh agent activity + 3-day-old telemetry => ONLINE, not offline", () => {
  const telemetry = { timestamp: NOW - 3 * DAY, receivedAt: NOW - 3 * DAY };
  assert.equal(authoritativePhonePresence(status("ONLINE"), telemetry), "ONLINE");
  assert.equal(authoritativeTelemetryFreshness(status("ONLINE"), telemetry), "OLD");
  assert.notEqual(authoritativePhonePresence(status("ONLINE"), telemetry), "OFFLINE");
});

test("telemetry-derived presence is only a fallback when the status call failed", () => {
  // Status endpoint unavailable -> local derivation from telemetry age.
  assert.equal(authoritativePhonePresence(null, { timestamp: 0, receivedAt: NOW - 3 * DAY }), "OFFLINE");
  assert.equal(authoritativePhonePresence(null, { timestamp: 0, receivedAt: NOW - 1_000 }), "ONLINE");
  // Status present always wins, even when it contradicts telemetry age.
  assert.equal(authoritativePhonePresence(status("ONLINE"), { timestamp: 0, receivedAt: NOW - 3 * DAY }), "ONLINE");
});

// 2 / 13
test("OFFLINE and NEVER_SEEN never enqueue a command", () => {
  for (const state of ["OFFLINE", "NEVER_SEEN"]) {
    const plan = planSimRefresh(status(state), { timestamp: 0, receivedAt: NOW, ...CAPABLE });
    assert.equal(plan.action, "OFFLINE", `phone ${state} must not receive a command`);
  }
});

// 12
test("a phone without the capability is UNSUPPORTED and gets no command", () => {
  const older = { timestamp: NOW, receivedAt: NOW };
  assert.equal(supportsRemoteRefresh(older), false);
  assert.equal(planSimRefresh(status("ONLINE", "FRESH"), older).action, "UNSUPPORTED");
  assert.equal(simRefreshCopy({ state: "UNSUPPORTED" }), "Remote SIM refresh is not supported by this Android build.");
  // An older build must still show normal telemetry, not an error.
  const olderWithSims = { ...older, smsSubscriptions: { available: true, items: [{ subscriptionId: 1,
    slotIndex: 0, displayName: "SIM 1", carrierName: "MCI", isDefaultSms: true, isActive: true }] } };
  assert.equal(describeSimTelemetry(olderWithSims, NOW, "ONLINE", "FRESH").state, "OK");
});

test("capability detection is by name, never by app version", () => {
  assert.equal(supportsRemoteRefresh({ timestamp: NOW, receivedAt: NOW, capabilities: {} }), false);
  assert.equal(supportsRemoteRefresh({ timestamp: NOW, receivedAt: NOW, capabilities: { commandTypes: [] } }), false);
  assert.equal(supportsRemoteRefresh({ timestamp: NOW, receivedAt: NOW, ...CAPABLE }), true);
  // A newer version string alone must NOT imply support.
  const future = { timestamp: NOW, receivedAt: NOW, app: { versionName: "99.0.0" } };
  assert.equal(supportsRemoteRefresh(future), false);
});

test("STALE may still proceed but must say it is waiting", () => {
  const plan = planSimRefresh(status("STALE", "STALE"), { timestamp: NOW, receivedAt: NOW, ...CAPABLE });
  assert.equal(plan.action, "PROCEED");
  assert.equal(plan.presence, "STALE");
  assert.match(simRefreshCopy({ state: "PHONE_STALE" }), /stale/i);
});

test("ONLINE proceeds and carries the baseline receipt time", () => {
  const plan = planSimRefresh(status("ONLINE"), { timestamp: NOW, receivedAt: NOW - 500, ...CAPABLE });
  assert.equal(plan.action, "PROCEED");
  assert.equal(plan.baselineReceivedAt, NOW - 500);
});

// 8 / 9 — the only proof of success
test("COMPLETED is not success: success requires a NEWER server receivedAt", () => {
  const baseline = NOW - 10_000;
  assert.equal(telemetryAdvanced(baseline, { receivedAt: baseline }), false, "unchanged is NOT updated");
  assert.equal(telemetryAdvanced(baseline, { receivedAt: baseline - 1 }), false, "older is NOT updated");
  assert.equal(telemetryAdvanced(baseline, { receivedAt: baseline + 1 }), true);
  assert.equal(telemetryAdvanced(baseline, null), false, "no report is NOT updated");
  assert.equal(telemetryAdvanced(null, { receivedAt: NOW }), true, "first ever report counts");
  assert.equal(telemetryAdvanced(null, null), false);
});

test("only UPDATED counts as success, and only while in flight do we block", () => {
  assert.equal(simRefreshInFlight(IDLE_SIM_REFRESH), false);
  assert.equal(simRefreshInFlight({ state: "REQUESTING" }), true);
  assert.equal(simRefreshInFlight({ state: "WAITING_FOR_PHONE", commandId: "c" }), true);
  assert.equal(simRefreshInFlight({ state: "WAITING_FOR_TELEMETRY", commandId: "c", baselineReceivedAt: null }), true);
  assert.equal(simRefreshInFlight({ state: "UPDATED", receivedAt: NOW }), false);
  assert.equal(simRefreshInFlight({ state: "TIMED_OUT" }), false);
});

// 10 / 11
test("command FAILED and EXPIRED map to their own honest states", () => {
  assert.equal(refreshFailureForCommand("FAILED"), "COMMAND_FAILED");
  assert.equal(refreshFailureForCommand("EXPIRED"), "EXPIRED");
  for (const ok of ["QUEUED", "DELIVERED_TO_AGENT", "ACCEPTED_BY_AGENT", "EXECUTING", "COMPLETED", undefined]) {
    assert.equal(refreshFailureForCommand(ok), null, `${String(ok)} is not a failure`);
  }
  assert.match(simRefreshCopy({ state: "COMMAND_FAILED", errorCode: "X" }), /rejected/);
  assert.match(simRefreshCopy({ state: "TIMED_OUT" }), /did not answer/);
});

test("no non-UPDATED state ever claims an update", () => {
  const states = [IDLE_SIM_REFRESH, { state: "REQUESTING" }, { state: "WAITING_FOR_PHONE", commandId: "c" },
    { state: "WAITING_FOR_TELEMETRY", commandId: "c", baselineReceivedAt: null },
    { state: "PHONE_OFFLINE" }, { state: "PHONE_STALE" }, { state: "UNSUPPORTED" },
    { state: "COMMAND_FAILED", errorCode: "X" }, { state: "TIMED_OUT" }, { state: "FAILED", errorCode: "X" }];
  for (const state of states) {
    assert.doesNotMatch(simRefreshCopy(state) ?? "", /\bupdated\b/i, `${state.state} must not claim an update`);
  }
  assert.match(simRefreshCopy({ state: "UPDATED", receivedAt: NOW }), /updated/i);
});

// 3 / 4 — copy matrix: never blame liveness for a freshness problem
test("ONLINE phone never produces offline copy", () => {
  const old = { timestamp: NOW - 3 * DAY, receivedAt: NOW - 3 * DAY };
  const view = describeSimTelemetry(old, NOW, "ONLINE", "OLD");
  assert.doesNotMatch(view.copy, /offline/i);
  assert.match(view.copy, /online/i);
  assert.match(view.copy, /outdated/i);
});

test("ONLINE + never reported, and ONLINE + permission unavailable, are not offline", () => {
  const never = describeSimTelemetry(null, NOW, "ONLINE", "NEVER_REPORTED");
  assert.equal(never.state, "NOT_REPORTED");
  assert.match(never.copy, /has not been reported yet/);
  assert.doesNotMatch(never.copy, /offline/i);

  const denied = describeSimTelemetry(
    { timestamp: NOW, receivedAt: NOW, smsSubscriptions: { available: false, items: [] } }, NOW, "ONLINE", "FRESH");
  assert.equal(denied.state, "PERMISSION_UNAVAILABLE");
  assert.equal(denied.copy, "Phone access is required to read SIM information.");
  assert.doesNotMatch(denied.copy, /offline/i);
});

test("zero active subscriptions and healthy SIMs read correctly", () => {
  const none = describeSimTelemetry(
    { timestamp: NOW, receivedAt: NOW, smsSubscriptions: { available: true, items: [] } }, NOW, "ONLINE", "FRESH");
  assert.equal(none.state, "NO_ACTIVE_SUBSCRIPTIONS");
  assert.equal(none.copy, "No active SMS SIM was detected.");

  const sims = { timestamp: NOW, receivedAt: NOW,
    smsSubscriptions: { available: true, items: [{ subscriptionId: 2, slotIndex: 0, displayName: "SIM 1",
      carrierName: "MCI", isDefaultSms: true, isActive: true }] } };
  const ok = describeSimTelemetry(sims, NOW, "ONLINE", "FRESH");
  assert.equal(ok.state, "OK");
  assert.equal(ok.active.length, 1);
  assert.match(ok.copy, /updated/);
});

test("offline copy is reserved for a genuinely unreachable phone", () => {
  for (const presence of ["OFFLINE", "NEVER_SEEN"]) {
    const view = describeSimTelemetry({ timestamp: NOW, receivedAt: NOW }, NOW, presence, "FRESH");
    assert.match(view.copy, /offline/i, `${presence} should say offline`);
  }
});
