"use strict";
// ONE authoritative transport-health model.
//
// Why this module exists: /admin/overview used to build "Delivery" from
// client.statusForDashboard() (the ACTIVE transport) while building "Device
// bridge" from androidClient.readyState() (the old direct-PUSH client). In the
// android pull transport those are two different machines — the pull bridge is
// AndroidOutbox and the phone dials US — so the dashboard could show
//
//     Delivery:      Phone ready
//     Device bridge: No device
//
// at the same instant, from the same page refresh. Both endpoints now describe
// the same snapshot, and the state vocabulary is explicit and machine-readable
// instead of inferred from transport strings on the client.

const STATE = Object.freeze({
  CONNECTED: "connected",
  STALE: "stale",
  UNCONFIGURED: "unconfigured",
  PUSH_UNREACHABLE: "push_unreachable",
  NOT_PAIRED: "not_paired",
  UNKNOWN: "unknown"
});

// Machine-readable reasons. The dashboard derives its labels from these, so a
// missing device key can never be rendered as "device offline" or vice versa.
const REASON = Object.freeze({
  NO_RECENT_DEVICE_PULL: "no_recent_device_pull",
  DEVICE_KEY_NOT_CONFIGURED: "device_key_not_configured",
  ANDROID_GATEWAY_UNREACHABLE: "android_gateway_unreachable",
  ANDROID_GATEWAY_NOT_CONFIGURED: "android_gateway_not_configured",
  CHROME_NOT_PAIRED: "chrome_not_paired",
  CHROME_PROBE_FAILED: "chrome_probe_failed",
  PULL_BRIDGE_UNAVAILABLE: "pull_bridge_unavailable"
});

const DEFAULT_PULL_LIVENESS_MS = 90000;

function pullLivenessMs(env = process.env) {
  const raw = Number(env.ANDROID_PULL_LIVENESS_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : DEFAULT_PULL_LIVENESS_MS;
}

/**
 * @param {object} deps
 * @param {object} deps.client          transport selector proxy (name/pullMode/outbox/status)
 * @param {object} deps.chromeClient    Playwright client (statusForDashboard)
 * @param {object} deps.androidClient   direct-PUSH gateway client
 * @param {object} deps.deviceKeyStore  pull-bridge device key store ({configured})
 * @param {function} [deps.now]         injectable clock for deterministic tests
 */
function createTransportHealth(deps = {}) {
  const {
    client,
    chromeClient = null,
    androidClient = null,
    deviceKeyStore = null,
    now = Date.now,
    env = process.env
  } = deps;

  const activeTransport = () => String(client?.name || "chrome");
  const isPullMode = () => Boolean(client?.pullMode && client?.outbox);
  const mode = () => (activeTransport() === "android" ? (isPullMode() ? "pull" : "push") : null);

  /** Pull bridge health — the ONLY source of truth for android+pull. */
  function pullSnapshot() {
    const outbox = client?.outbox || null;
    const livenessMs = outbox?.livenessMs || pullLivenessMs(env);
    if (!outbox) {
      return {
        configured: Boolean(deviceKeyStore?.configured),
        ready: false,
        state: STATE.UNCONFIGURED,
        reason: REASON.PULL_BRIDGE_UNAVAILABLE,
        lastPullAt: null,
        lastPullAgeMs: null,
        livenessMs,
        waitingPhones: 0,
        pending: 0,
        inflight: 0,
        revokedInflight: 0,
        tombstones: 0
      };
    }
    const live = outbox.readyState();
    const lastPullAt = live.lastPullAt || null;
    const lastPullAgeMs = lastPullAt ? Math.max(0, now() - Date.parse(lastPullAt)) : null;
    const configured = Boolean(deviceKeyStore?.configured);
    // A configured device that has simply gone quiet is STALE, never
    // "unconfigured": the operator action is completely different.
    let state;
    let ready = false;
    if (!configured) {
      state = STATE.UNCONFIGURED;
    } else if (live.paired) {
      state = STATE.CONNECTED;
      ready = true;
    } else {
      state = STATE.STALE;
    }
    return {
      configured,
      ready,
      state,
      reason: ready ? null : (configured ? REASON.NO_RECENT_DEVICE_PULL : REASON.DEVICE_KEY_NOT_CONFIGURED),
      lastPullAt,
      lastPullAgeMs,
      livenessMs,
      waitingPhones: Number(live.waitingPhones || 0),
      pending: Number(live.pending || 0),
      inflight: Number(live.inflight || 0),
      revokedInflight: Number(live.revokedInflight || 0),
      tombstones: Number(live.tombstones || 0),
      redelivered: Number(live.redelivered || 0)
    };
  }

  /** Direct-push android health. Never consulted while pull mode is active. */
  async function pushSnapshot() {
    let configured = false;
    let state = STATE.UNCONFIGURED;
    let ready = false;
    let reason = REASON.ANDROID_GATEWAY_NOT_CONFIGURED;
    try {
      configured = Boolean(androidClient?.configured);
      if (configured) {
        const live = await androidClient.readyState();
        ready = Boolean(live?.paired);
        state = ready ? STATE.CONNECTED : STATE.PUSH_UNREACHABLE;
        reason = ready ? null : REASON.ANDROID_GATEWAY_UNREACHABLE;
      }
    } catch {
      state = STATE.UNKNOWN;
      reason = REASON.ANDROID_GATEWAY_UNREACHABLE;
    }
    return { configured, ready, state, reason };
  }

  /** Chrome (Playwright) health. */
  async function chromeSnapshot() {
    try {
      const live = await chromeClient?.statusForDashboard?.();
      const ready = Boolean(live?.paired);
      return {
        configured: true,
        ready,
        state: ready ? STATE.CONNECTED : STATE.NOT_PAIRED,
        reason: ready ? null : REASON.CHROME_NOT_PAIRED
      };
    } catch {
      return { configured: true, ready: false, state: STATE.UNKNOWN, reason: REASON.CHROME_PROBE_FAILED };
    }
  }

  /**
   * Android readiness regardless of whether it is the ACTIVE transport. The
   * legacy `androidReady` field on /admin/transport means "is the android
   * transport usable", which is a question about the android bridge, not about
   * which transport is currently selected.
   */
  async function androidSnapshot() {
    return isPullMode() ? pullSnapshot() : await pushSnapshot();
  }

  /**
   * The ONE snapshot. Every endpoint that reports transport health returns this
   * object (or a field of it), so two cards on one screen cannot disagree.
   */
  async function snapshot() {
    const active = activeTransport();
    const current = active === "android"
      ? await androidSnapshot()
      : await chromeSnapshot();

    // Other transports are reported as clearly non-authoritative diagnostics;
    // they must never influence the active transport's readiness. In particular
    // the direct-PUSH client is reported under androidPush while the pull
    // bridge serves the phone — it says nothing about pull liveness.
    const alternatives = {};
    if (active === "chrome") {
      alternatives.android = await androidSnapshot();
    } else {
      alternatives.chrome = await chromeSnapshot();
      if (isPullMode()) alternatives.androidPush = await pushSnapshot();
    }

    return {
      activeTransport: active,
      mode: mode(),
      configured: current.configured,
      ready: current.ready,
      state: current.state,
      reason: current.reason,
      // pull telemetry is present (and zeroed) for every transport so a client
      // can read it unconditionally.
      lastPullAt: current.lastPullAt || null,
      lastPullAgeMs: current.lastPullAgeMs ?? null,
      livenessMs: current.livenessMs ?? pullLivenessMs(env),
      waitingPhones: current.waitingPhones || 0,
      pending: current.pending || 0,
      inflight: current.inflight || 0,
      revokedInflight: current.revokedInflight || 0,
      tombstones: current.tombstones || 0,
      alternatives
    };
  }

  // Transition observability: "the phone went quiet" and "the phone came back"
  // are the two events an operator actually needs. The dashboard polls every
  // 8 seconds, so an edge is reported once and re-reported at most per minute.
  let lastState = null;
  let lastReportedAt = 0;
  const TRANSITION_INTERVAL_MS = 60000;

  function reportTransition(next) {
    if (!next) return null;
    if (next.state === lastState) return null;
    const previous = lastState;
    lastState = next.state;
    if (previous === null) return null; // first observation is not a transition
    const at = now();
    if (at - lastReportedAt < TRANSITION_INTERVAL_MS) return null;
    lastReportedAt = at;
    return { from: previous, to: next.state, reason: next.reason || null, at: new Date(at).toISOString() };
  }

  return {
    snapshot,
    android: androidSnapshot,
    chrome: chromeSnapshot,
    reportTransition,
    STATE,
    REASON,
    pullLivenessMs: () => pullLivenessMs(env)
  };
}

module.exports = { createTransportHealth, STATE, REASON, pullLivenessMs, DEFAULT_PULL_LIVENESS_MS };
