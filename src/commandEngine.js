"use strict";

/**
 * Phase 2 (TechSpec §8/§41/§56/§58) — Durable Command Engine.
 *
 * Every write from ANY client (PWA, Eve service identity, future) is a
 * command row committed BEFORE the HTTP 202 leaves the process (Rule 4:
 * no accepted work without durable persistence). The row is transport-
 * agnostic: the Android Agent pull bridge and the legacy Google-Web
 * transport both become command *executors*.
 *
 * Exactly-once: UNIQUE(account_id, idempotency_key) (TechSpec §49 / RFP §9).
 * A redelivered idempotency key returns the ORIGINAL command (201-style
 * replay flag on the 202) instead of enqueueing twice.
 *
 * Lifecycle (§41):
 *   CREATED → QUEUED → DELIVERED_TO_AGENT → ACCEPTED_BY_AGENT →
 *   EXECUTING → COMPLETED | FAILED | EXPIRED
 *
 * Server-side state NEVER claims SENT/DELIVERED/FAILED on the carrier
 * network (Rule 1): those words exist only inside executor-reported
 * evidence payloads, relayed verbatim into the encrypted event store.
 */

class CommandEngine {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} [opts] { now?: () => number, defaultExpiryMs?: number }
   */
  constructor(db, opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.defaultExpiryMs = opts.defaultExpiryMs || 24 * 3600 * 1000; // §93 floor
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        id               TEXT PRIMARY KEY,
        account_id       TEXT NOT NULL,
        idempotency_key  TEXT NOT NULL,
        target_agent_id  TEXT,
        source_client_id TEXT,
        type             TEXT NOT NULL,
        ciphertext       BLOB NOT NULL,
        encoding         TEXT NOT NULL,
        schema_version   INTEGER NOT NULL,
        crypto_version   INTEGER NOT NULL,
        client_signature BLOB,
        state            TEXT NOT NULL,
        created_at       INTEGER NOT NULL,
        expires_at       INTEGER NOT NULL,
        accepted_at      INTEGER,
        completed_at     INTEGER,
        result           TEXT,
        UNIQUE (account_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_commands_state ON commands (account_id, state, created_at);
      CREATE INDEX IF NOT EXISTS idx_commands_agent ON commands (target_agent_id, state, created_at);
      CREATE TABLE IF NOT EXISTS command_attempts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL,
        state      TEXT NOT NULL,
        detail     TEXT,
        at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_command ON command_attempts (command_id);
    `);
    this.insertStmt = db.prepare(
      `INSERT OR IGNORE INTO commands
       (id, account_id, idempotency_key, target_agent_id, source_client_id, type,
        ciphertext, encoding, schema_version, crypto_version, client_signature,
        state, created_at, expires_at)
       VALUES (@id, @account_id, @idempotency_key, @target_agent_id, @source_client_id,
               @type, @ciphertext, @encoding, @schema_version, @crypto_version,
               @client_signature, 'QUEUED', @created_at, @expires_at)`
    );
    this.byIdempotency = db.prepare(
      `SELECT * FROM commands WHERE account_id = ? AND idempotency_key = ?`
    );
    this.getStmt = db.prepare(`SELECT * FROM commands WHERE id = ?`);
    this.transitionStmt = db.prepare(
      `UPDATE commands SET state = @state,
         accepted_at = COALESCE(accepted_at, @accepted_at),
         completed_at = @completed_at,
         result = COALESCE(@result, result)
       WHERE id = @id
         AND (',' || @fromStates || ',') LIKE ('%,' || state || ',%')`
    );
    this.claimStmt = db.prepare(
      `SELECT * FROM commands
       WHERE target_agent_id = ? AND state = 'QUEUED'
         AND expires_at > ?
       ORDER BY created_at ASC LIMIT ?`
    );
    this.markDeliveredStmt = db.prepare(
      `UPDATE commands SET state = 'DELIVERED_TO_AGENT' WHERE id = ? AND state = 'QUEUED'`
    );
    this.expireStmt = db.prepare(
      `UPDATE commands SET state = 'EXPIRED', completed_at = ?
       WHERE state = 'QUEUED' AND expires_at <= ?`
    );
    this.insertAttempt = db.prepare(
      `INSERT INTO command_attempts (command_id, state, detail, at) VALUES (?, ?, ?, ?)`
    );
    this.countsStmt = db.prepare(
      `SELECT state, COUNT(*) AS n FROM commands WHERE account_id = ? GROUP BY state`
    );
  }

  /**
   * Create (or idempotently re-return) a command. Returns
   * {created, command} where created=false means a live idempotency replay.
   */
  createCommand({
    accountId,
    idempotencyKey,
    type,
    ciphertext,
    encoding = "application/json",
    schemaVersion = 1,
    cryptoVersion = 0,
    targetAgentId = null,
    sourceClientId = null,
    clientSignature = null,
    expiresAt = null,
  }) {
    if (!accountId || !idempotencyKey || !type) {
      throw new Error("accountId, idempotencyKey and type are required");
    }
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
      throw new Error("ciphertext payload is required (durable, opaque)");
    }
    const existing = this.byIdempotency.get(accountId, idempotencyKey);
    if (existing) {
      // Replay of a live idempotency key — surface the original row.
      return { created: false, command: this.#public(existing) };
    }
    const id = `cmd_${crypto.randomUUID()}`;
    const now = this.now();
    const info = this.insertStmt.run({
      id,
      account_id: accountId,
      idempotency_key: idempotencyKey,
      target_agent_id: targetAgentId,
      source_client_id: sourceClientId,
      type,
      ciphertext,
      encoding,
      schema_version: schemaVersion,
      crypto_version: cryptoVersion,
      client_signature: clientSignature,
      created_at: now,
      expires_at: expiresAt ?? now + this.defaultExpiryMs,
    });
    if (info.changes === 0) {
      // Lost an insert race → the winner's row is the answer.
      return { created: false, command: this.#public(this.byIdempotency.get(accountId, idempotencyKey)) };
    }
    this.insertAttempt.run(id, "QUEUED", "created", now);
    return { created: true, command: this.#public(this.getStmt.get(id)) };
  }

  get(id) {
    const row = this.getStmt.get(id);
    return row ? this.#public(row) : null;
  }

  /**
   * Agent pickup: atomically flips fetched QUEUED rows to DELIVERED_TO_AGENT.
   * Delivers raw rows (payload stays opaque — the engine never parses it).
   */
  claimForAgent(agentId, { limit = 25 } = {}) {
    this.#expireDue();
    const rows = this.claimStmt.all(agentId, this.now(), Math.max(1, Math.min(100, limit)));
    const out = [];
    for (const row of rows) {
      if (this.markDeliveredStmt.run(row.id).changes > 0) {
        this.insertAttempt.run(row.id, "DELIVERED_TO_AGENT", "claimed", this.now());
        out.push(this.#public(this.getStmt.get(row.id)));
      }
    }
    return out;
  }

  /** Guarded lifecycle transition used by agents/executors. */
  transition(id, state, { fromStates, result = null } = {}) {
    const now = this.now();
    const terminal = state === "COMPLETED" || state === "FAILED" || state === "EXPIRED";
    const info = this.transitionStmt.run({
      id,
      state,
      // comma-separated (LIKE %,state,% match) — no separator collision
      fromStates: fromStates.join(","),
      accepted_at: state === "ACCEPTED_BY_AGENT" ? now : null,
      completed_at: terminal ? now : null,
      result,
    });
    const ok = info.changes > 0;
    if (ok) this.insertAttempt.run(id, state, result || "", now);
    return ok;
  }

  counts(accountId) {
    const out = {};
    for (const row of this.countsStmt.all(accountId)) out[row.state] = row.n;
    return out;
  }

  #expireDue() {
    const now = this.now();
    const due = db_count(this.db, `SELECT COUNT(*) AS n FROM commands WHERE state = 'QUEUED' AND expires_at <= ?`, now);
    if (due > 0) this.expireStmt.run(now, now);
  }

  #public(row) {
    return {
      id: row.id,
      accountId: row.account_id,
      idempotencyKey: row.idempotency_key,
      type: row.type,
      targetAgentId: row.target_agent_id,
      sourceClientId: row.source_client_id,
      state: row.state,
      encoding: row.encoding,
      schemaVersion: row.schema_version,
      cryptoVersion: row.crypto_version,
      ciphertext: row.ciphertext, // opaque; API layer serializes base64
      clientSignature: row.client_signature,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      completedAt: row.completed_at,
      result: row.result,
    };
  }
}

function db_count(db, sql, ...args) {
  return db.prepare(sql).get(...args)?.n || 0;
}

module.exports = { CommandEngine };
