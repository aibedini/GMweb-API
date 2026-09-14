"use strict";
// Shared harness for the stale-SMS revocation tests.
//
// It wires the REAL modules — SendStore (SQLite), AndroidOutbox, the revocation
// service and the gateway routes — exactly the way server.js does, and replaces
// only the two things a unit test cannot have: Redis/BullMQ and a physical
// phone. The fake queue models BullMQ's five relevant states faithfully
// (waiting / paused / delayed / prioritized / active), including the fact that
// cancelPendingJob() REFUSES to remove an active job — the dead end this whole
// change exists to route around.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Fastify = require("fastify");
const { SendStore } = require("../src/sendStore");
const { AndroidOutbox } = require("../src/androidOutbox");
const { createSendRevocation } = require("../src/sendRevocation");
const { registerGatewayRoutes } = require("../src/gatewayRoutes");
const { DEPLETION_KINDS } = require("../src/notificationMeta");

const PENDING_STATES = ["waiting", "paused", "delayed", "prioritized"];
const DEVICE_KEY = "test-device-key";

function createFakeQueue() {
  const jobs = new Map();
  return {
    jobs,
    add(id, state = "waiting") {
      const job = { id: String(id), state };
      jobs.set(job.id, job);
      return job;
    },
    setState(id, state) {
      const job = jobs.get(String(id));
      if (job) job.state = state;
      return job;
    },
    async jobStatus(id) {
      const job = jobs.get(String(id));
      return job ? { id: job.id, state: job.state, attemptsMade: 0, maxAttempts: 3 } : null;
    },
    // Mirrors src/queue.js cancelPendingJob(): an ACTIVE job is not removable.
    async cancelPendingJob(id) {
      const job = jobs.get(String(id));
      if (!job) return { cancelled: false, reason: "not_found", state: null };
      if (!PENDING_STATES.includes(job.state)) {
        return { cancelled: false, reason: job.state === "active" ? "active" : "not_pending", state: job.state };
      }
      jobs.delete(String(id));
      return { cancelled: true, id: job.id, state: job.state };
    }
  };
}

function createHarness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-revocation-"));
  const dbPath = path.join(dir, "sends.db");
  const open = () => new SendStore(dbPath);
  let store = open();
  const queue = createFakeQueue();
  const events = [];
  const audits = [];
  const activeCancellationRequests = new Set();
  const logLines = [];

  const freshStores = [];
  let outbox = null;
  let outboxSeq = 0;
  const createOutbox = (storeRef) => new AndroidOutbox({
    hooks: {
      isRevoked: (gatewayRequestId) => {
        const row = storeRef.byGatewayRequest(gatewayRequestId);
        if (!row) return null;
        if (row.revoked_at) {
          return {
            cause: row.status === "cancelled" ? "cancel" : "superseded",
            reason: row.revocation_reason || "superseded",
            revokedAt: row.revoked_at
          };
        }
        if (row.status === "cancelled") return { cause: "cancel", reason: row.error || "cancelled" };
        if (storeRef.isSuperseded(row)) return { cause: "superseded", reason: row.revocation_reason || "superseded" };
        return null;
      },
      onOffer: (gatewayRequestId, entry) => {
        if (entry?.ledgerId) storeRef.attachGatewayRequest(entry.ledgerId, gatewayRequestId);
      },
      // Mirrors server.js: after a restart the bridge memory is gone but the
      // durable row is not, so a retried ACK is still answered.
      durableLookup: (gatewayRequestId) => storeRef.byGatewayRequest(gatewayRequestId),
      onSettle: (gatewayRequestId, outcome, entry) => {
        logLines.push({ gatewayRequestId, outcome });
      },
      leaseMs: options.leaseMs ?? 60,
      now: Date.now
    }
  });
  outbox = createOutbox(store);

  const revocation = createSendRevocation({
    sendStore: store,
    queue,
    outbox,
    activeCancellationRequests,
    onEvent: (event) => events.push(event),
    onAudit: (entry) => audits.push(entry),
    log: { info: () => {}, error: () => {}, warn: () => {} }
  });

  /** Queue one notification the way POST /send does (tag + job in one step). */
  function queueNotification({
    serviceKey = "eve:1:uuid-A", source = "eve", kind = "volume_ended",
    generation = 17, to = "+989120000001", text = "your volume ended",
    jobId = null, state = "waiting", requiresValidation = undefined,
    correlationId = "corr-1", keyName = "eve", priority = "expiring"
  } = {}) {
    const id = store.claim({
      to, text, keyName, priority, windowMs: 0,
      notification: {
        source, serviceKey, notificationKind: kind, generation, correlationId,
        ...(requiresValidation === undefined ? {} : { requiresValidation })
      }
    });
    const ledgerId = id.id;
    const job = jobId || `job-${++outboxSeq}`;
    store.attachJob(ledgerId, job);
    if (state === "active") store.markStatus(job, "active", { attempts: 1 });
    queue.add(job, state);
    return { ledgerId, jobId: job };
  }

  /**
   * Faithful mirror of startSendWorker() + handleSendCompleted() for the paths
   * this change touches: the durable guard BEFORE any transport, the outbox
   * hand-off for android, shouldCancel for chrome, and the superseded /
   * sent-after-revocation settlements.
   */
  async function runWorker(jobId, { transport = "android", to, text } = {}) {
    const guard = revocation.guardForJob(jobId);
    if (guard?.superseded) return settleSuperseded(jobId, guard.reason);
    if (guard?.cancelled) return { cancelled: true };

    const row = store.byJob(jobId);
    const target = { to: to || row?.to_number, text: text || row?.text };
    store.markStatus(jobId, "active", { attempts: 1 });
    queue.setState(jobId, "active");

    const meta = row?.service_key ? {
      source: row.source, serviceKey: row.service_key,
      notificationKind: row.notification_kind, generation: row.notification_generation,
      correlationId: row.correlation_id, requiresValidation: Boolean(row.requires_validation)
    } : null;

    try {
      let result;
      if (transport === "android") {
        // Mirrors startSendWorker: the gateway request id is derived from the
        // LEDGER row, so every attempt of one job reuses the same identity.
        const gatewayRequestId = (row?.id ? store.requestId(row.id) : null) || `pull_${jobId}`;
        result = await outbox.sendMessage({
          to: target.to, text: target.text, ledgerId: row?.id ?? null, jobId, meta,
          requestId: gatewayRequestId,
          shouldCancel: () => Boolean(revocation.guardForJob(jobId))
        });
      } else {
        // Chrome path: shouldCancel is consulted between browser steps.
        if (revocation.guardForJob(jobId)) {
          const error = new Error("cancelled_by_consumer");
          error.code = "SEND_CANCELLED";
          throw error;
        }
        result = {
          type: "sent",
          submission: { submittedOnce: true, submittedAt: new Date().toISOString(), verified: true, verificationStatus: "confirmed", verificationAttempts: 0 }
        };
      }

      if (result?.superseded) return settleSuperseded(jobId, result.reason);
      if (result?.sentAfterRevocation) {
        store.markStatus(jobId, "sent", { attempts: 1, result });
        revocation.auditSentAfterRevocation(store.byJob(jobId), { transport });
        return { type: "sent", sentAfterRevocation: true };
      }
      store.markStatus(jobId, "sent", { attempts: 1, result });
      return result;
    } catch (error) {
      if (error?.code === "SEND_CANCELLED") {
        const stopped = revocation.guardForJob(jobId);
        if (stopped?.superseded) return settleSuperseded(jobId, stopped.reason);
        store.markStatus(jobId, "cancelled", { attempts: 1, error: error.message });
        return { cancelled: true };
      }
      store.markStatus(jobId, "queued", { attempts: 1, error: error.message });
      return { failed: true, error: error.message };
    }
  }

  function settleSuperseded(jobId, reason) {
    const row = store.byJob(jobId);
    if (row) revocation.finalizeSuperseded(row, reason);
    // Mirrors handleSendCompleted(): one terminal, non-billable event.
    events.push({
      type: "send_superseded", jobId, status: "superseded", state: "superseded",
      terminal: true, successful: false, counted: false,
      reason: reason || "superseded"
    });
    return { superseded: true, reason: reason || "superseded" };
  }

  /** Standalone Fastify app exposing the real gateway routes. */
  async function buildGatewayApp(overrides = {}) {
    const app = Fastify({ logger: false });
    registerGatewayRoutes(app, {
      outbox: overrides.outbox || outbox,
      sendStore: overrides.store || store,
      revocation: overrides.revocation || revocation,
      checkDeviceKey: (request) => String(request.headers["x-api-key"] || "") === DEVICE_KEY,
      isPullModeActive: () => true,
      log: { info: () => {}, error: () => {}, warn: () => {} }
    });
    await app.ready();
    return app;
  }

  function invalidate(body = {}) {
    return revocation.invalidate({
      source: "eve",
      serviceKey: "eve:1:uuid-A",
      currentGeneration: 18,
      invalidateKinds: [...DEPLETION_KINDS],
      reason: "renewed",
      eventId: "lc-1",
      ...body
    });
  }

  function close() {
    try { store.close(); } catch { /* already closed */ }
    for (const extra of freshStores) { try { extra.close(); } catch { /* already closed */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return {
    dir, dbPath, queue, events, audits, activeCancellationRequests, logLines,
    get store() { return store; },
    get outbox() { return outbox; },
    revocation, queueNotification, runWorker, buildGatewayApp, invalidate, close,
    deviceKey: DEVICE_KEY,
    // Cold restart: a SECOND process opening the same SQLite file with empty
    // memory. The original process keeps running, exactly like the real
    // overlap between a crash-restart and a phone that is still holding a task.
    coldRestart() {
      const freshStore = open();
      const freshOutbox = createOutbox(freshStore);
      const freshRevocation = createSendRevocation({
        sendStore: freshStore, queue, outbox: freshOutbox, activeCancellationRequests,
        onEvent: (event) => events.push(event),
        onAudit: (entry) => audits.push(entry),
        log: { info: () => {}, error: () => {}, warn: () => {} }
      });
      freshStores.push(freshStore);
      return { store: freshStore, outbox: freshOutbox, revocation: freshRevocation };
    }
  };
}

module.exports = { createHarness, createFakeQueue, PENDING_STATES, DEVICE_KEY };
