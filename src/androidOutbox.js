// Outbox for the android transport in PULL mode: the phone dials OUT to the
// VPS (no tunnel, no inbound port, survives Iran-side IP churn), picks up
// queued sends, delivers them over the SIM, and acks the result.
//
// Flow:
//   POST /send (Eve) -> BullMQ job -> worker sees transport=android+pull
//     -> sendMessage() offers the task into this outbox and waits
//   Phone loop:  GET  /gateway/pull    -> { task:{requestId,to,text,priority,meta} }
//                POST /gateway/validate -> is this task still wanted?
//                POST /gateway/ack     -> resolves/fails that waiting promise,
//                                         which drives ledger + SSE/webhooks
//
// Lifecycle: pending (offered) -> in-flight (claimed by a phone) -> acked,
// with an orthogonal REVOKED overlay: a task can be revoked while pending (it
// is never handed out) or while in flight (the phone is told to stand down, but
// its identity is kept until it answers or the lease expires, because the
// device may already hold the task locally).
//
// Revocation is NOT an in-memory concern: this class only owns the "who is
// waiting on this task right now" bookkeeping. The durable tombstone lives in
// the send ledger, and the injected isRevoked()/onOffer() hooks are how that
// ledger is consulted and kept in sync. That is what makes the guarantee hold
// across a Node restart, a Redis reconnect or a phone that reconnects later.
// Wire shape for a task with no consumer notification identity. The fields are
// deliberately present-and-null rather than omitted: see #task().
const EMPTY_TASK_META = Object.freeze({
  source: null,
  serviceKey: null,
  notificationKind: null,
  generation: null,
  correlationId: null,
  requiresValidation: false
});

const { decideAck, OUTCOME } = require("./ackStateMachine");

class AndroidOutbox {
  constructor(options = {}) {
    this.pending = new Map();   // offered, not yet claimed by a phone
    this.inflight = new Map();  // claimed by a phone, awaiting its ack
    this.waiters = [];          // long-poll resolvers waiting for work
    this.lastPullAt = 0;        // last time ANY device long-polled us
    // requestId -> { revokedAt, reason, cause, outcome, settledAt }. Kept after
    // the entry itself is gone so a late ACK is recognised as a late ACK
    // instead of an unknown id.
    this.tombstones = new Map();
    this.leaseTimers = new Map();

    const hooks = options.hooks || options;
    this.isRevoked = hooks.isRevoked || null;   // (requestId) => verdict | null
    this.onOffer = hooks.onOffer || null;       // (requestId, entry) => void
    this.onSettle = hooks.onSettle || null;     // (requestId, outcome, entry, details)
    this.onPull = hooks.onPull || null;         // (requestId, entry) => void
    // (requestId) => durable ledger row | null. Lets a RESTARTED process answer
    // an ACK from SendStore instead of "unknown id".
    this.durableLookup = hooks.durableLookup || null;
    this.now = hooks.now || Date.now;
    // How long an in-flight revoked task waits for the phone's answer before it
    // is terminalized as superseded. Bounded so the worker's promise, the
    // BullMQ job and the ledger never hang on an offline device.
    this.leaseMs = Math.max(1000, Number(hooks.leaseMs) || 120000);
    // How long a pull keeps the device "live". Owned here so every caller reads
    // the same number instead of re-declaring 90_000 somewhere else.
    const liveness = Number(hooks.livenessMs ?? process.env.ANDROID_PULL_LIVENESS_MS);
    this.livenessMs = Number.isFinite(liveness) && liveness > 0 ? Math.trunc(liveness) : 90000;
    this.tombstoneTtlMs = Math.max(1000, Number(hooks.tombstoneTtlMs) || 30 * 60 * 1000);
    this.maxTombstones = Math.max(16, Number(hooks.maxTombstones) || 5000);
  }

  // ── tombstone helpers ─────────────────────────────────────────────────────
  #pruneTombstones() {
    const cutoff = this.now() - this.tombstoneTtlMs;
    for (const [key, value] of this.tombstones) {
      if ((value.settledAt || value.revokedAt || 0) < cutoff) this.tombstones.delete(key);
    }
    while (this.tombstones.size > this.maxTombstones) {
      const oldest = this.tombstones.keys().next();
      if (oldest.done) break;
      this.tombstones.delete(oldest.value);
    }
  }

  #remember(requestId, patch) {
    this.#pruneTombstones();
    const previous = this.tombstones.get(requestId) || {};
    const merged = { ...previous, ...patch };
    if (!merged.revokedAt) merged.revokedAt = this.now();
    this.tombstones.set(requestId, merged);
    return merged;
  }

  tombstone(requestId) {
    return this.tombstones.get(String(requestId || "")) || null;
  }

  /**
   * Is this task still wanted? Answers from the in-memory overlay first, then
   * from the durable ledger through the injected hook.
   */
  revocationFor(requestId, entry = null) {
    const key = String(requestId || "");
    if (!key) return null;
    const item = entry || this.pending.get(key) || this.inflight.get(key) || null;
    if (item?.revoked) return item.revoked;
    const known = this.tombstones.get(key);
    if (known?.cause) return { cause: known.cause, reason: known.reason || null, revokedAt: known.revokedAt };
    if (typeof this.isRevoked === "function") {
      try {
        const durable = this.isRevoked(key, item);
        if (durable) return durable;
      } catch { /* a broken hook must not make a task undeliverable */ }
    }
    return null;
  }

  // ── worker side ───────────────────────────────────────────────────────────
  /**
   * Worker side: hand one send to the phone and wait for its ack.
   *
   * The requestId is the LOGICAL identity of the send and is stable for the
   * whole life of a BullMQ job: attempts, retries, ACK loss, transport
   * timeouts, delayed retries and process restarts. Android dedupes on it, so
   * a redelivery can never become a second physical SMS — but only if this
   * method is idempotent for an id it already knows, which it now is:
   *
   *   already pending   -> attach the new waiter, keep the queued task
   *   already inflight  -> move it back to pending (redelivery): the phone
   *                        re-pulls, recognises the id and only re-acks
   *   already settled   -> replay the recorded outcome, send nothing
   */
  offer(requestId, item) {
    return new Promise((resolve, reject) => {
      const key = String(requestId);
      const waiter = { resolve, reject };

      // 1) Redelivery of a task this process is already tracking.
      const existing = this.pending.get(key) || this.inflight.get(key);
      if (existing) {
        existing.waiters.push(waiter);
        if (this.inflight.has(key)) {
          // The previous attempt gave up waiting (send_timeout) but the phone
          // may still hold the task. Hand it out again rather than minting a
          // new identity: Android answers with its existing terminal record.
          this.inflight.delete(key);
          this.pending.set(key, existing);
          existing.redeliveries = (existing.redeliveries || 0) + 1;
          existing.redeliveredAt = this.now();
        }
        try { this.onRedeliver?.(key, existing); } catch { /* observability only */ }
        return;
      }

      // 2) This exact task already reached a terminal state. Replay it.
      const known = this.tombstones.get(key);
      if (known?.outcome === "sent" || known?.outcome === "sent_after_revocation") {
        const at = known.settledAt ? new Date(known.settledAt).toISOString() : new Date(this.now()).toISOString();
        resolve({
          type: "sent",
          requestedTo: known.requestedTo || item.to,
          sentTo: known.sentTo || item.to,
          sentAfterRevocation: known.outcome === "sent_after_revocation",
          revocation: null,
          duplicate: true,
          submission: {
            submittedOnce: true,
            submittedAt: known.sentAt ? new Date(known.sentAt).toISOString() : at,
            verified: true,
            verificationStatus: "confirmed",
            verificationAttempts: 0
          },
          at
        });
        return;
      }
      if (known?.outcome === "superseded") {
        resolve({
          type: "superseded", superseded: true, requestId: key, status: "superseded",
          terminal: true, successful: false, duplicate: true, reason: known.reason || null,
          at: new Date(this.now()).toISOString()
        });
        return;
      }
      if (known?.outcome === "cancelled") {
        const cancelled = new Error(known.reason || "cancelled_by_consumer");
        cancelled.code = "SEND_CANCELLED";
        cancelled.statusCode = 409;
        reject(cancelled);
        return;
      }
      // A recorded device FAILURE is deliberately NOT replayed: that is a
      // genuine retry, and the phone decides whether its local record allows it.

      const entry = {
        requestId: key,
        to: item.to,
        text: item.text,
        priority: item.priority,
        // The consumer notification identity, used by the phone to validate
        // before submitting. Always an OBJECT (never null): the Android client
        // keys its local dedupe record off the task it receives, and a null
        // meta leaves it unable to track or acknowledge the task at all.
        meta: item.meta || EMPTY_TASK_META,
        ledgerId: item.ledgerId ?? null,
        jobId: item.jobId ?? null,
        waiters: [waiter],
        offeredAt: this.now(),
        claimedAt: null,
        revoked: null
      };

      // 3) The task may already be revoked before it is even offered (the
      //    invalidation won the race with the worker). Never queue it.
      const verdict = this.revocationFor(entry.requestId, entry);
      if (verdict) {
        this.#settleSuperseded(entry.requestId, entry, verdict);
        return;
      }

      // 4) A phone is already long-polling: wake it with this task immediately.
      const phone = this.waiters.shift();
      if (phone) {
        clearTimeout(phone.timer);
        this.inflight.set(entry.requestId, entry);
        entry.claimedAt = this.now();
        phone.resolve(this.#task(entry));
      } else {
        this.pending.set(entry.requestId, entry);
      }
      try { this.onOffer?.(entry.requestId, entry); } catch { /* ledger sync is best effort */ }
    });
  }

  /** 'pending' | 'inflight' | null — is this task still in the bridge? */
  tracks(requestId) {
    const key = String(requestId || "");
    if (!key) return null;
    if (this.inflight.has(key)) return "inflight";
    if (this.pending.has(key)) return "pending";
    return null;
  }

  /** Settle every worker waiting on this task exactly once. */
  #settleWaiters(entry, kind, payload) {
    const waiters = entry?.waiters || [];
    entry.waiters = [];
    for (const waiter of waiters) {
      try {
        if (kind === "resolve") waiter.resolve(payload);
        else waiter.reject(payload);
      } catch { /* the caller is gone; the ledger is still correct */ }
    }
  }

  /**
   * Drop the in-memory entry for a task whose job is over. The tombstone stays
   * so a late ACK is still recognised, but nothing may accumulate forever.
   */
  release(requestId) {
    const key = String(requestId || "");
    if (!key) return false;
    const entry = this.pending.get(key) || this.inflight.get(key) || null;
    if (!entry) return false;
    this.pending.delete(key);
    this.inflight.delete(key);
    this.#clearLease(key);
    // A released task has no outcome yet, and the phone may still be working on
    // it: keep the id so a late ACK is answered instead of discarded.
    this.#remember(key, { outcome: "released", settledAt: this.now() });
    const released = new Error("task_released");
    released.code = "ANDROID_TASK_RELEASED";
    released.statusCode = 409;
    this.#settleWaiters(entry, "reject", released);
    return true;
  }

  /**
   * Phone side: take the next queued send. Resolves null on timeout so the
   * phone long-polls without hammering the server.
   */
  take(waitMs = 25000) {
    this.lastPullAt = this.now();
    const next = this.#nextDeliverable();
    if (next) return Promise.resolve(next);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(null);
      }, Math.max(1000, Number(waitMs) || 25000));
      // Deliberately NOT unref'd: the long-poll timer is what wakes a device
      // that has nothing queued, exactly as before this change.
      const waiter = { resolve, timer };
      this.waiters.push(waiter);
    });
  }

  /**
   * Walk the pending queue oldest-first, dropping anything revoked. A revoked
   * task is terminalized as superseded instead of being handed to the phone --
   * this is the last gate before a stale reminder reaches a SIM.
   */
  #nextDeliverable() {
    for (;;) {
      const key = this.firstPendingKey();
      if (!key) return null;
      const item = this.pending.get(key);
      if (!item) continue;
      const verdict = this.revocationFor(key, item);
      if (verdict) {
        this.#settleSuperseded(key, item, verdict);
        continue;
      }
      return this.claim(key);
    }
  }

  /**
   * The exact wire shape the phone receives.
   *
   * `meta` is ALWAYS an object. The Messages client builds its local dedupe
   * record — the one that carries the gateway request id and therefore the
   * ability to acknowledge at all — inside `task.meta?.let { ... }`, so a null
   * meta produces a task it can send but never report. That is exactly how one
   * reminder became three physical SMS in production. Sends without consumer
   * notification metadata simply get an all-null object.
   */
  #task(entry) {
    return {
      requestId: entry.requestId,
      to: entry.to,
      text: entry.text,
      priority: entry.priority,
      meta: entry.meta || EMPTY_TASK_META
    };
  }

  /**
   * Phone accepted the task; it moves pending -> in-flight (still awaiting
   * its ack), NOT deleted — ack() resolves the worker from either map.
   */
  claim(requestId) {
    const item = this.pending.get(requestId);
    if (!item) return null;
    // Re-check inside claim so two racing pulls cannot slip a revoked task out.
    const verdict = this.revocationFor(requestId, item);
    if (verdict) {
      this.#settleSuperseded(requestId, item, verdict);
      return null;
    }
    this.inflight.set(requestId, item);
    this.pending.delete(requestId);
    item.claimedAt = this.now();
    try { this.onPull?.(requestId, item); } catch { /* observability only */ }
    return this.#task(item);
  }

  firstPendingKey() {
    let best = null;
    let bestAt = Infinity;
    for (const [key, value] of this.pending) {
      if (value.offeredAt < bestAt) { bestAt = value.offeredAt; best = key; }
    }
    return best;
  }

  // ── revocation ────────────────────────────────────────────────────────────
  /**
   * Revoke one gateway task.
   *
   * PENDING  -> removed from the queue and finished as superseded; the phone
   *             never sees it.
   * INFLIGHT -> flagged revoked and kept (identity preserved!) until Android
   *             answers or the lease expires, because the device may already
   *             hold the task locally.
   * UNKNOWN  -> a tombstone is still recorded so a task this process no longer
   *             remembers can never be answered "valid".
   */
  revokeRequest(requestId, { cause = "superseded", reason = null } = {}) {
    const key = String(requestId || "");
    if (!key) return { found: false, state: "unknown" };
    this.#remember(key, { cause, reason });

    const pendingItem = this.pending.get(key);
    if (pendingItem) {
      this.#settleSuperseded(key, pendingItem, { cause, reason, revokedAt: this.now() });
      return { found: true, state: "pending" };
    }
    const inflightItem = this.inflight.get(key);
    if (inflightItem) {
      if (!inflightItem.revoked) {
        inflightItem.revoked = { cause, reason, revokedAt: this.now() };
        this.#armLease(key, inflightItem);
      }
      return { found: true, state: "inflight" };
    }
    return { found: false, state: "unknown" };
  }

  /** Arm the bounded wait for an in-flight revoked task. */
  #armLease(requestId, entry) {
    if (this.leaseTimers.has(requestId)) return;
    const timer = setTimeout(() => {
      this.leaseTimers.delete(requestId);
      const current = this.inflight.get(requestId);
      if (!current) return;
      this.#settleSuperseded(requestId, current, current.revoked || { reason: "lease_expired" });
    }, this.leaseMs);
    timer.unref?.();
    this.leaseTimers.set(requestId, timer);
  }

  /** Finish a task as superseded (terminal, non-billable, non-retryable). */
  #settleSuperseded(requestId, entry, verdict) {
    this.pending.delete(requestId);
    this.inflight.delete(requestId);
    this.#clearLease(requestId);
    const reason = verdict?.reason || null;
    const cause = verdict?.cause || "superseded";
    this.#remember(requestId, { cause, reason, outcome: "superseded", settledAt: this.now() });

    // A plain consumer cancel keeps the historical SEND_CANCELLED rejection so
    // existing behaviour is unchanged; a lifecycle invalidation resolves as
    // superseded so BullMQ completes the job instead of retrying it.
    if (cause === "cancel") {
      const error = new Error(reason || "cancelled_by_consumer");
      error.code = "SEND_CANCELLED";
      error.statusCode = 409;
      error.superseded = false;
      this.#settleWaiters(entry, "reject", error);
      try { this.onSettle?.(requestId, "cancelled", entry, verdict); } catch { /* audit only */ }
      return;
    }
    this.#settleWaiters(entry, "resolve", {
      type: "superseded",
      superseded: true,
      requestId,
      status: "superseded",
      terminal: true,
      successful: false,
      reason,
      at: new Date(this.now()).toISOString()
    });
    try { this.onSettle?.(requestId, "superseded", entry, verdict); } catch { /* audit only */ }
  }

  #clearLease(requestId) {
    const timer = this.leaseTimers.get(requestId);
    if (!timer) return;
    clearTimeout(timer);
    this.leaseTimers.delete(requestId);
  }

  /**
   * Backwards-compatible boolean ack (existing callers/tests rely on it).
   * The route uses acknowledge() to also learn WHY it settled.
   */
  ack(requestId, ok, details = {}) {
    return this.acknowledge(requestId, ok, details).handled;
  }

  /**
   * Phone reports the SIM outcome; settles the worker's sendMessage promise.
   *
   * The DECISION is not made here. \`decideAck\` (src/ackStateMachine.js) owns the
   * whole matrix — memory, tombstones and the durable ledger row — so a retried
   * ACK, a restarted process and a genuinely revoked-then-sent race each get
   * their canonical answer and a process restart cannot change semantics.
   *
   * @returns {{handled: boolean, outcome: string|null, decision: object, fromDurable: boolean}}
   */
  acknowledge(requestId, ok, details = {}) {
    const key = String(requestId || "");
    const item = this.pending.get(key) || this.inflight.get(key) || null;
    const known = this.tombstones.get(key) || null;
    const settledOutcome = known && known.outcome && known.outcome !== "released" ? known.outcome : null;
    // A released task keeps its identity so a late report is answered from
    // durable state instead of being treated as an unknown id.
    const released = known?.outcome === "released";

    let durable = null;
    if (typeof this.durableLookup === "function") {
      try { durable = this.durableLookup(key); } catch { durable = null; }
    }

    const decision = decideAck({
      reported: { ...details, ok, outcome: details.outcome },
      memory: item ? (this.pending.has(key) ? "pending" : "inflight")
        : (settledOutcome ? "settled" : (released ? "released" : null)),
      memoryOutcome: settledOutcome,
      revoked: item?.revoked || (known?.cause ? { cause: known.cause, reason: known.reason || null } : null),
      durable
    });

    if (!decision.handled) {
      return { handled: false, outcome: null, decision, fromDurable: false };
    }

    const fromDurable = !item;

    if (item) {
      this.pending.delete(key);
      this.inflight.delete(key);
      this.#clearLease(key);
      this.#settleWaitersForDecision(key, item, decision);
    }

    // The tombstone is the replay record. Only a NEW fact is recorded; a replay
    // must leave it untouched so repeated ACKs keep answering the same way.
    if (decision.newlyRecorded) {
      this.#remember(key, {
        outcome: decision.outcome,
        reason: decision.reason || null,
        settledAt: this.now(),
        ...(decision.outcome === OUTCOME.SENT || decision.outcome === OUTCOME.SENT_AFTER_REVOCATION
          ? {
              requestedTo: details.requestedTo || item?.to || null,
              sentTo: details.sentTo || item?.to || null,
              sentAt: details.sentAt || this.now()
            }
          : {})
      });
    }

    // Exactly-once side effects: the audit fires only for a newly recorded fact.
    if (decision.newlyRecorded) {
      try { this.onSettle?.(key, decision.outcome, item, { ...details, decision, fromDurable }); } catch { /* audit only */ }
    }

    return { handled: true, outcome: decision.outcome, decision, fromDurable };
  }

  /** Settle the worker promise(s) with the state machine's canonical outcome. */
  #settleWaitersForDecision(requestId, entry, decision) {
    if (decision.outcome === OUTCOME.SENT || decision.outcome === OUTCOME.SENT_AFTER_REVOCATION) {
      this.#settleWaiters(entry, "resolve", {
        type: "sent",
        requestedTo: entry.to,
        sentTo: entry.to,
        sentAfterRevocation: decision.outcome === OUTCOME.SENT_AFTER_REVOCATION,
        revocation: decision.outcome === OUTCOME.SENT_AFTER_REVOCATION
          ? { reason: entry.revoked?.reason || null, cause: entry.revoked?.cause || null, revokedAt: entry.revoked?.revokedAt || null }
          : null,
        submission: {
          submittedOnce: true,
          submittedAt: new Date(this.now()).toISOString(),
          verified: true,
          verificationStatus: "confirmed",
          verificationAttempts: 0
        },
        at: new Date(this.now()).toISOString()
      });
      return;
    }
    if (decision.outcome === OUTCOME.SUPERSEDED) {
      this.#settleWaiters(entry, "resolve", {
        type: "superseded", superseded: true, requestId, status: "superseded",
        terminal: true, successful: false, reason: decision.reason || null,
        at: new Date(this.now()).toISOString()
      });
      return;
    }
    if (decision.outcome === OUTCOME.CANCELLED) {
      const cancelled = new Error(decision.reason || "cancelled_by_consumer");
      cancelled.code = "SEND_CANCELLED";
      cancelled.statusCode = 409;
      this.#settleWaiters(entry, "reject", cancelled);
      return;
    }
    const failed = new Error(decision.reason || "android_gateway_failed");
    failed.code = "ANDROID_GATEWAY_FAILED";
    failed.statusCode = 502;
    this.#settleWaiters(entry, "reject", failed);
  }

  // ── status surfaces ───────────────────────────────────────────────────────
  stats() {
    return {
      pending: this.pending.size,
      inflight: this.inflight.size,
      waitingPhones: this.waiters.length,
      lastPullAt: this.lastPullAt || null,
      revokedInflight: [...this.inflight.values()].filter((item) => item.revoked).length,
      redelivered: [...this.pending.values(), ...this.inflight.values()]
        .filter((item) => item.redeliveries).length,
      tombstones: this.tombstones.size
    };
  }

  /**
   * Readiness/status surface for the android transport. In pull mode the phone
   * dials OUT, so there is nothing to probe — liveness IS the long-poll:
   * a waiter open right now, or a pull seen within the liveness window
   * (ANDROID_PULL_LIVENESS_MS, default 90s = 3x the default 25s long-poll).
   *
   * The threshold is a property of THIS bridge, exposed as livenessMs, so no
   * endpoint has to re-declare the magic number and disagree with another.
   */
  readyState() {
    const stats = this.stats();
    const livenessMs = this.livenessMs;
    const lastPullAgeMs = stats.lastPullAt ? Math.max(0, this.now() - stats.lastPullAt) : null;
    const freshPull = lastPullAgeMs !== null && lastPullAgeMs < livenessMs;
    const paired = Boolean(stats.waitingPhones > 0 || freshPull);
    return {
      paired,
      state: paired ? "connected" : "stale",
      transport: "android-pull",
      reason: paired ? null : "no_recent_device_pull",
      lastPullAt: stats.lastPullAt ? new Date(stats.lastPullAt).toISOString() : null,
      lastPullAgeMs,
      livenessMs,
      pending: stats.pending,
      inflight: stats.inflight,
      waitingPhones: stats.waitingPhones,
      revokedInflight: stats.revokedInflight,
      redelivered: stats.redelivered,
      tombstones: stats.tombstones
    };
  }

  status() { return this.readyState(); }
  statusForDashboard() { return this.readyState(); }
  async recover() {
    const state = this.readyState();
    if (!state.paired) {
      const err = new Error("android gateway: no device is long-polling; cannot recover remotely");
      err.code = "ANDROID_GATEWAY_UNREACHABLE";
      err.statusCode = 503;
      throw err;
    }
    return state;
  }

  /**
   * Worker-facing shim so the BullMQ processor can call outbox.sendMessage()
   * exactly like the HTTP clients. Hands the task to the phone and resolves
   * with the GMweb "sent" event shape when the device acks success — or with
   * {superseded:true} when a lifecycle invalidation got there first.
   */
  sendMessage({ to, text, priority, onStage, meta = null, ledgerId = null,
                jobId = null, requestId = null, shouldCancel = null } = {}) {
    const id = requestId || `pull_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    if (typeof shouldCancel === "function" && shouldCancel()) {
      // Historical behaviour for /send/cancel races: the worker turns this into
      // a 'cancelled' ledger row, exactly as the chrome transport does.
      const error = new Error("cancelled_by_consumer");
      error.code = "SEND_CANCELLED";
      error.statusCode = 409;
      return Promise.reject(error);
    }
    onStage?.("phone_pull_queued");
    return this.offer(id, { to, text, priority: priority || "announcement", meta, ledgerId, jobId });
  }
}

module.exports = { AndroidOutbox };
