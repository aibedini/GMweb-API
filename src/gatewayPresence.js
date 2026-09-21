"use strict";

const crypto = require("node:crypto");

const DEFAULT_DEVICE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_DEVICES = 256;
const DEFAULT_AUTH_WINDOW_MS = 15 * 60 * 1000;

function requestToken(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
}

function sanitizeDeviceId(value) {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128);
  return clean || null;
}

class GatewayPresenceTracker {
  constructor({ now = Date.now, deviceTtlMs = DEFAULT_DEVICE_TTL_MS, maxDevices = DEFAULT_MAX_DEVICES, authWindowMs = DEFAULT_AUTH_WINDOW_MS } = {}) {
    this.now = now;
    this.deviceTtlMs = deviceTtlMs;
    this.maxDevices = maxDevices;
    this.authWindowMs = authWindowMs;
    this.devices = new Map();
    this.sawExplicitDevice = false;
    this.authFailures = [];
    this.gatewayAuthFailuresTotal = 0;
    this.activeLongPolls = 0;
    this.lastPullStartedAt = null;
    this.lastSuccessfulPullAt = null;
    this.lastEmptyPullAt = null;
    this.lastTaskPulledAt = null;
    this.lastValidateAt = null;
    this.lastValidateResult = null;
    this.lastAckAt = null;
    this.lastAckOutcome = null;
    this.lastAckDuplicate = null;
    this.lastAckNewlyRecorded = null;
    this.lastPullHttpStatus = null;
    this.lastFailureKind = null;
    this.lastFailureAt = null;
    this.consecutivePullFailures = 0;
    this.lastTaskRequestToken = null;
    this.lastValidateRequestToken = null;
    this.lastAckRequestToken = null;
  }

  #iso(ms = this.now()) { return new Date(ms).toISOString(); }

  #prune(now = this.now()) {
    for (const [id, device] of this.devices) {
      if (now - device.lastSeenAt >= this.deviceTtlMs && device.activePolls === 0) this.devices.delete(id);
    }
    this.authFailures = this.authFailures.filter((at) => now - at < this.authWindowMs);
  }

  #device(rawId, now = this.now()) {
    const deviceId = sanitizeDeviceId(rawId);
    if (!deviceId) return { deviceId: "legacy-shared-device", record: null };
    this.sawExplicitDevice = true;
    this.#prune(now);
    let record = this.devices.get(deviceId);
    if (!record) {
      while (this.devices.size >= this.maxDevices) {
        const oldest = [...this.devices.entries()].filter(([, item]) => item.activePolls === 0).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
        if (!oldest) break;
        this.devices.delete(oldest[0]);
      }
      if (this.devices.size < this.maxDevices) {
        record = { deviceId, firstSeenAt: this.#iso(now), lastSeenAt: now, lastPullStartedAt: null, lastSuccessfulPullAt: null, lastAckAt: null, activePolls: 0, lastFailure: null };
        this.devices.set(deviceId, record);
      }
    }
    if (record) record.lastSeenAt = now;
    return { deviceId, record };
  }

  recordAuthFailure() {
    const now = this.now();
    this.gatewayAuthFailuresTotal += 1;
    this.authFailures.push(now);
    this.#prune(now);
  }

  startPull(rawDeviceId) {
    const now = this.now();
    const { deviceId, record } = this.#device(rawDeviceId, now);
    const at = this.#iso(now);
    this.lastPullStartedAt = at;
    this.activeLongPolls += 1;
    if (record) {
      record.lastPullStartedAt = at;
      record.activePolls += 1;
    }
    return { deviceId, record, startedAtMs: now, finished: false };
  }

  finishPull(context, { task = null, status = 200, failureKind = null } = {}) {
    if (!context || context.finished) return;
    context.finished = true;
    const now = this.now();
    const at = this.#iso(now);
    this.activeLongPolls = Math.max(0, this.activeLongPolls - 1);
    if (context.record) {
      context.record.activePolls = Math.max(0, context.record.activePolls - 1);
      context.record.lastSeenAt = now;
    }
    this.lastPullHttpStatus = status;
    if (failureKind) {
      this.lastFailureKind = failureKind;
      this.lastFailureAt = at;
      this.consecutivePullFailures += 1;
      if (context.record) context.record.lastFailure = failureKind;
      return;
    }
    this.lastSuccessfulPullAt = at;
    this.consecutivePullFailures = 0;
    if (context.record) context.record.lastSuccessfulPullAt = at;
    if (task) {
      this.lastTaskPulledAt = at;
      this.lastTaskRequestToken = requestToken(task.requestId);
    } else {
      this.lastEmptyPullAt = at;
    }
  }

  recordValidate(requestId, verdict) {
    this.lastValidateAt = this.#iso();
    this.lastValidateRequestToken = requestToken(requestId);
    this.lastValidateResult = String(verdict?.status || (verdict?.valid ? "valid" : "unknown")).toLowerCase();
  }

  recordAck(rawDeviceId, requestId, result) {
    const now = this.now();
    const at = this.#iso(now);
    const { record } = this.#device(rawDeviceId, now);
    this.lastAckAt = at;
    this.lastAckRequestToken = requestToken(requestId);
    this.lastAckOutcome = result?.outcome || null;
    this.lastAckDuplicate = Boolean(result?.duplicate);
    this.lastAckNewlyRecorded = Boolean(result?.newlyRecorded);
    if (record) record.lastAckAt = at;
  }

  snapshot() {
    const now = this.now();
    this.#prune(now);
    return {
      lastPullStartedAt: this.lastPullStartedAt,
      lastSuccessfulPullAt: this.lastSuccessfulPullAt,
      lastEmptyPullAt: this.lastEmptyPullAt,
      lastTaskPulledAt: this.lastTaskPulledAt,
      lastValidateAt: this.lastValidateAt,
      lastValidateResult: this.lastValidateResult,
      lastAckAt: this.lastAckAt,
      lastAckOutcome: this.lastAckOutcome,
      lastAckDuplicate: this.lastAckDuplicate,
      lastAckNewlyRecorded: this.lastAckNewlyRecorded,
      lastPullHttpStatus: this.lastPullHttpStatus,
      lastFailureKind: this.lastFailureKind,
      lastFailureAt: this.lastFailureAt,
      consecutivePullFailures: this.consecutivePullFailures,
      activeLongPolls: this.activeLongPolls,
      distinctDevices: this.sawExplicitDevice ? this.devices.size : null,
      authFailuresRecent: this.authFailures.length,
      gatewayAuthFailuresTotal: this.gatewayAuthFailuresTotal,
      lastTaskRequestToken: this.lastTaskRequestToken,
      lastValidateRequestToken: this.lastValidateRequestToken,
      lastAckRequestToken: this.lastAckRequestToken
    };
  }

  deviceSnapshot() {
    this.#prune();
    return [...this.devices.values()].map(({ lastSeenAt, ...device }) => ({ ...device }));
  }
}

module.exports = { GatewayPresenceTracker, requestToken, sanitizeDeviceId, DEFAULT_DEVICE_TTL_MS, DEFAULT_MAX_DEVICES };
