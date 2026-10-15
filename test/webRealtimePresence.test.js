"use strict";
// Realtime transport + phone presence + SIM telemetry.
//
// These pin the behaviours behind the reported defects:
//   - a stream that stops producing frames must NOT report as live
//   - reconnect backoff must be bounded and jittered, never a thundering herd
//   - tab resume / network return / focus must trigger durable catch-up
//   - phone presence must come from server receipt time, never API reachability
//   - the four SIM telemetry states must stay distinct
const test = require("node:test");
const assert = require("node:assert/strict");

// --------------------------------------------------------------- presence

test("phone presence is derived from server receipt time across all bands", async () => {
  const { derivePhonePresence, PHONE_ONLINE_MS, PHONE_STALE_MS } =
    await import("../web/src/lib/phonePresence.ts");
  const now = 1_700_000_000_000;

  assert.equal(derivePhonePresence(null, now), "NEVER_SEEN");
  assert.equal(derivePhonePresence(undefined, now), "NEVER_SEEN");
  assert.equal(derivePhonePresence(0, now), "NEVER_SEEN");
  assert.equal(derivePhonePresence(NaN, now), "NEVER_SEEN");

  assert.equal(derivePhonePresence(now - 10_000, now), "ONLINE");
  assert.equal(derivePhonePresence(now - PHONE_ONLINE_MS, now), "ONLINE");
  assert.equal(derivePhonePresence(now - 90_001, now), "STALE");
  assert.equal(derivePhonePresence(now - PHONE_STALE_MS, now), "STALE");
  assert.equal(derivePhonePresence(now - 180_001, now), "OFFLINE");
  assert.equal(derivePhonePresence(now - 2 * 86_400_000, now), "OFFLINE");

  // A future Android/server clock must not produce a negative age or a fake
  // "online" from a bogus timestamp.
  assert.equal(derivePhonePresence(now + 600_000, now), "ONLINE");
});

test("phone age text is coarse and never negative", async () => {
  const { formatAge, describePhone } = await import("../web/src/lib/phonePresence.ts");
  const now = 1_700_000_000_000;
  assert.equal(formatAge(now - 1_000, now), "1 sec ago");
  assert.equal(formatAge(now - 90_000, now), "2 min ago");
  assert.equal(formatAge(now - 7_200_000, now), "2 hr ago");
  assert.equal(formatAge(now - 2 * 86_400_000, now), "2 d ago");
  assert.equal(formatAge(now + 5_000, now), "0 sec ago");
  assert.equal(describePhone(null, now), "Never connected");
  assert.match(describePhone(now - 60_000, now), /^Online · last seen 1 min ago$/);
  assert.match(describePhone(now - 600_000, now), /^Offline · last seen 10 min ago$/);
});

// -------------------------------------------------------------------- SIM

function telemetry(overrides = {}) {
  return { timestamp: 0, receivedAt: 1_700_000_000_000, ...overrides };
}
const SIM_A = { subscriptionId: 7, slotIndex: 0, displayName: "SIM 1", carrierName: "Irancell",
  isDefaultSms: true, isActive: true, sendCapable: true };
const SIM_B = { subscriptionId: 9, slotIndex: 1, displayName: "SIM 2", carrierName: "MCI",
  isDefaultSms: false, isActive: true, sendCapable: true };

test("the four SIM telemetry states stay distinct with their own copy", async () => {
  const { describeSimTelemetry } = await import("../web/src/lib/simTelemetry.ts");
  const now = 1_700_000_000_000;

  // A: property missing entirely
  const missing = describeSimTelemetry(telemetry(), now, "ONLINE");
  assert.equal(missing.state, "NOT_REPORTED");
  assert.match(missing.copy, /has not been reported yet/);

  // No telemetry at all
  assert.equal(describeSimTelemetry(null, now, "ONLINE").state, "NOT_REPORTED");

  // B: available = false
  const denied = describeSimTelemetry(
    telemetry({ smsSubscriptions: { available: false, items: [] } }), now, "ONLINE");
  assert.equal(denied.state, "PERMISSION_UNAVAILABLE");
  assert.match(denied.copy, /Phone access is required/);

  // C: available = true, zero active
  const none = describeSimTelemetry(
    telemetry({ smsSubscriptions: { available: true, items: [{ ...SIM_A, isActive: false }] } }), now, "ONLINE");
  assert.equal(none.state, "NO_ACTIVE_SUBSCRIPTIONS");
  assert.match(none.copy, /No active SMS SIM/);

  // D: populated
  const ok = describeSimTelemetry(
    telemetry({ smsSubscriptions: { available: true, items: [SIM_A, SIM_B] } }), now, "ONLINE");
  assert.equal(ok.state, "OK");
  assert.equal(ok.active.length, 2);
  assert.equal(ok.stale, false);
  assert.match(ok.copy, /SIM data updated/);

  // The three non-OK states must never collapse into one message.
  assert.notEqual(missing.copy, denied.copy);
  assert.notEqual(denied.copy, none.copy);
  assert.notEqual(missing.copy, none.copy);
});

test("stale and offline SIM snapshots are labelled, never claimed fresh", async () => {
  const { describeSimTelemetry } = await import("../web/src/lib/simTelemetry.ts");
  const now = 1_700_000_000_000;
  const fresh = { available: true, items: [SIM_A] };

  const staleView = describeSimTelemetry(
    telemetry({ receivedAt: now - 18 * 60_000, smsSubscriptions: fresh }), now, "STALE");
  assert.equal(staleView.stale, true);
  // A stale CONNECTION is not an outdated report; the copy must say which.
  assert.match(staleView.copy, /stale/i);
  assert.doesNotMatch(staleView.copy, /offline/i);

  const oldView = describeSimTelemetry(
    telemetry({ receivedAt: now - 18 * 60_000, smsSubscriptions: fresh }), now, "ONLINE");
  assert.match(oldView.copy, /outdated/);

  const offlineView = describeSimTelemetry(
    telemetry({ receivedAt: now - 20 * 60_000, smsSubscriptions: fresh }), now, "OFFLINE");
  assert.equal(offlineView.stale, true);
  assert.match(offlineView.copy, /Primary phone is offline/);
  assert.match(offlineView.copy, /Reconnect the phone/);
});

test("a remembered SIM is rejected when it vanished or the report is stale", async () => {
  const { validateSelectedSim } = await import("../web/src/lib/simTelemetry.ts");
  assert.deepEqual(validateSelectedSim(null, [SIM_A], false), { state: "DEFAULT", message: null });
  assert.deepEqual(validateSelectedSim(7, [SIM_A, SIM_B], false), { state: "ACTIVE", message: null });

  const missing = validateSelectedSim(99, [SIM_A], false);
  assert.equal(missing.state, "MISSING");
  assert.match(missing.message, /no longer active/);

  const stale = validateSelectedSim(7, [SIM_A], true);
  assert.equal(stale.state, "STALE");
  assert.match(stale.message, /outdated report/);

  // Never silently substitutes a different SIM.
  assert.equal(validateSelectedSim(99, [SIM_B], false).state, "MISSING");
});

// --------------------------------------------------------------- realtime

test("reconnect backoff is bounded, jittered and never a stampede", async () => {
  const { reconnectDelayFor } = await import("../web/src/lib/sync/live-invalidation.ts");
  // Full jitter: the delay for a given cap lands in [cap/2, cap]. The first
  // retry stays inside the historical <=250ms budget so an immediately
  // recoverable stream is not slowed down by backoff.
  assert.equal(reconnectDelayFor(1, () => 0), 125);
  assert.equal(reconnectDelayFor(1, () => 1), 250);
  assert.equal(reconnectDelayFor(2, () => 1), 500);
  assert.equal(reconnectDelayFor(3, () => 1), 1_000);
  assert.equal(reconnectDelayFor(6, () => 1), 8_000);
  assert.equal(reconnectDelayFor(7, () => 1), 16_000);
  // Capped at 20s no matter how many attempts.
  assert.equal(reconnectDelayFor(8, () => 1), 20_000);
  assert.equal(reconnectDelayFor(50, () => 1), 20_000);
  // Never zero: a zero delay would spin the reconnect loop.
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    assert.ok(reconnectDelayFor(attempt, () => 0) >= 125, `attempt ${attempt} produced a near-zero delay`);
  }
  // Two clients with different random values must not synchronise.
  assert.notEqual(reconnectDelayFor(4, () => 0.1), reconnectDelayFor(4, () => 0.9));
});

test("realtime metrics expose heartbeat/error fields and never lie about health", async () => {
  const { getLiveSyncMetrics, isRealtimeHealthy } = await import("../web/src/lib/sync/live-invalidation.ts");
  const metrics = getLiveSyncMetrics();
  for (const key of ["connection", "reconnectCount", "lastReconnectAt", "lastFrameAt",
    "lastHeartbeatAt", "connectedAt", "lastErrorAt", "lastError", "serverPublishedAt",
    "browserSseReceivedAt", "browserPullCompletedAt", "browserProjectedAt", "browserRenderedAt"]) {
    assert.ok(key in metrics, `missing metric ${key}`);
  }
  // Nothing has connected in this process, so health must be false — the UI
  // must never claim "Live" without a recent frame.
  assert.equal(isRealtimeHealthy(), false);
});

test("heartbeats do not trigger a sync, but invalidation, resume and focus do", async () => {
  const previousES = global.EventSource;
  const previousFetch = global.fetch;
  const previousDocument = global.document;
  const previousWindow = global.window;
  const streams = [];
  class FakeEventSource {
    constructor(url) { this.url = url; streams.push(this); }
    close() { this.closed = true; }
  }
  const documentListeners = new Map();
  const windowListeners = new Map();
  global.EventSource = FakeEventSource;
  global.fetch = async () => Response.json({ authenticated: true });
  global.document = {
    visibilityState: "hidden",
    addEventListener: (type, handler) => documentListeners.set(type, handler),
    removeEventListener: (type) => documentListeners.delete(type),
  };
  global.window = {
    addEventListener: (type, handler) => windowListeners.set(type, handler),
    removeEventListener: (type) => windowListeners.delete(type),
  };

  try {
    const { subscribeSyncAvailable, getLiveSyncMetrics } =
      await import("../web/src/lib/sync/live-invalidation.ts");
    let pulls = 0;
    const dispose = subscribeSyncAvailable(async () => { pulls += 1; return 0; }, () => {}, () => {});
    streams[0].onopen();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 1, "onopen performs the initial durable catch-up");

    // A heartbeat keeps the channel observable but must NOT cause a sync.
    streams[0].onmessage({ data: JSON.stringify({ type: "heartbeat", at: new Date().toISOString() }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 1, "heartbeat must not trigger a sync");
    assert.ok(getLiveSyncMetrics().lastHeartbeatAt !== null, "heartbeat recorded");

    // Real invalidation does.
    streams[0].onmessage({ data: JSON.stringify({ type: "sync.available", conversationIds: ["c1"] }) });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 2);

    // Tab becomes visible again -> catch up without waiting for a frame.
    global.document.visibilityState = "visible";
    documentListeners.get("visibilitychange")();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 3, "visibility resume must catch up");

    // Network returned.
    windowListeners.get("online")();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 4, "online must catch up");

    // Window regained focus.
    windowListeners.get("focus")();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 5, "focus must catch up");

    // A hidden tab must NOT trigger catch-up.
    global.document.visibilityState = "hidden";
    documentListeners.get("visibilitychange")();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pulls, 5, "hidden tab must not sync");

    dispose();
    assert.equal(documentListeners.size, 0, "listeners removed on dispose");
    assert.equal(windowListeners.size, 0, "window listeners removed on dispose");
  } finally {
    global.EventSource = previousES;
    global.fetch = previousFetch;
    global.document = previousDocument;
    global.window = previousWindow;
  }
});
