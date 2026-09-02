const Database = require("better-sqlite3");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Durable send ledger (SQLite). Survives API/Redis/Chrome crashes, so we never
// lose track of what was queued or sent. It powers three things:
//   1. Status tracking per message (queued → active → sent | failed | suppressed).
//   2. 24h content de-dupe — the same {to,text} is not re-sent within the window,
//      even if a consumer (Eve) posts it again or Redis is wiped.
//   3. Crash recovery — on boot, unfinished rows are re-enqueued so the queue is
//      rebuilt from the ledger, not lost.
//
// WAL mode + synchronous=NORMAL gives crash-safe durability with good throughput.

function dedupeKey(to, text) {
  return crypto.createHash("sha256").update(`${to}\n${text}`).digest("hex");
}

class SendStore {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sends (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key  TEXT NOT NULL,
        to_number   TEXT NOT NULL,
        text        TEXT NOT NULL,
        key_name    TEXT,
        priority    TEXT NOT NULL DEFAULT 'normal',
        idempotency_key TEXT,
        job_id      TEXT,
        status      TEXT NOT NULL,           -- queued | active | sent | unverified | failed | suppressed
        stage       TEXT,                    -- granular progress: opening | locating | start_chat | composer_ready | typing | sent | stuck_reload ...
        attempts    INTEGER NOT NULL DEFAULT 0,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        queued_at   INTEGER,
        active_at   INTEGER,
        stage_at    INTEGER,
        finished_at INTEGER,
        sent_at     INTEGER,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sends_dedupe  ON sends (dedupe_key, status, sent_at);
      CREATE INDEX IF NOT EXISTS idx_sends_job     ON sends (job_id);
      CREATE INDEX IF NOT EXISTS idx_sends_status  ON sends (status);
      CREATE TABLE IF NOT EXISTS send_job_refs (
        job_id      TEXT PRIMARY KEY,
        send_id     INTEGER NOT NULL,
        attached_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_send_job_refs_send ON send_job_refs (send_id);
    `);
    // Additive migrations keep existing production ledgers readable.
    for (const sql of [
      "ALTER TABLE sends ADD COLUMN stage TEXT",
      "ALTER TABLE sends ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'",
      "ALTER TABLE sends ADD COLUMN idempotency_key TEXT",
      "ALTER TABLE sends ADD COLUMN queued_at INTEGER",
      "ALTER TABLE sends ADD COLUMN active_at INTEGER",
      "ALTER TABLE sends ADD COLUMN stage_at INTEGER",
      "ALTER TABLE sends ADD COLUMN finished_at INTEGER",
      "ALTER TABLE sends ADD COLUMN result_json TEXT"
    ]) {
      try { this.db.exec(sql); } catch { /* already present */ }
    }

    this._insert = this.db.prepare(
      `INSERT INTO sends
         (dedupe_key, to_number, text, key_name, priority, idempotency_key,
          status, created_at, updated_at, queued_at)
       VALUES
         (@dedupe_key, @to_number, @text, @key_name, @priority, @idempotency_key,
          'queued', @now, @now, @now)`
    );
    this._lastSent = this.db.prepare(
      `SELECT * FROM sends
       WHERE dedupe_key=? AND status IN ('sent','unverified')
         AND COALESCE(sent_at, finished_at) > ?
       ORDER BY COALESCE(sent_at, finished_at) DESC LIMIT 1`
    );
    this._inflight = this.db.prepare(
      `SELECT * FROM sends WHERE dedupe_key=? AND status IN ('queued','active') ORDER BY created_at DESC LIMIT 1`
    );
    this._attach = this.db.prepare(`UPDATE sends SET job_id=?, queued_at=?, updated_at=? WHERE id=?`);
    this._attachRef = this.db.prepare(
      `INSERT INTO send_job_refs (job_id, send_id, attached_at) VALUES (?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET send_id=excluded.send_id, attached_at=excluded.attached_at`
    );
    this._setById = this.db.prepare(
      `UPDATE sends SET status=@status, error=@error, updated_at=@now,
         finished_at=CASE WHEN @status IN ('sent','unverified','failed','suppressed','cancelled') THEN @now ELSE finished_at END
       WHERE id=@id`
    );
    this._setStage = this.db.prepare(`UPDATE sends SET stage=?, stage_at=?, updated_at=? WHERE job_id=?`);
    this._setPriorityByJob = this.db.prepare(
      `UPDATE sends SET priority=@priority, updated_at=@now
       WHERE job_id=@job_id OR id IN (SELECT send_id FROM send_job_refs WHERE job_id=@job_id)`
    );
    this._byJob = this.db.prepare(
      `SELECT s.* FROM sends s
       WHERE s.job_id=@job_id OR EXISTS (
         SELECT 1 FROM send_job_refs r WHERE r.send_id=s.id AND r.job_id=@job_id
       )
       ORDER BY s.id DESC LIMIT 1`
    );
    this._byId = this.db.prepare(`SELECT * FROM sends WHERE id=? LIMIT 1`);
    this._setStatusByJob = this.db.prepare(
      `UPDATE sends SET status=@status, attempts=@attempts, error=@error, updated_at=@now,
         active_at = CASE WHEN @status='active' THEN @now ELSE active_at END,
         finished_at = CASE WHEN @status IN ('sent','unverified','failed','suppressed','cancelled') THEN @now ELSE finished_at END,
         sent_at = CASE WHEN @status='sent' THEN @now ELSE sent_at END,
         result_json = CASE WHEN @result_json IS NOT NULL THEN @result_json ELSE result_json END
       WHERE job_id=@job_id`
    );
    this._pending = this.db.prepare(
      `SELECT * FROM sends WHERE status IN ('queued','active') ORDER BY created_at ASC`
    );
    this._statsRows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM sends GROUP BY status`);
    this._recent = this.db.prepare(`SELECT * FROM sends ORDER BY id DESC LIMIT ?`);
    this._backfill = this.db.prepare(
      `INSERT INTO sends
         (dedupe_key, to_number, text, key_name, priority, idempotency_key, job_id,
          status, stage, attempts, error, created_at, updated_at, queued_at, active_at, stage_at)
       VALUES
         (@dedupe_key, @to_number, @text, @key_name, @priority, @idempotency_key, @job_id,
          @status, @stage, @attempts, @error, @created_at, @updated_at, @queued_at, @active_at, @stage_at)`
    );
    this._attachTxn = this.db.transaction((id, jobId, now) => {
      const current = this._byId.get(id);
      if (current?.job_id) this._attachRef.run(String(current.job_id), id, now);
      this._attachRef.run(String(jobId), id, now);
      this._attach.run(String(jobId), now, now, id);
    });

    // Claim runs in a transaction so two concurrent identical requests can't both
    // pass the de-dupe check and double-send.
    this._claimTxn = this.db.transaction((to, text, keyName, priority, windowMs, now) => {
      const key = dedupeKey(to, text);
      const sent = this._lastSent.get(key, now - windowMs);
      if (sent) return { action: "duplicate_suppressed", row: sent };
      const inflight = this._inflight.get(key);
      if (inflight) return { action: "duplicate_inflight", row: inflight };
      const info = this._insert.run({
        dedupe_key: key, to_number: to, text, key_name: keyName || null,
        priority: priority || "normal", idempotency_key: null, now
      });
      return { action: "new", id: Number(info.lastInsertRowid) };
    });
  }

  // Decide what to do with an incoming send. Returns one of:
  //   { action:"new", id }                       -> caller should enqueue
  //   { action:"duplicate_suppressed", row }      -> identical sent within window
  //   { action:"duplicate_inflight", row }        -> identical already queued/active
  claim({ to, text, keyName, priority = "normal", windowMs }) {
    return this._claimTxn(to, text, keyName, priority, windowMs, Date.now());
  }

  // Explicit-idempotency sends still need a durable observability row. The
  // idempotency reservation happens in Redis first, so retries never call this.
  create({ to, text, keyName, priority = "normal", idempotencyKey = null }) {
    const now = Date.now();
    const info = this._insert.run({
      dedupe_key: dedupeKey(to, text), to_number: to, text,
      key_name: keyName || null, priority, idempotency_key: idempotencyKey, now
    });
    return Number(info.lastInsertRowid);
  }

  backfillPending(job) {
    if (!job?.jobId || this.byJob(job.jobId)) return false;
    const createdAt = Number(job.createdAt) || Date.now();
    const activeAt = job.state === "active" ? (Number(job.processedAt) || Date.now()) : null;
    const stage = job.state === "active" ? "legacy_active" : "legacy_queued";
    this._backfill.run({
      dedupe_key: dedupeKey(job.to, job.text), to_number: job.to, text: job.text,
      key_name: job.keyName || null, priority: job.priority || "normal",
      idempotency_key: job.idempotencyKey || null, job_id: String(job.jobId),
      status: job.state === "active" ? "active" : "queued", stage,
      attempts: Number(job.attempts || 0), error: job.failedReason || null,
      created_at: createdAt, updated_at: Date.now(), queued_at: createdAt,
      active_at: activeAt, stage_at: Date.now()
    });
    return true;
  }

  attachJob(id, jobId) {
    const now = Date.now();
    this._attachTxn(id, jobId, now);
  }

  markById(id, status, error = null) {
    this._setById.run({ id, status, error, now: Date.now() });
  }

  /**
   * P0 (emergency-stop durability): cancel every ledger row still sitting in
   * 'queued' — NOT 'active' (an active row may already be submitted to the
   * device; its true lifecycle must be preserved). This closes the
   * boot-rebuild gap: cancelled rows can never be re-enqueued after restart.
   * @returns {number} rows cancelled
   */
  cancelAllQueued(reason = "cancelled_by_emergency_stop") {
    const now = Date.now();
    const info = this.db
      .prepare(
        `UPDATE sends
            SET status='cancelled',
                error=?,
                updated_at=?,
                finished_at=?
          WHERE status='queued'`
      )
      .run(reason, now, now);
    return info.changes || 0;
  }

  // Record the granular send stage (which step the message is on right now).
  markStage(jobId, stage) {
    if (!jobId) return;
    const now = Date.now();
    this._setStage.run(stage, now, now, String(jobId));
  }

  updatePriorityByJob(jobId, priority) {
    if (!jobId) return 0;
    return this._setPriorityByJob.run({
      job_id: String(jobId),
      priority: String(priority),
      now: Date.now()
    }).changes;
  }

  markStatus(jobId, status, { attempts = 0, error = null, result = null } = {}) {
    if (!jobId) return;
    let resultJson = null;
    if (result !== null && result !== undefined) {
      try { resultJson = JSON.stringify(result); } catch { resultJson = JSON.stringify({ value: String(result) }); }
    }
    this._setStatusByJob.run({
      job_id: String(jobId), status, attempts, error,
      result_json: resultJson, now: Date.now()
    });
  }

  byJob(jobId) {
    return jobId ? this._byJob.get({ job_id: String(jobId) }) : null;
  }

  byId(id) {
    return Number.isInteger(Number(id)) ? this._byId.get(Number(id)) : null;
  }

  requestId(id) {
    return Number.isInteger(Number(id)) ? `send_${Number(id)}` : null;
  }

  // A requestId is stable for the lifetime of the SQLite ledger row even when
  // BullMQ replaces its job during defer/retry/promotion. Raw job ids remain a
  // backwards-compatible lookup for integrations already using them.
  byReference(reference) {
    const value = String(reference || "");
    const match = /^send_(\d+)$/.exec(value);
    return match ? this.byId(match[1]) : this.byJob(value);
  }

  // Rows still unfinished — used on boot to rebuild the queue if Redis lost them.
  pending() {
    return this._pending.all();
  }

  stats() {
    const out = { queued: 0, active: 0, sent: 0, unverified: 0, failed: 0, suppressed: 0, cancelled: 0 };
    for (const r of this._statsRows.all()) out[r.status] = r.n;
    return out;
  }

  recent(limit = 100) {
    return this._recent.all(Math.max(1, Math.min(limit, 1000)));
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

module.exports = { SendStore, dedupeKey };
