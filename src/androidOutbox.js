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
    this.now = hooks.now || Date.now;
    // How long an in-flight revoked task waits for the phone's answer before it
    // is terminalized as superseded. Bounded so the worker's promise, the
    // BullMQ job and the ledger never hang on an offline device.
    this.leaseMs = Math.max(1000, Number(hooks.leaseMs) || 120000);
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
  /** Worker side: hand one send to the phone and wait for its ack. */
  offer(requestId, item) {
    return new Promise((resolve, reject) => {
      const entry = {
        requestId: String(requestId),
        to: item.to,
        text: item.text,
        priority: item.priority,
        // Consumer notification identity travels WITH the task so /gateway/pull
        // can hand Android everything it needs to validate before sending.
        meta: item.meta || null,
        ledgerId: item.ledgerId ?? null,
        jobId: item.jobId ?? null,
        resolve,
        reject,
        offeredAt: this.now(),
        claimedAt: null,
        revoked: null
      };

      // 1) The task may already be revoked before it is even offered (the
      //    invalidation won the race with the worker). Never queue it.
      const verdict = this.revocationFor(entry.requestId, entry);
      if (verdict) {
        this.#settleSuperseded(entry.requestId, entry, verdict);
        return;
      }

      // 2) A phone is already long-polling: wake it with this task immediately.
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        this.inflight.set(entry.requestId, entry);
        entry.claimedAt = this.now();
        waiter.resolve(this.#task(entry));
      } else {
        this.pending.set(entry.requestId, entry);
      }
      try { this.onOffer?.(entry.requestId, entry); } catch { /* ledger sync is best effort */ }
    });
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

  /** The exact wire shape the phone receives. Legacy tasks have meta:null. */
  #task(entry) {
    return {
      requestId: entry.requestId,
      to: entry.to,
      text: entry.text,
      priority: entry.priority,
      meta: entry.meta || null
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
      try { entry.reject(error); } catch { /* already settled */ }
      try { this.onSettle?.(requestId, "cancelled", entry, verdict); } catch { /* audit only */ }
      return;
    }
    try {
      entry.resolve({
        type: "superseded",
        superseded: true,
        requestId,
        status: "superseded",
        terminal: true,
        successful: false,
        reason,
        at: new Date(this.now()).toISOString()
      });
    } catch { /* already settled */ }
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
   * Returns { handled, outcome } where outcome is one of
   * sent | sent_after_revocation | superseded | cancelled | failed.
   */
  acknowledge(requestId, ok, details = {}) {
    const key = String(requestId || "");
    const item = this.pending.get(key) || this.inflight.get(key);
    const outcome = details.outcome || (ok ? "sent" : "failed");

    if (!item) {
      // Unknown id. It may be a task this process already settled and forgot
      // (restart, lease expiry) — the tombstone decides how to answer.
      const known = this.tombstone(key);
      if (!known) return { handled: false, outcome: null };
      if (ok || outcome === "sent") {
        // Physical truth arrived after the gateway had already given up on it.
        try { this.onSettle?.(key, "sent_after_revocation", null, { ...details, tombstone: known }); } catch { /* audit only */ }
        this.#remember(key, { outcome: "sent_after_revocation", settledAt: this.now() });
        return { handled: true, outcome: "sent_after_revocation" };
      }
      return { handled: true, outcome: "superseded" };
    }

    this.pending.delete(key);
    this.inflight.delete(key);
    this.#clearLease(key);

    // Order matters. An explicit "superseded" outcome is the phone confirming
    // it did NOT send. A revoked task whose attempt failed for an unrelated
    // reason must not be retried either. But a revoked task that reports a REAL
    // successful submission is the impossible-unsend case and must fall through
    // to the success branch below, flagged — never downgraded to "cancelled".
    if (outcome === "superseded" || (!ok && item.revoked)) {
      const reason = details.reason || item.revoked?.reason || null;
      this.#remember(key, {
        cause: item.revoked?.cause || "superseded",
        reason, outcome: "superseded", settledAt: this.now()
      });
      if (item.revoked?.cause === "cancel") {
        const error = new Error(reason || "cancelled_by_consumer");
        error.code = "SEND_CANCELLED";
        error.statusCode = 409;
        try { item.reject(error); } catch { /* settled */ }
        try { this.onSettle?.(key, "cancelled", item, details); } catch { /* audit */ }
        return { handled: true, outcome: "cancelled" };
      }
      try {
        item.resolve({
          type: "superseded", superseded: true, requestId: key, status: "superseded",
          terminal: true, successful: false, reason, at: new Date(this.now()).toISOString()
        });
      } catch { /* settled */ }
      try { this.onSettle?.(key, "superseded", item, details); } catch { /* audit */ }
      return { handled: true, outcome: "superseded" };
    }

    if (ok) {
      const sentAfterRevocation = Boolean(item.revoked);
      this.#remember(key, {
        cause: item.revoked?.cause || null,
        reason: item.revoked?.reason || null,
        outcome: sentAfterRevocation ? "sent_after_revocation" : "sent",
        settledAt: this.now()
      });
      item.resolve({
        type: "sent",
        requestedTo: details.requestedTo || item.to,
        sentTo: details.sentTo || item.to,
        // The voucher for the late-ack audit: a revoked task that physically
        // went out anyway must never be reported as a clean cancellation.
        sentAfterRevocation,
        revocation: sentAfterRevocation
          ? { reason: item.revoked?.reason || null, cause: item.revoked?.cause || null, revokedAt: item.revoked?.revokedAt || null }
          : null,
        submission: {
          submittedOnce: true,
          submittedAt: details.sentAt ? new Date(details.sentAt).toISOString() : new Date(this.now()).toISOString(),
          verified: true,
          verificationStatus: "confirmed",
          verificationAttempts: 0
        },
        at: new Date(this.now()).toISOString()
      });
      try { this.onSettle?.(key, sentAfterRevocation ? "sent_after_revocation" : "sent", item, details); } catch { /* audit */ }
      return { handled: true, outcome: sentAfterRevocation ? "sent_after_revocation" : "sent" };
    }

    const error = new Error(details.error || details.reason || `android_gateway_${details.status || "failed"}`);
    error.code = details.cancelled ? "SEND_CANCELLED" : "ANDROID_GATEWAY_FAILED";
    error.statusCode = 502;
    this.#remember(key, { outcome: "failed", settledAt: this.now() });
    try { item.reject(error); } catch { /* settled */ }
    try { this.onSettle?.(key, "failed", item, details); } catch { /* audit */ }
    return { handled: true, outcome: "failed" };
  }

  // ── status surfaces ───────────────────────────────────────────────────────
  stats() {
    return {
      pending: this.pending.size,
      inflight: this.inflight.size,
      waitingPhones: this.waiters.length,
      lastPullAt: this.lastPullAt || null,
      revokedInflight: [...this.inflight.values()].filter((item) => item.revoked).length,
      tombstones: this.tombstones.size
    };
  }

  /**
   * Readiness/status surface for the android transport. In pull mode the phone
   * dials OUT, so there is nothing to probe — liveness IS the long-poll:
   * a waiter open right now, or a pull seen within the last 90s (3x the
   * default 25s long-poll). Mirrors the shape GoogleMessagesClient.status()
   * returns so server.js call sites stay uniform.
   */
  readyState() {
    const stats = this.stats();
    const freshPull = stats.lastPullAt && (this.now() - stats.lastPullAt) < 90000;
    const paired = Boolean(stats.waitingPhones > 0 || freshPull);
    return {
      paired,
      transport: "android-pull",
      reason: paired ? null : "no_device_polling",
      lastPullAt: stats.lastPullAt ? new Date(stats.lastPullAt).toISOString() : null,
      pending: stats.pending,
      inflight: stats.inflight,
      waitingPhones: stats.waitingPhones,
      revokedInflight: stats.revokedInflight,
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
