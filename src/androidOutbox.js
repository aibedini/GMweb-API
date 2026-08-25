// Outbox for the android transport in PULL mode: the phone dials OUT to the
// VPS (no tunnel, no inbound port, survives Iran-side IP churn), picks up
// queued sends, delivers them over the SIM, and acks the result.
//
// Flow:
//   POST /send (Eve) -> BullMQ job -> worker sees transport=android+pull
//     -> sendMessage() offers the task into this outbox and waits
//   Phone loop:  GET  /gateway/pull   -> { task:{requestId,to,text} } | {task:null}
//                POST /gateway/ack    -> resolves/fails that waiting promise,
//                                        which drives ledger + SSE/webhooks
//
// Lifecycle: pending (offered) -> in-flight (claimed by a phone) -> acked.
//
// ponytail: single-process in-memory bridge — BullMQ is already the durable
// layer; the outbox only connects the worker to whichever device is polling.
class AndroidOutbox {
  constructor() {
    this.pending = new Map();   // offered, not yet claimed by a phone
    this.inflight = new Map();  // claimed by a phone, awaiting its ack
    this.waiters = [];          // long-poll resolvers waiting for work
    this.lastPullAt = 0;        // last time ANY device long-polled us
  }

  /** Worker side: hand one send to the phone and wait for its ack. */
  offer(requestId, item) {
    return new Promise((resolve, reject) => {
      const waiter = this.waiters.shift();
      const entry = {
        to: item.to,
        text: item.text,
        priority: item.priority,
        resolve,
        reject,
        offeredAt: Date.now()
      };
      if (waiter) {
        // A phone is already long-polling: wake it with this task immediately.
        clearTimeout(waiter.timer);
        waiter.resolve({ requestId, ...entry });
        this.inflight.set(requestId, entry);
      } else {
        this.pending.set(requestId, entry);
      }
    });
  }

  /**
   * Phone side: take the next queued send. Resolves null on timeout so the
   * phone long-polls without hammering the server.
   */
  take(waitMs = 25000) {
    this.lastPullAt = Date.now();
    const oldestKey = this.firstPendingKey();
    if (oldestKey) return Promise.resolve(this.claim(oldestKey));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        resolve(null);
      }, Math.max(1000, Number(waitMs) || 25000));
      const waiter = { resolve, timer };
      this.waiters.push(waiter);
    });
  }

  /**
   * Phone accepted the task; it moves pending -> in-flight (still awaiting
   * its ack), NOT deleted — ack() resolves the worker from either map.
   */
  claim(requestId) {
    const item = this.pending.get(requestId);
    if (!item) return null;
    this.inflight.set(requestId, item);
    this.pending.delete(requestId);
    return { requestId, to: item.to, text: item.text, priority: item.priority };
  }

  firstPendingKey() {
    let best = null;
    let bestAt = Infinity;
    for (const [key, value] of this.pending) {
      if (value.offeredAt < bestAt) { bestAt = value.offeredAt; best = key; }
    }
    return best;
  }

  /** Phone reports the SIM outcome; settles the worker's sendMessage promise. */
  ack(requestId, ok, details = {}) {
    const item = this.pending.get(requestId) || this.inflight.get(requestId);
    if (!item) return false;
    this.pending.delete(requestId);
    this.inflight.delete(requestId);
    if (ok) {
      item.resolve({
        type: "sent",
        requestedTo: details.requestedTo || item.to,
        sentTo: details.sentTo || item.to,
        submission: {
          submittedOnce: true,
          submittedAt: details.sentAt ? new Date(details.sentAt).toISOString() : new Date().toISOString(),
          verified: true,
          verificationStatus: "confirmed",
          verificationAttempts: 0
        },
        at: new Date().toISOString()
      });
    } else {
      const error = new Error(details.error || details.reason || `android_gateway_${details.status || "failed"}`);
      error.code = details.cancelled ? "SEND_CANCELLED" : "ANDROID_GATEWAY_FAILED";
      error.statusCode = 502;
      item.reject(error);
    }
    return true;
  }

  stats() {
    return {
      pending: this.pending.size,
      inflight: this.inflight.size,
      waitingPhones: this.waiters.length,
      lastPullAt: this.lastPullAt || null
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
    const freshPull = stats.lastPullAt && (Date.now() - stats.lastPullAt) < 90000;
    const paired = Boolean(stats.waitingPhones > 0 || freshPull);
    return {
      paired,
      transport: "android-pull",
      reason: paired ? null : "no_device_polling",
      lastPullAt: stats.lastPullAt ? new Date(stats.lastPullAt).toISOString() : null,
      pending: stats.pending,
      inflight: stats.inflight,
      waitingPhones: stats.waitingPhones
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
   * with the GMweb "sent" event shape when the device acks success.
   */
  sendMessage({ to, text, priority, onStage }) {
    const requestId = `pull_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    onStage?.("phone_pull_queued");
    return this.offer(requestId, { to, text, priority: priority || "announcement" });
  }
}

module.exports = { AndroidOutbox };
