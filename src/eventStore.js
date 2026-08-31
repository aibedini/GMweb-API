"use strict";

/**
 * Phase 2 (PR-09) — Encrypted Event Store + sync sequencing (TechSpec §48/§54/§55,
 * LOCK 10). Android uploads opaque event batches; GMweb assigns the account's
 * monotonic sequence inside the same transaction that persists each row, then
 * partial-ACKs per eventId. Payload stays opaque (encrypted in Phase 7).
 *
 * LOCK 10: sequence is PER-ACCOUNT (account_id, sequence) with a UNIQUE index
 * — clients never infer other tenants' activity from global-sequence jumps.
 * Allocation: a per-account counter row read+incremented inside the insert
 * transaction (better-sqlite3 is synchronous → naturally serialized).
 *
 * Rule 1: this store NEVER judges carrier states — events relay verbatim.
 */

class EventStore {
  /**
   * @param {import("better-sqlite3").Database} db
   */
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS event_counters (
        account_id TEXT PRIMARY KEY,
        next_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_events (
        account_id      TEXT NOT NULL,
        sequence        INTEGER NOT NULL,
        event_uuid      TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        aggregate_id    TEXT,
        source_device_id TEXT,
        ciphertext      BLOB NOT NULL,
        encoding        TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        crypto_version  INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (account_id, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON sync_events (account_id, event_uuid);
      CREATE INDEX IF NOT EXISTS idx_events_time ON sync_events (account_id, created_at);
    `);
    this.counterStmt = db.prepare(
      `INSERT INTO event_counters (account_id, next_sequence) VALUES (?, 1)
       ON CONFLICT(account_id) DO NOTHING`
    );
    this.nextSeqStmt = db.prepare(
      `SELECT next_sequence FROM event_counters WHERE account_id = ?`
    );
    this.bumpSeqStmt = db.prepare(
      `UPDATE event_counters SET next_sequence = next_sequence + 1 WHERE account_id = ?`
    );
    this.insertEventStmt = db.prepare(
      `INSERT OR IGNORE INTO sync_events
       (account_id, sequence, event_uuid, event_type, aggregate_id, source_device_id,
        ciphertext, encoding, schema_version, crypto_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.afterStmt = db.prepare(
      `SELECT sequence, event_uuid AS eventId, event_type AS type, aggregate_id AS aggregateId,
              source_device_id AS sourceDeviceId, ciphertext, encoding, schema_version AS schemaVersion,
              crypto_version AS cryptoVersion, created_at AS createdAt
       FROM sync_events WHERE account_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`
    );
    this.countStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM sync_events WHERE account_id = ?`
    );
  }

  /**
   * Ingest one batch transactionally: each accepted event gets the next
   * per-account sequence; duplicates (event_uuid already stored) are skipped
   * but DO NOT consume a sequence. Returns per-event results for partial ACK.
   */
  ingestBatch({ accountId, sourceDeviceId, events }) {
    if (!Array.isArray(events) || events.length === 0) {
      return { accepted: [], duplicates: 0 };
    }
    const accept = this.db.transaction((batch) => {
      this.counterStmt.run(accountId);
      const accepted = [];
      let duplicates = 0;
      for (const event of batch) {
        const uuid = String(event.eventId || "");
        if (!uuid) { duplicates++; continue; }
        // Opaque-bytes guard: an undecodable/empty payload can never become a
        // durable row (LOCK 13 — no silently-dropped content). The caller's
        // missing-ACK path requeues it; a permanently malformed payload ends
        // up in the device DEAD_LETTER flow instead of polluting the store.
        const payloadBuf = Buffer.isBuffer(event.payload)
          ? event.payload
          : Buffer.from(String(event.payload || ""), "base64");
        if (payloadBuf.length === 0) { duplicates++; continue; }
        const seq = this.nextSeqStmt.get(accountId).next_sequence;
        const info = this.insertEventStmt.run(
          accountId, seq, uuid,
          String(event.type || "UNKNOWN"),
          event.conversationId ? String(event.conversationId) : null,
          sourceDeviceId ? String(sourceDeviceId) : null,
          payloadBuf,
          String(event.encoding || "envelope.v1"),
          Number(event.schemaVersion) || 1,
          Number(event.cryptoVersion) || 0,
          Date.now()
        );
        if (info.changes > 0) {
          this.bumpSeqStmt.run(accountId);
          accepted.push({ eventId: uuid, serverSequence: seq });
        } else {
          duplicates++; // same event_uuid already stored — no sequence consumed
        }
      }
      return { accepted, duplicates };
    });
    return accept(events);
  }

  /** Cursor sync (§54): events after a per-account sequence cursor. */
  after(accountId, afterSequence, limit = 500) {
    const capped = Math.max(1, Math.min(1000, Number(limit) || 500));
    const rows = this.afterStmt.all(accountId, Number(afterSequence) || 0, capped + 1);
    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;
    return {
      events: page.map((r) => ({
        ...r,
        ciphertext: Buffer.from(r.ciphertext).toString("base64"),
      })),
      nextCursor: page.length ? page[page.length - 1].sequence : Number(afterSequence) || 0,
      hasMore,
    };
  }

  count(accountId) {
    return this.countStmt.get(accountId)?.n || 0;
  }
}

module.exports = { EventStore };
