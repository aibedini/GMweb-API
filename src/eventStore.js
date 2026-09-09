"use strict";

function eventPage(rows, afterSequence, limit) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: page.map((row) => ({ ...row, ciphertext: Buffer.from(row.ciphertext).toString("base64") })),
    nextCursor: page.length ? page[page.length - 1].sequence : Number(afterSequence) || 0,
    hasMore,
  };
}

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
   * @param {object} [opts] { onEventsAccepted?: (count:number) => void,
   *        log?: (line:string) => void, debug?: (line:string) => void }
   *        onEventsAccepted: realtime hook (§44) — fired AFTER commit with the
   *        number of newly accepted events, so the SSE layer can emit
   *        {type:"sync.available"}. The store itself stays transport-blind.
   *        log/debug: optional observability sinks (default no-op) — see the
   *        batch_received / event_accepted / event_duplicate trace lines.
   */
  constructor(db, opts = {}) {
    this.onEventsAccepted = opts.onEventsAccepted || null;
    this.log = opts.log || null;
    this.debug = opts.debug || null;
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
      CREATE INDEX IF NOT EXISTS idx_events_grant_target
        ON sync_events(account_id, json_extract(CAST(ciphertext AS TEXT), '$.deviceId'), sequence)
        WHERE event_type IN ('KEY_GRANT', 'CONTACTS_KEY_GRANT') AND json_valid(CAST(ciphertext AS TEXT));
      CREATE INDEX IF NOT EXISTS idx_events_key_target_v3
        ON sync_events(account_id, json_extract(CAST(ciphertext AS TEXT), '$.deviceId'), sequence)
        WHERE event_type IN ('KEYRING_ENTRY', 'HISTORY_KEY_GRANT') AND json_valid(CAST(ciphertext AS TEXT));
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
    this.deviceGrantsAfterStmt = db.prepare(
      `SELECT sequence, event_uuid AS eventId, event_type AS type, aggregate_id AS aggregateId,
              source_device_id AS sourceDeviceId, ciphertext, encoding, schema_version AS schemaVersion,
              crypto_version AS cryptoVersion, created_at AS createdAt
       FROM sync_events
       WHERE account_id = ? AND sequence > ? AND event_type IN ('KEY_GRANT', 'CONTACTS_KEY_GRANT')
         AND json_valid(CAST(ciphertext AS TEXT))
         AND json_extract(CAST(ciphertext AS TEXT), '$.deviceId') = ?
       ORDER BY sequence ASC LIMIT ?`
    );
    this.deviceKeyringStmt = db.prepare(
      `SELECT sequence, event_uuid AS eventId, event_type AS type, aggregate_id AS aggregateId,
              source_device_id AS sourceDeviceId, ciphertext, encoding, schema_version AS schemaVersion,
              crypto_version AS cryptoVersion, created_at AS createdAt
       FROM sync_events
       WHERE account_id = ? AND event_type IN ('KEYRING_ENTRY', 'HISTORY_KEY_GRANT')
         AND json_valid(CAST(ciphertext AS TEXT))
         AND json_extract(CAST(ciphertext AS TEXT), '$.deviceId') = ?
       ORDER BY sequence ASC LIMIT ?`
    );
    this.countStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM sync_events WHERE account_id = ?`
    );
    this.existingStmt = db.prepare("SELECT * FROM sync_events WHERE account_id = ? AND event_uuid = ?");
  }

  /**
   * Ingest one batch transactionally: each accepted event gets the next
   * per-account sequence; duplicates (event_uuid already stored) are skipped
   * but DO NOT consume a sequence. Returns per-event results for partial ACK.
   */
  ingestBatch({ accountId, sourceDeviceId, events }) {
    if (!Array.isArray(events) || events.length === 0) {
      this.log?.(`batch_received sourceDeviceId=${sourceDeviceId || "unknown"} count=0 types=`);
      this.log?.(`SYNC_REPORT sourceDeviceId=${sourceDeviceId || "unknown"} received=0 accepted=0 duplicates=0 types=`);
      return { accepted: [], duplicates: 0 };
    }
    const typeSet = [...new Set(events.map((e) => String(e.type || "UNKNOWN")))].join(",");
    this.log?.(`batch_received sourceDeviceId=${sourceDeviceId || "unknown"} count=${events.length} types={${typeSet}}`);
    this.log?.(`SYNC_REPORT sourceDeviceId=${sourceDeviceId || "unknown"} received=${events.length} types={${typeSet}}`);
    const accept = this.db.transaction((batch) => {
      this.counterStmt.run(accountId);
      const accepted = [];
      let duplicates = 0;
      let inserted = 0;
      for (const event of batch) {
        const uuid = String(event.eventId || "");
        const type = String(event.type || "UNKNOWN");
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
          inserted++;
          this.debug?.(`event_accepted eventId=${uuid} sequence=${seq} type=${type} aggregateId=${event.conversationId ? String(event.conversationId) : ""} cryptoVersion=${Number(event.cryptoVersion) || 0}`);
        } else {
          duplicates++; // same event_uuid already stored — no sequence consumed
          this.debug?.(`event_duplicate eventId=${uuid} type=${type}`);
          const old = this.existingStmt.get(accountId, uuid);
          if (old && old.ciphertext.equals(payloadBuf) && old.event_type === String(event.type || "UNKNOWN") &&
              old.aggregate_id === (event.conversationId ? String(event.conversationId) : null) &&
              old.source_device_id === (sourceDeviceId ? String(sourceDeviceId) : null) &&
              old.encoding === String(event.encoding || "envelope.v1") &&
              old.schema_version === (Number(event.schemaVersion) || 1) && old.crypto_version === (Number(event.cryptoVersion) || 0)) {
            accepted.push({ eventId: uuid, serverSequence: old.sequence });
          }
        }
      }
      return { accepted, duplicates, inserted };
    });
    const result = accept(events);
    this.log?.(`SYNC_REPORT accepted=${result.accepted.length} duplicates=${result.duplicates} inserted=${result.inserted}`);
    // §44 invalidation hook — AFTER the transaction committed (durable first,
    // realtime second). Never throws into the HTTP path.
    if (result.inserted > 0 && this.onEventsAccepted) {
      try { this.onEventsAccepted(result.inserted); } catch { /* swallow */ }
    }
    return { accepted: result.accepted, duplicates: result.duplicates };
  }

  /** Cursor sync (§54): events after a per-account sequence cursor. */
  after(accountId, afterSequence, limit = 500) {
    const capped = Math.max(1, Math.min(1000, Number(limit) || 500));
    const rows = this.afterStmt.all(accountId, Number(afterSequence) || 0, capped + 1);
    return eventPage(rows, afterSequence, capped);
  }

  /** Grant envelopes addressed to the authenticated linked device only. */
  deviceGrantsAfter(accountId, deviceId, afterSequence, limit = 1000) {
    const capped = Math.max(1, Math.min(1000, Number(limit) || 1000));
    const rows = this.deviceGrantsAfterStmt.all(accountId, Number(afterSequence) || 0, deviceId, capped + 1);
    return eventPage(rows, afterSequence, capped);
  }

  /** Browser-bound v2/v3 keys; independent of the message sync cursor. */
  deviceKeyring(accountId, deviceId, limit = 1000) {
    const capped = Math.max(1, Math.min(1000, Number(limit) || 1000));
    const rows = this.deviceKeyringStmt.all(accountId, deviceId, capped + 1);
    return eventPage(rows, 0, capped);
  }

  count(accountId) {
    return this.countStmt.get(accountId)?.n || 0;
  }

  stats(accountId) {
    const group = (column) => this.db.prepare(
      `SELECT ${column} value, COUNT(*) count FROM sync_events WHERE account_id = ? GROUP BY ${column}`
    ).all(accountId).map(row => ({ value: row.value, count: row.count }));
    const last = this.db.prepare("SELECT MAX(created_at) value FROM sync_events WHERE account_id = ? AND event_type = 'MESSAGE_CREATED'").get(accountId)?.value || null;
    return {
      total: this.count(accountId),
      byType: group("event_type"),
      byCryptoVersion: group("crypto_version"),
      direction: { unknown: this.count(accountId), reason: "direction is encrypted" },
      contactsEvents: this.db.prepare("SELECT COUNT(*) count FROM sync_events WHERE account_id = ? AND event_type LIKE 'CONTACTS_%'").get(accountId)?.count || 0,
      lastBackfillTs: last,
    };
  }

  diagnosticStats(accountId, sourceDeviceId) {
    const counts = (deviceId = null) => {
      const sourceFilter = deviceId ? " AND source_device_id = ?" : "";
      const args = deviceId ? [accountId, deviceId] : [accountId];
      const scalar = (sql) => Number(this.db.prepare(sql).get(...args)?.value || 0);
      return {
        total: scalar(`SELECT COUNT(*) value FROM sync_events WHERE account_id = ?${sourceFilter}`),
        messageCreated: scalar(`SELECT COUNT(*) value FROM sync_events WHERE account_id = ?${sourceFilter} AND event_type = 'MESSAGE_CREATED'`),
        messageUpdated: scalar(`SELECT COUNT(*) value FROM sync_events WHERE account_id = ?${sourceFilter} AND event_type = 'MESSAGE_UPDATED'`),
        keyGrant: scalar(`SELECT COUNT(*) value FROM sync_events WHERE account_id = ?${sourceFilter} AND event_type = 'KEY_GRANT'`),
        byCryptoVersion: this.db.prepare(
          `SELECT crypto_version value, COUNT(*) count FROM sync_events WHERE account_id = ?${sourceFilter} GROUP BY crypto_version ORDER BY crypto_version`
        ).all(...args).map(row => ({ value: Number(row.value), count: Number(row.count) })),
        maxSequence: scalar(`SELECT COALESCE(MAX(sequence), 0) value FROM sync_events WHERE account_id = ?${sourceFilter}`),
      };
    };
    return {
      account: counts(),
      sourceDevice: counts(sourceDeviceId),
    };
  }

  /** Privacy-safe server truth for a READ_MESSAGES linked browser. */
  syncDiagnostics(accountId) {
    const scalar = (sql) => Number(this.db.prepare(sql).get(accountId)?.value || 0);
    return {
      total: scalar("SELECT COUNT(*) value FROM sync_events WHERE account_id = ?"),
      maxSequence: scalar("SELECT COALESCE(MAX(sequence), 0) value FROM sync_events WHERE account_id = ?"),
      countsByType: this.db.prepare(
        "SELECT event_type type, COUNT(*) count FROM sync_events WHERE account_id = ? GROUP BY event_type ORDER BY event_type"
      ).all(accountId).map(row => ({ type: String(row.type), count: Number(row.count) })),
      countsByCryptoVersion: this.db.prepare(
        "SELECT crypto_version cryptoVersion, COUNT(*) count FROM sync_events WHERE account_id = ? GROUP BY crypto_version ORDER BY crypto_version"
      ).all(accountId).map(row => ({ cryptoVersion: Number(row.cryptoVersion), count: Number(row.count) })),
      distinctAggregateCount: scalar(
        "SELECT COUNT(DISTINCT aggregate_id) value FROM sync_events WHERE account_id = ? AND aggregate_id IS NOT NULL"
      ),
      nullAggregateCount: scalar(
        "SELECT COUNT(*) value FROM sync_events WHERE account_id = ? AND aggregate_id IS NULL"
      ),
    };
  }
}

module.exports = { EventStore };
