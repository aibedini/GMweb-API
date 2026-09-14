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

// Consumer notification identity (lifecycle invalidation). The allowlist,
// bounds and the "is this superseded?" barrier live in ONE pure module so the
// HTTP layer, the durable ledger, the worker and the Android gateway can never
// disagree about what a serviceKey/generation means.
const {
  NOTIFICATION_KINDS,
  NOTIFICATION_TEXT_LIMITS,
  MAX_GENERATION,
  TERMINAL_SEND_STATUSES,
  normalizeNotificationMeta,
  selectInvalidatableSends,
  summarizeInvalidation,
  isSupersededNotification,
  isTerminalSendStatus
} = require("./notificationMeta");

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
      CREATE TABLE IF NOT EXISTS service_generations (
        source          TEXT NOT NULL,
        service_key     TEXT NOT NULL,
        generation      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (source, service_key)
      );
      CREATE TABLE IF NOT EXISTS invalidation_events (
        event_id    TEXT PRIMARY KEY,
        source      TEXT,
        service_key TEXT,
        response_json TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      -- Durable lifecycle counters (sms_invalidations_total, ...). Kept in the
      -- same SQLite file as the ledger so an operator can still answer "how many
      -- stale reminders did we stop?" after a restart.
      CREATE TABLE IF NOT EXISTS send_counters (
        name       TEXT PRIMARY KEY,
        value      INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
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
      "ALTER TABLE sends ADD COLUMN result_json TEXT",
      // Consumer notification identity (Eve lifecycle invalidations). Nullable:
      // every pre-existing row keeps working and is simply never matched by a
      // serviceKey lookup.
      "ALTER TABLE sends ADD COLUMN source TEXT",
      "ALTER TABLE sends ADD COLUMN service_key TEXT",
      "ALTER TABLE sends ADD COLUMN notification_kind TEXT",
      "ALTER TABLE sends ADD COLUMN correlation_id TEXT",
      "ALTER TABLE sends ADD COLUMN notification_generation INTEGER",
      "ALTER TABLE sends ADD COLUMN requires_validation INTEGER NOT NULL DEFAULT 0",
      // Durable revocation tombstone. revoked_at is set the moment an
      // invalidation reaches this gateway -- BEFORE the worker, the pull bridge
      // and /gateway/validate are told -- so a crash between "decided" and
      // "delivered" cannot resurrect a stale reminder.
      "ALTER TABLE sends ADD COLUMN revoked_at INTEGER",
      "ALTER TABLE sends ADD COLUMN revocation_reason TEXT",
      "ALTER TABLE sends ADD COLUMN revocation_json TEXT",
      // The late-real-send audit is stamped on the row itself (first write
      // wins, like revoked_at): the phone retries an ACK whose answer was
      // lost, and one physical submission must never be recorded, counted or
      // audited twice.
      "ALTER TABLE sends ADD COLUMN sent_after_revocation_at INTEGER",
      // Android gateway request id (pull_...). The phone's identity for a task
      // must outlive the in-memory outbox, otherwise /gateway/validate cannot
      // answer after a restart.
      "ALTER TABLE sends ADD COLUMN gateway_request_id TEXT",
      // Which notification KINDS the recorded watermark invalidated. A renewal
      // that only revoked "volume_ended" must not silently block an "expired"
      // reminder the consumer still considers valid.
      "ALTER TABLE service_generations ADD COLUMN kinds TEXT"
    ]) {
      try { this.db.exec(sql); } catch { /* already present */ }
    }
    for (const sql of [
      "CREATE INDEX IF NOT EXISTS idx_sends_service ON sends (source, service_key, status)",
      "CREATE INDEX IF NOT EXISTS idx_sends_notification_generation ON sends (service_key, notification_generation)",
      "CREATE INDEX IF NOT EXISTS idx_sends_gateway_request ON sends (gateway_request_id)",
      // Windowed outcome metrics ("last 24h") must be an index range scan, not a
      // full table read pulled into JavaScript.
      "CREATE INDEX IF NOT EXISTS idx_sends_terminal_time ON sends (status, finished_at)",
      "CREATE INDEX IF NOT EXISTS idx_sends_finished ON sends (finished_at)"
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
         finished_at=CASE WHEN @status IN ('sent','unverified','failed','suppressed','cancelled','superseded') THEN @now ELSE finished_at END
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
         finished_at = CASE WHEN @status IN ('sent','unverified','failed','suppressed','cancelled','superseded') THEN @now ELSE finished_at END,
         sent_at = CASE WHEN @status='sent' THEN @now ELSE sent_at END,
         result_json = CASE WHEN @result_json IS NOT NULL THEN @result_json ELSE result_json END
       WHERE job_id=@job_id`
    );
    this._pending = this.db.prepare(
      `SELECT * FROM sends WHERE status IN ('queued','active') ORDER BY created_at ASC`
    );
    this._statsRows = this.db.prepare(`SELECT status, COUNT(*) AS n FROM sends GROUP BY status`);
    // Terminal outcomes inside a time window. finished_at is the general
    // terminal timestamp; sent_at/updated_at cover rows written before that
    // column existed (the migration is additive, history is never rewritten).
    this._statsSince = this.db.prepare(`
      SELECT status, COUNT(*) AS n FROM sends
       WHERE status IN ('sent','unverified','failed','suppressed','cancelled','superseded')
         AND COALESCE(finished_at, sent_at, updated_at) >= ?
       GROUP BY status`)
    this._recent = this.db.prepare(`SELECT * FROM sends ORDER BY id DESC LIMIT ?`);
    this._setNotification = this.db.prepare(
      `UPDATE sends
          SET source=@source, service_key=@service_key,
              notification_kind=@notification_kind, correlation_id=@correlation_id,
              notification_generation=@notification_generation,
              requires_validation=@requires_validation, updated_at=@now
        WHERE id=@id`
    );
    this._generationFor = this.db.prepare(
      `SELECT generation FROM service_generations WHERE source=? AND service_key=?`
    );
    this._generationRecord = this.db.prepare(
      `SELECT generation, kinds FROM service_generations WHERE source=? AND service_key=?`
    );
    this._advanceGeneration = this.db.prepare(
      `INSERT INTO service_generations (source, service_key, generation, kinds, updated_at)
       VALUES (@source, @service_key, @generation, @kinds, @now)
       ON CONFLICT(source, service_key) DO UPDATE
         SET generation=MAX(generation, excluded.generation), kinds=excluded.kinds, updated_at=excluded.updated_at`
    );
    this._invalidatable = this.db.prepare(
      `SELECT * FROM sends
        WHERE source=@source AND service_key=@service_key
          AND status IN ('queued','active')
          AND revoked_at IS NULL
          AND (@key_name IS NULL OR key_name=@key_name)
        ORDER BY created_at ASC LIMIT @limit`
    );
    this._serviceRows = this.db.prepare(
      `SELECT * FROM sends
        WHERE source=@source AND service_key=@service_key
          AND (@key_name IS NULL OR key_name=@key_name)
        ORDER BY created_at ASC LIMIT @limit`
    );
    this._byGatewayRequest = this.db.prepare(
      `SELECT * FROM sends WHERE gateway_request_id=? LIMIT 1`
    );
    this._attachGatewayRequest = this.db.prepare(
      `UPDATE sends SET gateway_request_id=@gateway_request_id, updated_at=@now WHERE id=@id`
    );
    // Tombstone ONLY: the durable "this may never be delivered" marker. The
    // terminal status transition belongs to finalizeSuperseded() so the
    // superseded counter is bumped exactly once per notification.
    this._markRevoked = this.db.prepare(
      `UPDATE sends
          SET revoked_at=COALESCE(revoked_at, @now),
              revocation_reason=COALESCE(revocation_reason, @reason),
              revocation_json=COALESCE(revocation_json, @json),
              updated_at=@now
        WHERE id=@id
          AND status NOT IN ('sent','unverified','failed','suppressed','cancelled','superseded')`
    );
    this._finalizeSuperseded = this.db.prepare(
      `UPDATE sends
          SET status='superseded',
              finished_at=COALESCE(finished_at, @now),
              error=COALESCE(error, @reason),
              updated_at=@now
        WHERE id=@id
          AND status NOT IN ('sent','unverified','failed','suppressed','cancelled','superseded')`
    );
    // First write wins. A retried ACK for the same physical submission is a
    // no-op: no second counter, no rewritten outcome, no second audit entry.
    this._markSentAfterRevocation = this.db.prepare(
      `UPDATE sends
          SET status='sent', sent_at=COALESCE(sent_at, @now),
              finished_at=@now, updated_at=@now, result_json=@result_json,
              sent_after_revocation_at=@now
        WHERE id=@id
          AND sent_after_revocation_at IS NULL`
    );
    this._bumpCounter = this.db.prepare(
      `INSERT INTO send_counters (name, value, updated_at) VALUES (@name, @delta, @now)
       ON CONFLICT(name) DO UPDATE SET value=value + @delta, updated_at=excluded.updated_at`
    );
    this._counters = this.db.prepare(`SELECT name, value FROM send_counters ORDER BY name`);
    this._revokedInflightCount = this.db.prepare(
      `SELECT COUNT(*) AS n FROM sends WHERE revoked_at IS NOT NULL AND status='active'`
    );
    this._validationRequired = this.db.prepare(
      `SELECT 1 AS present FROM sends WHERE service_key=? AND status='queued'
         AND requires_validation=1 LIMIT 1`
    );
    this._invalidationEvent = this.db.prepare(
      `SELECT response_json FROM invalidation_events WHERE event_id=?`
    );
    this._rememberInvalidation = this.db.prepare(
      `INSERT INTO invalidation_events (event_id, source, service_key, response_json, created_at)
       VALUES (@event_id, @source, @service_key, @response_json, @now)
       ON CONFLICT(event_id) DO NOTHING`
    );
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
    this._claimTxn = this.db.transaction((to, text, keyName, priority, windowMs, now, notification) => {
      const key = dedupeKey(to, text);
      const sent = this._lastSent.get(key, now - windowMs);
      if (sent) return { action: "duplicate_suppressed", row: sent };
      const inflight = this._inflight.get(key);
      if (inflight) return { action: "duplicate_inflight", row: inflight };
      const info = this._insert.run({
        dedupe_key: key, to_number: to, text, key_name: keyName || null,
        priority: priority || "normal", idempotency_key: null, now
      });
      const id = Number(info.lastInsertRowid);
      // Same transaction as the insert: there is no instant where a
      // revocation-eligible row exists WITHOUT its notification tag, which is
      // exactly the window an invalidation could otherwise slip through.
      if (notification) this._setNotification.run(this._notificationParams(id, notification, now));
      return { action: "new", id };
    });
  }

  // Decide what to do with an incoming send. Returns one of:
  //   { action:"new", id }                       -> caller should enqueue
  //   { action:"duplicate_suppressed", row }      -> identical sent within window
  //   { action:"duplicate_inflight", row }        -> identical already queued/active
  claim({ to, text, keyName, priority = "normal", windowMs, notification = null }) {
    return this._claimTxn(to, text, keyName, priority, windowMs, Date.now(),
      notification ? normalizeNotificationMeta(notification) : null);
  }

  _notificationParams(id, meta, now) {
    const clean = normalizeNotificationMeta(meta);
    return {
      id: Number(id),
      source: clean.source,
      service_key: clean.serviceKey,
      notification_kind: clean.notificationKind,
      correlation_id: clean.correlationId,
      notification_generation: clean.generation,
      requires_validation: clean.requiresValidation ? 1 : 0,
      now
    };
  }

  /**
   * Attach the consumer's notification identity to a ledger row so a later
   * lifecycle invalidation can find and cancel it by serviceKey alone. Only the
   * whitelisted, bounded fields are persisted — never the message text beyond
   * what the ledger already stores.
   */
  setNotification(id, meta = {}) {
    if (!Number.isInteger(Number(id))) return false;
    this._setNotification.run(this._notificationParams(id, meta, Date.now()));
    return true;
  }

  /** Highest lifecycle generation this store has ever seen for a service. */
  generationFor(source, serviceKey) {
    const row = this._generationFor.get(String(source || ""), String(serviceKey || ""));
    return row ? Number(row.generation) : null;
  }

  /**
   * The full revocation barrier: the watermark PLUS the kinds it invalidated.
   * A delayed retry, a stalled BullMQ job or a re-enqueued ledger row is judged
   * against this instead of a per-row flag, so nothing can be resurrected.
   */
  revocationBarrier(source, serviceKey) {
    const row = this._generationRecord.get(String(source || ""), String(serviceKey || ""));
    if (!row) return null;
    let kinds = [];
    try { kinds = JSON.parse(row.kinds || "[]"); } catch { kinds = []; }
    return { generation: Number(row.generation), kinds: Array.isArray(kinds) ? kinds : [] };
  }

  /** The barrier for a ledger row (no serviceKey -> no barrier). */
  barrierForRow(row) {
    if (!row || !row.service_key) return null;
    return this.revocationBarrier(row.source, row.service_key);
  }

  /** True when this row may not be delivered any more, for any durable reason. */
  isSuperseded(row) {
    return isSupersededNotification(row, this.barrierForRow(row));
  }

  /**
   * Monotonic watermark for a service generation. A duplicate or out-of-order
   * invalidation (an older generation arriving after a newer one) must never
   * cancel a notification that belongs to the newer lifecycle.
   */
  advanceGeneration(source, serviceKey, generation, kinds = null) {
    const value = Number(generation);
    if (!Number.isFinite(value) || value < 0) return null;
    const origin = String(source || "");
    const key = String(serviceKey || "");
    // kinds is a UNION, never a replacement: gen 18 invalidating "volume_ended"
    // followed by gen 19 invalidating "expired" must keep BOTH blocked below
    // their respective watermarks.
    const previous = this.revocationBarrier(origin, key);
    const merged = new Set([...(previous?.kinds || [])]);
    for (const kind of Array.isArray(kinds) ? kinds : []) {
      const clean = String(kind || "").trim().toLowerCase();
      if (clean) merged.add(clean);
    }
    this._advanceGeneration.run({
      source: origin, service_key: key,
      generation: Math.trunc(value),
      kinds: JSON.stringify([...merged].sort()),
      now: Date.now()
    });
    return this.generationFor(origin, key);
  }

  /** Non-terminal sends for one service, oldest first (cancel order). */
  invalidatableSends(source, serviceKey, limit = 500, keyName = null) {
    return this._invalidatable.all({
      source: String(source || ""), service_key: String(serviceKey || ""),
      key_name: keyName ? String(keyName) : null,
      limit: Math.max(1, Math.min(Number(limit) || 500, 5000))
    });
  }

  /**
   * Every ledger row for a service, terminal ones included. Used to prove a
   * project key really owns the serviceKey it is about to invalidate: an
   * unguessable key is not authorization, and letting a foreign caller advance
   * another service's watermark would be a denial-of-invalidation.
   */
  serviceRows(source, serviceKey, { limit = 500, keyName = null } = {}) {
    return this._serviceRows.all({
      source: String(source || ""), service_key: String(serviceKey || ""),
      key_name: keyName ? String(keyName) : null,
      limit: Math.max(1, Math.min(Number(limit) || 500, 5000))
    });
  }

  ownsService(source, serviceKey, keyName) {
    if (!keyName) return true;
    return this.serviceRows(source, serviceKey, { limit: 1, keyName }).length > 0;
  }

  /** Bind the Android gateway's opaque task id to its ledger row. */
  attachGatewayRequest(id, gatewayRequestId) {
    if (!Number.isInteger(Number(id))) return false;
    const value = String(gatewayRequestId || "").trim();
    if (!value) return false;
    this._attachGatewayRequest.run({
      id: Number(id), gateway_request_id: value.slice(0, 120), now: Date.now()
    });
    return true;
  }

  byGatewayRequest(gatewayRequestId) {
    const value = String(gatewayRequestId || "").trim();
    if (!value) return null;
    return this._byGatewayRequest.get(value) || null;
  }

  /**
   * Durable tombstone. The revocation is written BEFORE the worker, the pull
   * bridge and the validation endpoint are told, so a crash in between still
   * leaves the reminder unsendable. Rows that already reached a terminal state
   * are left untouched and reported so the caller can count them honestly.
   */
  revokeById(id, { reason = null, correlationId = null, eventId = null,
                   generation = null, source = null, at = Date.now() } = {}) {
    if (!Number.isInteger(Number(id))) return { ok: false, row: null };
    const payload = JSON.stringify({
      reason: reason || null,
      correlationId: correlationId || null,
      eventId: eventId || null,
      generation: generation === null || generation === undefined ? null : Number(generation),
      source: source || null,
      revokedAt: new Date(at).toISOString()
    }).slice(0, 2000);
    const info = this._markRevoked.run({
      id: Number(id), reason: reason || null, json: payload, now: at
    });
    const row = this.byId(id);
    return { ok: (info.changes || 0) > 0, row };
  }

  /** Terminalize a task the phone/worker confirmed as superseded. */
  finalizeSuperseded(id, reason = null) {
    if (!Number.isInteger(Number(id))) return false;
    const info = this._finalizeSuperseded.run({
      id: Number(id), reason: reason || "superseded", now: Date.now()
    });
    return (info.changes || 0) > 0;
  }

  /**
   * The impossible-unsend case: the phone reports a real physical submission
   * AFTER the reminder was revoked. The physical truth wins -- the row becomes
   * "sent" again, with the race recorded explicitly instead of pretending the
   * SMS never left the device.
   *
   * @returns {boolean} true only when THIS call recorded the anomaly. The
   * device retries an ACK whose response was lost, so the second report of one
   * physical submission must be a no-op rather than a second audit.
   */
  recordSentAfterRevocation(id, details = {}) {
    if (!Number.isInteger(Number(id))) return false;
    const now = Date.now();
    let resultJson;
    try {
      resultJson = JSON.stringify({ ...details, sentAfterRevocation: true, auditedAt: new Date(now).toISOString() });
    } catch { resultJson = JSON.stringify({ sentAfterRevocation: true }); }
    const info = this._markSentAfterRevocation.run({ id: Number(id), result_json: resultJson, now });
    return (info.changes || 0) > 0;
  }

  bumpCounters(entries, at = Date.now()) {
    const list = Array.isArray(entries) ? entries : [entries];
    const apply = this.db.transaction(() => {
      for (const entry of list) {
        if (!entry?.name) continue;
        const delta = Number(entry.delta ?? 1);
        if (!Number.isFinite(delta) || delta === 0) continue;
        this._bumpCounter.run({ name: String(entry.name), delta: Math.trunc(delta), now: at });
      }
    });
    apply();
  }

  /** Durable lifecycle counters, metric-name -> value. */
  counters() {
    const out = {};
    for (const row of this._counters.all()) out[row.name] = Number(row.value);
    return out;
  }

  revokedInflightCount() {
    return Number(this._revokedInflightCount.get()?.n || 0);
  }

  /** True when a not-yet-started send for this service still needs validation. */
  hasValidationRequired(serviceKey) {
    return this._validationRequired.get(String(serviceKey || "")) !== undefined;
  }

  /** Replay a previously answered invalidation so a retry is a no-op. */
  invalidationResult(eventId) {
    const key = String(eventId || "");
    if (!key) return null;
    const row = this._invalidationEvent.get(key);
    if (!row) return null;
    try { return JSON.parse(row.response_json); } catch { return null; }
  }

  rememberInvalidation(eventId, { source, serviceKey, response }) {
    const key = String(eventId || "");
    if (!key) return false;
    let payload;
    try { payload = JSON.stringify(response); } catch { return false; }
    this._rememberInvalidation.run({
      event_id: key, source: source ? String(source).slice(0, 32) : null,
      service_key: serviceKey ? String(serviceKey).slice(0, 200) : null,
      response_json: payload, now: Date.now()
    });
    return true;
  }

  // Explicit-idempotency sends still need a durable observability row. The
  // idempotency reservation happens in Redis first, so retries never call this.
  create({ to, text, keyName, priority = "normal", idempotencyKey = null, notification = null }) {
    const now = Date.now();
    const info = this._insert.run({
      dedupe_key: dedupeKey(to, text), to_number: to, text,
      key_name: keyName || null, priority, idempotency_key: idempotencyKey, now
    });
    const id = Number(info.lastInsertRowid);
    if (notification) this._setNotification.run(this._notificationParams(id, notification, now));
    return id;
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
    const out = {
      queued: 0, active: 0, sent: 0, unverified: 0, failed: 0,
      suppressed: 0, cancelled: 0, superseded: 0
    };
    for (const r of this._statsRows.all()) out[r.status] = r.n;
    // Not a status: a row that is revoked but still 'active' is waiting for the
    // phone's answer (superseded ACK or lease expiry).
    out.revokedInflight = this.revokedInflightCount();
    return out;
  }

  /**
   * Terminal OUTCOMES whose delivery finished at/after `since` (epoch ms),
   * aggregated in SQLite. This is what a "last 24h" card must read: an all-time
   * total can never be presented as current queue activity.
   *
   * `sent` and `unverified` are distinct outcomes and are never folded
   * together; `superseded` is not a failure.
   */
  statsSince(since) {
    const cutoff = Number(since);
    const out = { sent: 0, unverified: 0, failed: 0, suppressed: 0, cancelled: 0, superseded: 0, total: 0 };
    if (!Number.isFinite(cutoff)) return out;
    for (const row of this._statsSince.all(cutoff)) {
      if (row.status in out) out[row.status] = Number(row.n);
    }
    out.total = out.sent + out.unverified + out.failed + out.suppressed + out.cancelled + out.superseded;
    return out;
  }

  recent(limit = 100) {
    return this._recent.all(Math.max(1, Math.min(limit, 1000)));
  }

  close() {
    try { this.db.close(); } catch { /* ignore */ }
  }
}

module.exports = {
  SendStore,
  dedupeKey,
  // Re-exported from ./notificationMeta so existing importers (and tests) keep
  // working against the single source of truth.
  normalizeNotificationMeta,
  selectInvalidatableSends,
  summarizeInvalidation,
  isSupersededNotification,
  isTerminalSendStatus,
  NOTIFICATION_KINDS,
  NOTIFICATION_TEXT_LIMITS,
  MAX_GENERATION,
  TERMINAL_SEND_STATUSES
};
