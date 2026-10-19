"use strict";

/**
 * Per-agent long-poll waiters for POST /api/v1/agent/commands/claim.
 *
 * The waiter never claims by itself: it calls the SAME synchronous claim
 * callback the route used before waiting, so the command engine's conditional
 * `UPDATE ... WHERE state='QUEUED'` remains the only delivery gate. A waiter
 * can therefore be replaced, time out or lose a race without ever handing the
 * same command row to two callers.
 *
 * At most one waiter exists per agentId. Registering a new one resolves the
 * previous waiter with the normal empty result. The safety re-check every
 * `recheckMs` covers commands inserted by a producer that does not call
 * `notify()` (for example a direct SQLite writer).
 */

const MAX_WAIT_MS = 25_000;
const RECHECK_MS = 2_000;
const MAX_WAITERS = 500;

/**
 * Coerce an optional query value into a bounded wait.
 * Absent, 0, negative, fractional and non-numeric values return 0, which the
 * route treats as "do not wait" (today's behaviour).
 */
function clampWaitMs(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return 0;
  return Math.min(n, MAX_WAIT_MS);
}

class ClaimWaiters {
  constructor({ maxWaiters = MAX_WAITERS, recheckMs = RECHECK_MS, now = Date.now } = {}) {
    this.maxWaiters = Math.max(1, Number(maxWaiters) || MAX_WAITERS);
    this.recheckMs = Math.max(10, Number(recheckMs) || RECHECK_MS);
    this.now = now;
    this.waiters = new Map(); // agentId -> waiter
    this.closed = false;
  }

  /** Number of currently suspended requests. */
  get size() {
    return this.waiters.size;
  }

  /**
   * Suspend until `claim()` returns a non-empty array, the deadline expires,
   * the waiter is replaced, the request disconnects, or the server closes.
   *
   * @param {string} agentId key used by the route's claim call
   * @param {number} waitMs already-clamped wait in milliseconds
   * @param {() => object[]} claim MUST be the same claim used before waiting
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<{commands: object[], reason: string}>}
   */
  wait(agentId, waitMs, claim, { signal } = {}) {
    const key = String(agentId);
    const bounded = Math.min(Math.max(0, Math.trunc(Number(waitMs) || 0)), MAX_WAIT_MS);

    if (bounded <= 0) return Promise.resolve({ commands: [], reason: "immediate" });
    if (this.closed) return Promise.resolve({ commands: [], reason: "shutdown" });
    if (signal?.aborted) return Promise.resolve({ commands: [], reason: "disconnected" });

    const existing = this.waiters.get(key);
    if (existing) {
      this.#finish(existing, [], "replaced");
    } else if (this.waiters.size >= this.maxWaiters) {
      // Capacity is a refusal to wait, not an error: the route returns the
      // same empty body it would have returned before this change.
      return Promise.resolve({ commands: [], reason: "capacity" });
    }

    // Close the gap between the route's first claim and registration: a
    // command inserted in between would otherwise wait for the 2 s re-check.
    // This runs synchronously, so no enqueue can interleave before the map
    // entry below exists.
    let immediate = [];
    try {
      immediate = claim() || [];
    } catch {
      immediate = [];
    }
    if (Array.isArray(immediate) && immediate.length > 0) {
      return Promise.resolve({ commands: immediate, reason: "claimed" });
    }

    return new Promise((resolve) => {
      const waiter = {
        key,
        claim,
        resolve,
        settled: false,
        busy: false,
        deadline: this.now() + bounded,
        timer: null,
        recheck: null,
        signal: signal || null,
        abort: null,
      };
      this.waiters.set(key, waiter);

      const finish = (commands, reason) => this.#finish(waiter, commands, reason);
      const check = () => {
        if (waiter.settled || waiter.busy) return;
        waiter.busy = true;
        let commands;
        try {
          commands = claim() || [];
        } catch {
          // A transient store error must not turn a held request into an
          // unhandled rejection. The next notify/re-check tries again.
          commands = [];
        } finally {
          waiter.busy = false;
        }
        if (!Array.isArray(commands)) commands = [];
        if (commands.length > 0) {
          finish(commands, "claimed");
          return;
        }
        if (this.now() >= waiter.deadline) finish([], "timeout");
      };
      waiter.check = check;

      waiter.recheck = setInterval(check, this.recheckMs);
      waiter.timer = setTimeout(() => {
        check();
        if (!waiter.settled) finish([], "timeout");
      }, bounded);

      if (signal) {
        waiter.abort = () => finish([], "disconnected");
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
    });
  }

  /** Wake the waiter for this agent, if any. Returns false when none exists. */
  notify(agentId) {
    const waiter = this.waiters.get(String(agentId));
    if (!waiter || waiter.settled) return false;
    waiter.check();
    return true;
  }

  /** Resolve every held request with the normal empty body; used by onClose. */
  shutdown() {
    this.closed = true;
    for (const waiter of [...this.waiters.values()]) {
      this.#finish(waiter, [], "shutdown");
    }
  }

  #finish(waiter, commands, reason) {
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    clearInterval(waiter.recheck);
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener("abort", waiter.abort);
    }
    if (this.waiters.get(waiter.key) === waiter) this.waiters.delete(waiter.key);
    waiter.resolve({ commands, reason });
  }
}

module.exports = { ClaimWaiters, clampWaitMs, MAX_WAIT_MS, MAX_WAITERS, RECHECK_MS };
