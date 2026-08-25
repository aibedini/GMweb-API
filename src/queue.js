const { Queue, Worker, QueueEvents } = require("bullmq");
const { normalizeSendPriority, priorityForJob } = require("./sendPriority");

const QUEUE_NAME = "gmweb-send";
const DEFERRED_HIGH_KEY = "gmweb-send:deferred-high";
const SUCCESS_SEQUENCE_KEY = "gmweb-send:success-sequence";
const HIGH_DEFER_DELAY_MS = 365 * 24 * 60 * 60 * 1000;

// Shared Redis connection options. `maxRetriesPerRequest: null` is required by
// BullMQ for the blocking connections used by Worker and QueueEvents.
const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
  // Optional Redis authentication/TLS for managed or hardened Redis. Omitted
  // when unset, so the default (no auth, plaintext to localhost) is unchanged.
  ...(process.env.REDIS_USERNAME ? { username: process.env.REDIS_USERNAME } : {}),
  ...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {}),
  ...(["1", "true", "yes", "on"].includes(String(process.env.REDIS_TLS || "").toLowerCase()) ? { tls: {} } : {})
};

class SendQueue {
  constructor() {
    this.queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        // Keep recent history for the dashboard; auto-prune the rest.
        removeOnComplete: { age: 86400, count: 1000 },   // 1 day / 1000 jobs
        removeOnFail: { age: 604800, count: 1000 }         // 7 days / 1000 jobs
      }
    });
    this.events = new QueueEvents(QUEUE_NAME, { connection });
    this.worker = null;
  }

  enqueue(data, opts = {}) {
    return this.queue.add("send", data, opts);
  }

  async deferBySuccesses(data, successes = 10) {
    const client = await this._redis();
    const sequence = Number(await client.get(SUCCESS_SEQUENCE_KEY)) || 0;
    const priority = normalizeSendPriority(data?.priority || data?.priorityLevel);
    const job = await this.enqueue({
      ...data,
      priority: priority.name,
      priorityLevel: priority.level,
      deferCount: Number(data?.deferCount || 0) + 1
    }, {
      // Keep a real BullMQ job so the ledger and dashboard remain durable.
      delay: HIGH_DEFER_DELAY_MS,
      priority: priority.level
    });
    const releaseAt = sequence + Math.max(1, Number(successes) || 10);
    await client.zadd(DEFERRED_HIGH_KEY, releaseAt, String(job.id));
    return { job, releaseAt };
  }

  deferNormal(data, successes = 10) {
    return this.deferBySuccesses(data, successes);
  }

  deferUntil(data, releaseAt, reason = "scheduled", { priority: requestedPriority } = {}) {
    const releaseMs = releaseAt instanceof Date ? releaseAt.getTime() : Number(releaseAt);
    const delay = Math.max(1000, releaseMs - Date.now());
    const priority = normalizeSendPriority(requestedPriority || data?.priority || data?.priorityLevel);
    return this.enqueue({
      ...data,
      priority: priority.name,
      priorityLevel: priority.level,
      deferReason: reason,
      deferCount: Number(data?.deferCount || 0) + 1
    }, { delay, priority: priority.level });
  }

  async deferHigh(data, successes = 10) {
    return this.deferBySuccesses({ ...data, priority: "critical", priorityLevel: 1 }, successes);
  }

  async recordSuccessAndReleaseHigh() {
    const client = await this._redis();
    const sequence = Number(await client.incr(SUCCESS_SEQUENCE_KEY));

    // Check if there are any waiting jobs left.
    // Pending sends live across waiting/paused/prioritized buckets (see counts).
    const counts = await this.queue.getJobCounts("waiting", "paused", "prioritized");
    const waitingCount = (counts.waiting || 0) + (counts.paused || 0) + (counts.prioritized || 0);

    let due;
    if (waitingCount === 0) {
      // If there are no waiting jobs, we release ALL deferred jobs because otherwise
      // they would be stuck forever waiting for a sequence increment that will never come!
      due = await client.zrange(DEFERRED_HIGH_KEY, 0, -1);
    } else {
      // Release at most one due deferred retry per progress step so a
      // group of deferred highs cannot form a new burst.
      due = await client.zrangebyscore(DEFERRED_HIGH_KEY, "-inf", sequence, "LIMIT", 0, 1);
    }

    if (!due.length) return { sequence, released: null };

    let promotedJob = null;
    for (const id of due) {
      try {
        const job = await this.queue.getJob(id);
        if (job) {
          const state = await job.getState().catch(() => "");
          if (state === "delayed") {
            await job.promote();
          }
          if (!promotedJob) {
            promotedJob = job;
          }
        }
      } catch (err) {
        // Safe catch
      }
      await client.zrem(DEFERRED_HIGH_KEY, id);

      // If there are waiting jobs, we only release one/first.
      if (waitingCount > 0) {
        break;
      }
    }

    return { sequence, released: promotedJob || null };
  }

  async forgetDeferredHigh(id) {
    const client = await this._redis();
    await client.zrem(DEFERRED_HIGH_KEY, String(id));
  }

  // --- Idempotency (dedupe POST /send retries) ---------------------------
  // Backed by the same Redis as the queue. A key reserves an in-flight send;
  // once enqueued we store the jobId so a retry returns the original job.
  async _redis() {
    return this.queue.client; // BullMQ resolves this to the ioredis connection
  }

  // Atomically reserve a key. Returns "OK" if newly reserved, null if it
  // already exists (a duplicate). Stored value starts as `pending:<hash>`.
  async reserveIdempotency(key, bodyHash, ttlSec = 86400) {
    const c = await this._redis();
    return c.set(`idem:${key}`, `pending:${bodyHash}`, "EX", ttlSec, "NX");
  }

  // Finalize a reserved key with the real jobId.
  async setIdempotencyJob(key, jobId, bodyHash, ttlSec = 86400) {
    const c = await this._redis();
    await c.set(`idem:${key}`, `${jobId}:${bodyHash}`, "EX", ttlSec);
  }

  // Returns { jobId|null, bodyHash, pending } for an existing key, or null.
  async getIdempotency(key) {
    const c = await this._redis();
    const val = await c.get(`idem:${key}`);
    if (!val) return null;
    if (val.startsWith("pending:")) return { jobId: null, bodyHash: val.slice(8), pending: true };
    const idx = val.lastIndexOf(":");
    return { jobId: val.slice(0, idx), bodyHash: val.slice(idx + 1), pending: false };
  }

  async releaseIdempotency(key) {
    const c = await this._redis();
    await c.del(`idem:${key}`).catch(() => {});
  }

  // --- Automatic content de-dupe ------------------------------------------
  // Suppresses an identical {to,text} re-sent within a short window even when
  // the caller forgot an Idempotency-Key (observed: a consumer double-POSTing
  // the same SMS seconds apart). Atomic SET NX reserves the content hash.
  async reserveDedupe(hash, ttlSec) {
    const c = await this._redis();
    return c.set(`dd:${hash}`, "pending", "EX", ttlSec, "NX"); // "OK" if new, null if dup
  }

  async setDedupeJob(hash, jobId, ttlSec) {
    const c = await this._redis();
    await c.set(`dd:${hash}`, String(jobId), "EX", ttlSec);
  }

  async getDedupe(hash) {
    const c = await this._redis();
    return c.get(`dd:${hash}`);
  }

  async releaseDedupe(hash) {
    const c = await this._redis();
    await c.del(`dd:${hash}`).catch(() => {});
  }

  getJob(id) {
    return this.queue.getJob(id);
  }

  async jobStatus(id) {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    const state = await job.getState();
    const priority = priorityForJob(job);
    return {
      id: job.id,
      state,                                    // waiting | active | completed | failed | delayed
      to: job.data?.to,
      priority: priority.name,
      priorityLevel: priority.level,
      attemptsMade: job.attemptsMade,
      maxAttempts: job.opts?.attempts || 1,
      result: job.returnvalue || null,
      failedReason: job.failedReason || null,
      createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
      processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
      finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
    };
  }

  async counts() {
    // "prioritized" is a real BullMQ v5 state: jobs added with an explicit
    // priority land in a sorted set instead of the plain wait list. Before
    // 0.3.38 every counter/list here ignored it, so hundreds of perfectly
    // queued sends showed as an EMPTY queue and could not be cancelled.
    const counts = await this.queue.getJobCounts("waiting", "paused", "active", "completed", "failed", "delayed", "prioritized");
    // BullMQ moves waiting jobs into its `paused` bucket while a queue is
    // paused, and priority-lane jobs into `prioritized`. All are still
    // pending sends, so expose waiting as the total pending count.
    return {
      ...counts,
      waiting: (counts.waiting || 0) + (counts.paused || 0) + (counts.prioritized || 0)
    };
  }

  pause() {
    return this.queue.pause();
  }

  resume() {
    return this.queue.resume();
  }

  isPaused() {
    return this.queue.isPaused();
  }

  // List jobs in actual processing order for the dashboard queue panel:
  // active first, then the jobs the worker will pop next, then delayed jobs.
  // BullMQ's wait list is consumed from the tail, so asc=true is essential;
  // newest-first hides LIFO/admin-promoted jobs at the bottom of long queues.
  // Returns a light shape — no full message body, just a preview.
  async listJobs({ states = ["active", "waiting", "paused", "delayed", "prioritized"], limit = 100 } = {}) {
    const jobs = [];
    const unlimited = limit == null;
    let remaining = unlimited ? Infinity : Math.max(0, limit);
    for (const state of states) {
      if (remaining === 0) break;
      const stateJobs = await this.queue.getJobs([state], 0, unlimited ? -1 : remaining - 1, true);
      jobs.push(...stateJobs.map((job) => ({ job, state })));
      if (!unlimited) remaining -= stateJobs.length;
    }
    const out = [];
    for (const entry of jobs) {
      const { job, state } = entry;
      if (!job) continue;
      const priority = priorityForJob(job);
      out.push({
        id: job.id,
        state,
        to: job.data?.to || null,
        textPreview: String(job.data?.text || "").replace(/\s+/g, " ").slice(0, 80),
        keyName: job.data?.keyName || null,
        priority: priority.name,
        priorityLevel: priority.level,
        attemptsMade: job.attemptsMade || 0,
        maxAttempts: job.opts?.attempts || 1,
        failedReason: job.failedReason || null,
        createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
        processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        delayUntil: job.delay ? new Date(job.timestamp + job.delay).toISOString() : null,
        deferReason: job.data?.deferReason || null,
        deferCount: Number(job.data?.deferCount || 0)
      });
    }
    return out;
  }

  // Count across the complete pending queue, not just the dashboard's visible
  // page. A queue may have hundreds of waiting jobs before its deferred CRITICAL
  // entries, and deriving this count from the first 100 makes the release
  // button incorrectly show zero and become disabled.
  async countDeferredHighJobs() {
    const jobs = await this.queue.getJobs(["waiting", "paused", "delayed", "prioritized"], 0, -1, false);
    let count = 0;
    for (const job of jobs) {
      if (!job) continue;
      const state = await job.getState().catch(() => "unknown");
      const high = priorityForJob(job).name === "critical";
      const deferred = state === "delayed" ||
        Number(job.data?.deferCount || 0) > 0 ||
        Boolean(job.data?.deferReason);
      if (high && state !== "active" && deferred) count += 1;
    }
    return count;
  }

  async countPendingByPriority(priorityName) {
    const counts = await this.pendingCountsByPriority();
    return counts[normalizeSendPriority(priorityName).name] || 0;
  }

  async pendingCountsByPriority() {
    const jobs = await this.queue.getJobs(["active", "waiting", "paused", "delayed", "prioritized"], 0, -1, false);
    const counts = { critical: 0, expired: 0, expiring: 0, announcement: 0 };
    for (const job of jobs) {
      if (job) counts[priorityForJob(job).name] += 1;
    }
    return counts;
  }

  async queuePositionForPriority(priorityName, excludeJobId = null) {
    const requested = normalizeSendPriority(priorityName);
    const active = await this.queue.getJobs(["active"], 0, -1, false);
    const pending = await this.queue.getJobs(["waiting", "paused", "prioritized"], 0, -1, false);
    const ahead = pending.filter((job) => job && String(job.id) !== String(excludeJobId) && priorityForJob(job).level <= requested.level).length;
    return active.length + ahead;
  }

  // Internal-only full payloads used to migrate pre-ledger Redis backlog into
  // SQLite. Never return this shape directly from an HTTP route (it contains
  // complete message text and idempotency metadata).
  async pendingJobsForLedger(limit = 1000) {
    const jobs = await this.queue.getJobs(["active", "waiting", "paused", "delayed", "prioritized"], 0, Math.max(0, limit - 1), false);
    const out = [];
    for (const job of jobs) {
      if (!job) continue;
      const priority = priorityForJob(job);
      out.push({
        jobId: String(job.id),
        state: await job.getState().catch(() => "waiting"),
        to: job.data?.to || "",
        text: job.data?.text || "",
        keyName: job.data?.keyName || null,
        priority: priority.name,
        priorityLevel: priority.level,
        idempotencyKey: job.data?._idempotencyKey || null,
        attempts: job.attemptsMade || 0,
        createdAt: job.timestamp || Date.now(),
        processedAt: job.processedOn || null,
        failedReason: job.failedReason || null
      });
    }
    return out;
  }

  // Bump a waiting/delayed job to the front of the highest-priority lane.
  // Returns the new job id, or null if the job is gone / already running.
  async promoteJob(id) {
    const job = await this.queue.getJob(id);
    if (!job) return null;
    const state = await job.getState().catch(() => "unknown");
    if (!["waiting", "delayed", "prioritized"].includes(state)) {
      return { promoted: false, reason: `job is ${state}`, state };
    }
    const data = { ...job.data, priority: "critical", priorityLevel: 1 };
    // An explicit admin promotion means "send this next", even when the job
    // was previously delayed or is currently inside quiet hours.
    delete data.deferCount;
    delete data.deferReason;
    await this.forgetDeferredHigh(id);
    await job.remove();
    // BullMQ keeps prioritized jobs in a sorted set where `lifo` does not
    // guarantee the front. An explicit admin "send next" is therefore added
    // to the unprioritized wait-list front; its canonical data remains CRITICAL.
    const fresh = await this.queue.add("send", data, { lifo: true });
    return { promoted: true, id: fresh.id, previousId: String(id), state: "waiting", _data: data };
  }

  // Change the lane without replacing the BullMQ job id. `changePriority`
  // updates waiting/prioritized jobs in-place and also persists the priority
  // field used when a delayed job becomes runnable later.
  async changeJobPriority(id, requestedPriority) {
    const job = await this.queue.getJob(id);
    if (!job) return { changed: false, reason: "not_found", state: null };
    const state = await job.getState().catch(() => "unknown");
    if (!["waiting", "paused", "delayed", "prioritized"].includes(state)) {
      return { changed: false, reason: state === "active" ? "active" : "not_pending", state };
    }
    const previous = priorityForJob(job);
    const priority = normalizeSendPriority(requestedPriority);
    const data = { ...job.data, priority: priority.name, priorityLevel: priority.level };
    await job.updateData(data);
    await job.changePriority({ priority: priority.level });
    return {
      changed: true,
      id: String(job.id),
      state,
      previousPriority: previous.name,
      priority: priority.name,
      priorityLevel: priority.level
    };
  }

  // Release every CRITICAL job that has previously been deferred. The queue is
  // paused while jobs are reinserted so the worker cannot consume a partially
  // reordered batch. Reinsert oldest-first to preserve FIFO within the lane.
  async releaseDeferredHighJobs() {
    const wasPaused = await this.isPaused();
    if (!wasPaused) await this.pause();

    const released = [];
    try {
      const jobs = await this.queue.getJobs(["waiting", "paused", "delayed", "prioritized"], 0, -1, false);
      const candidates = [];
      for (const job of jobs) {
        if (!job) continue;
        const state = await job.getState().catch(() => "unknown");
        const high = priorityForJob(job).name === "critical";
        const wasDeferred = state === "delayed" ||
          Number(job.data?.deferCount || 0) > 0 ||
          Boolean(job.data?.deferReason);
        if (high && wasDeferred && ["waiting", "paused", "delayed", "prioritized"].includes(state)) {
          candidates.push({ job, state });
        }
      }

      candidates.sort((a, b) => Number(a.job.timestamp || 0) - Number(b.job.timestamp || 0));
      for (const { job } of candidates) {
        const data = { ...job.data, priority: "critical", priorityLevel: 1 };
        // This admin action explicitly makes the next attempt immediate. Clear
        // deferral markers so quiet-hours logic treats it like a fresh CRITICAL;
        // a later failed attempt is still detected through attemptsMade.
        delete data.deferCount;
        delete data.deferReason;
        await this.forgetDeferredHigh(job.id);
        await job.remove();
        const fresh = await this.queue.add("send", data, { priority: 1 });
        released.push({
          id: fresh.id,
          previousId: String(job.id),
          _data: data
        });
      }
    } finally {
      if (!wasPaused) await this.resume();
    }

    return released;
  }

  // Cancel a send only while it is still pending. An active job is already
  // driving the browser and must finish/fail through the normal worker path.
  async cancelPendingJob(id) {
    const job = await this.queue.getJob(id);
    if (!job) return { cancelled: false, reason: "not_found", state: null };
    const state = await job.getState().catch(() => "unknown");
    if (!["waiting", "paused", "delayed", "prioritized"].includes(state)) {
      return { cancelled: false, reason: state === "active" ? "active" : "not_pending", state };
    }
    await this.forgetDeferredHigh(id);
    await job.remove();
    return { cancelled: true, id: String(id), state };
  }

  // Backwards-compatible boolean helper used by older admin paths.
  async removeJob(id) {
    const result = await this.cancelPendingJob(id);
    return result.cancelled;
  }

  // Block until a job finishes (used by /send?wait=true). Throws on failure/timeout.
  waitForJob(job, timeoutMs = 90000) {
    return job.waitUntilFinished(this.events, timeoutMs);
  }

  // Worker runs IN-PROCESS with concurrency 1 so it shares the single
  // Playwright browser instance. A separate worker process would need its
  // own browser and break the Google Messages session.
  startWorker(processor, handlers = {}, options = {}) {
    this.worker = new Worker(QUEUE_NAME, processor, {
      connection,
      ...options,
      concurrency: 1
    });
    if (handlers.onActive) this.worker.on("active", handlers.onActive);
    if (handlers.onCompleted) this.worker.on("completed", handlers.onCompleted);
    if (handlers.onFailed) this.worker.on("failed", handlers.onFailed);
    this.worker.on("error", (err) => { handlers.onError?.(err); });
    return this.worker;
  }

  async close({ force = false } = {}) {
    await this.worker?.close(force).catch(() => {});
    await this.events?.close().catch(() => {});
    await this.queue?.close().catch(() => {});
  }
}

module.exports = { SendQueue, QUEUE_NAME };
