"use strict";

const crypto = require("node:crypto");
const { validateStoredBatch } = require("./eventCryptoPolicy");

function eventPage(rows, afterSequence, limit) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: page.map((row) => ({ ...row, ciphertext: Buffer.from(row.ciphertext).toString("base64") })),
    nextCursor: page.length ? page[page.length - 1].sequence : Number(afterSequence) || 0,
    hasMore,
  };
}

function encodeCursor(parts) {
  return Buffer.from(JSON.stringify(parts)).toString("base64url");
}

function decodeCursor(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    return Array.isArray(parsed) && parsed.length === fallback.length ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function ensureColumn(db, table, column, declaration) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
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
      CREATE TABLE IF NOT EXISTS replica_metadata (
        account_id TEXT PRIMARY KEY,
        replica_generation TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        minimum_available_sequence INTEGER NOT NULL,
        migration_version INTEGER NOT NULL,
        migration_completed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS linked_client_sync_state (
        account_id TEXT NOT NULL,
        linked_device_id TEXT NOT NULL,
        last_acked_sequence INTEGER NOT NULL,
        replica_generation TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, linked_device_id)
      );
      CREATE INDEX IF NOT EXISTS idx_linked_sync_ack
        ON linked_client_sync_state(account_id, last_acked_sequence);
      CREATE TABLE IF NOT EXISTS sync_events (
        account_id      TEXT NOT NULL,
        sequence        INTEGER NOT NULL,
        event_uuid      TEXT NOT NULL,
        event_type      TEXT NOT NULL,
        aggregate_id    TEXT,
        message_id      TEXT,
        revision        INTEGER NOT NULL DEFAULT 1,
        sort_key        INTEGER NOT NULL DEFAULT 0,
        source_device_id TEXT,
        ciphertext      BLOB NOT NULL,
        encoding        TEXT NOT NULL,
        schema_version  INTEGER NOT NULL,
        crypto_version  INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        PRIMARY KEY (account_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS encrypted_message_state (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sort_key INTEGER NOT NULL,
        tombstone INTEGER NOT NULL DEFAULT 0,
        event_type TEXT NOT NULL,
        envelope BLOB NOT NULL,
        encoding TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        crypto_version INTEGER NOT NULL,
        last_server_sequence INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_message_state_page
        ON encrypted_message_state(account_id, conversation_id, sort_key DESC, message_id DESC);
      CREATE TABLE IF NOT EXISTS encrypted_conversation_state (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        sort_key INTEGER NOT NULL,
        tombstone INTEGER NOT NULL DEFAULT 0,
        envelope BLOB NOT NULL,
        encoding TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        crypto_version INTEGER NOT NULL,
        last_server_sequence INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, conversation_id)
      );
      CREATE INDEX IF NOT EXISTS idx_conversation_state_page
        ON encrypted_conversation_state(account_id, sort_key DESC, conversation_id DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_uuid ON sync_events (account_id, event_uuid);
      CREATE INDEX IF NOT EXISTS idx_events_time ON sync_events (account_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_grant_target
        ON sync_events(account_id, json_extract(CAST(ciphertext AS TEXT), '$.deviceId'), sequence)
        WHERE event_type IN ('KEY_GRANT', 'CONTACTS_KEY_GRANT') AND json_valid(CAST(ciphertext AS TEXT));
      CREATE INDEX IF NOT EXISTS idx_events_key_target_v3
        ON sync_events(account_id, json_extract(CAST(ciphertext AS TEXT), '$.deviceId'), sequence)
        WHERE event_type IN ('KEYRING_ENTRY', 'HISTORY_KEY_GRANT') AND json_valid(CAST(ciphertext AS TEXT));
    `);
    ensureColumn(db, "sync_events", "message_id", "TEXT");
    ensureColumn(db, "sync_events", "revision", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "sync_events", "sort_key", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "encrypted_message_state", "event_type", "TEXT NOT NULL DEFAULT 'MESSAGE_CREATED'");
    ensureColumn(db, "encrypted_conversation_state", "tombstone", "INTEGER NOT NULL DEFAULT 0");
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
       (account_id, sequence, event_uuid, event_type, aggregate_id, message_id, revision, sort_key, source_device_id,
        ciphertext, encoding, schema_version, crypto_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.upsertMessageStateStmt = db.prepare(`
      INSERT INTO encrypted_message_state
        (account_id, message_id, conversation_id, revision, sort_key, tombstone, event_type,
         envelope, encoding, schema_version, crypto_version, last_server_sequence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, message_id) DO UPDATE SET
        conversation_id=excluded.conversation_id, revision=excluded.revision,
        sort_key=excluded.sort_key, tombstone=excluded.tombstone, event_type=excluded.event_type,
        envelope=excluded.envelope, encoding=excluded.encoding,
        schema_version=excluded.schema_version, crypto_version=excluded.crypto_version,
        last_server_sequence=excluded.last_server_sequence, updated_at=excluded.updated_at
      WHERE excluded.revision > encrypted_message_state.revision
         OR (excluded.revision = encrypted_message_state.revision
             AND excluded.last_server_sequence > encrypted_message_state.last_server_sequence)
    `);
    this.upsertConversationStateStmt = db.prepare(`
      INSERT INTO encrypted_conversation_state
        (account_id, conversation_id, revision, sort_key, tombstone, envelope, encoding,
         schema_version, crypto_version, last_server_sequence, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, conversation_id) DO UPDATE SET
        revision=excluded.revision, sort_key=excluded.sort_key, tombstone=excluded.tombstone, envelope=excluded.envelope,
        encoding=excluded.encoding, schema_version=excluded.schema_version,
        crypto_version=excluded.crypto_version,
        last_server_sequence=excluded.last_server_sequence, updated_at=excluded.updated_at
      WHERE excluded.revision > encrypted_conversation_state.revision
         OR (excluded.revision = encrypted_conversation_state.revision
             AND excluded.last_server_sequence > encrypted_conversation_state.last_server_sequence)
    `);
    this.afterStmt = db.prepare(
      `SELECT sequence, event_uuid AS eventId, event_type AS type, aggregate_id AS aggregateId,
              message_id AS messageId, revision, sort_key AS sortKey,
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
    validateStoredBatch(events);
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
          event.messageId ? String(event.messageId) : null,
          Math.max(1, Number(event.revision) || 1),
          Math.max(0, Number(event.sortKey) || 0),
          sourceDeviceId ? String(sourceDeviceId) : null,
          payloadBuf,
          String(event.encoding || "envelope.v1"),
          Number(event.schemaVersion) || 1,
          Number(event.cryptoVersion) || 0,
          Date.now()
        );
        if (info.changes > 0) {
          this.bumpSeqStmt.run(accountId);
          const revision = Math.max(1, Number(event.revision) || 1);
          const sortKey = Math.max(0, Number(event.sortKey) || 0);
          const conversationId = event.conversationId ? String(event.conversationId) : "";
          const messageId = event.messageId ? String(event.messageId) : "";
          const eventType = String(event.type || "UNKNOWN");
          const now = Date.now();
          if (messageId && conversationId && ["MESSAGE_CREATED", "MESSAGE_UPDATED", "MESSAGE_STATUS_CHANGED", "MESSAGE_DELETED"].includes(eventType)) {
            this.upsertMessageStateStmt.run(
              accountId, messageId, conversationId, revision, sortKey,
              eventType === "MESSAGE_DELETED" ? 1 : 0, eventType, payloadBuf,
              String(event.encoding || "envelope.v1"), Number(event.schemaVersion) || 1,
              Number(event.cryptoVersion) || 0, seq, now, now
            );
          }
          if (conversationId && ["CONVERSATION_UPSERT", "CONVERSATION_UPSERTED", "CONVERSATION_DELETED"].includes(eventType)) {
            this.upsertConversationStateStmt.run(
              accountId, conversationId, revision, sortKey, eventType === "CONVERSATION_DELETED" ? 1 : 0, payloadBuf,
              String(event.encoding || "envelope.v1"), Number(event.schemaVersion) || 1,
              Number(event.cryptoVersion) || 0, seq, now
            );
          }
          accepted.push({ eventId: uuid, serverSequence: seq });
          inserted++;
          this.debug?.(`event_accepted eventId=${uuid} sequence=${seq} type=${type} aggregateId=${event.conversationId ? String(event.conversationId) : ""} cryptoVersion=${Number(event.cryptoVersion) || 0}`);
        } else {
          duplicates++; // same event_uuid already stored — no sequence consumed
          this.debug?.(`event_duplicate eventId=${uuid} type=${type}`);
          const old = this.existingStmt.get(accountId, uuid);
          if (old && old.ciphertext.equals(payloadBuf) && old.event_type === String(event.type || "UNKNOWN") &&
              old.aggregate_id === (event.conversationId ? String(event.conversationId) : null) &&
              old.message_id === (event.messageId ? String(event.messageId) : null) &&
              old.revision === Math.max(1, Number(event.revision) || 1) &&
              old.sort_key === Math.max(0, Number(event.sortKey) || 0) &&
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
    return { ...eventPage(rows, afterSequence, capped), ...this.replicaMetadata(accountId) };
  }

  replicaMetadata(accountId) {
    const select = this.db.prepare(`
      SELECT replica_generation AS replicaGeneration,
             snapshot_version AS snapshotVersion,
             minimum_available_sequence AS minimumAvailableSequence,
             migration_version AS migrationVersion,
             migration_completed_at AS migrationCompletedAt
      FROM replica_metadata WHERE account_id = ?
    `);
    let row = select.get(accountId);
    if (!row) {
      const now = Date.now();
      this.db.prepare(`
        INSERT OR IGNORE INTO replica_metadata
          (account_id, replica_generation, snapshot_version, minimum_available_sequence,
           migration_version, migration_completed_at)
        VALUES (?, ?, 1, 1, 1, ?)
      `).run(accountId, crypto.randomUUID(), now);
      row = select.get(accountId);
    }
    return row;
  }

  acknowledgeClient(accountId, linkedDeviceId, cursor, replicaGeneration, snapshotVersion) {
    const metadata = this.replicaMetadata(accountId);
    if (replicaGeneration !== metadata.replicaGeneration || snapshotVersion !== metadata.snapshotVersion) {
      const error = new Error("replica metadata mismatch");
      error.code = "snapshot_required";
      throw error;
    }
    const highWatermark = this.highWatermark(accountId);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > highWatermark) {
      const error = new Error("invalid cursor");
      error.code = "invalid_cursor";
      throw error;
    }
    this.db.prepare(`
      INSERT INTO linked_client_sync_state
        (account_id, linked_device_id, last_acked_sequence, replica_generation, snapshot_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, linked_device_id) DO UPDATE SET
        last_acked_sequence = MAX(last_acked_sequence, excluded.last_acked_sequence),
        replica_generation = excluded.replica_generation,
        snapshot_version = excluded.snapshot_version,
        updated_at = excluded.updated_at
    `).run(accountId, linkedDeviceId, cursor, replicaGeneration, snapshotVersion, Date.now());
    return { ok: true, cursor };
  }

  compact(accountId, { retainEvents = 100000, retainMs = 7 * 24 * 60 * 60 * 1000, limit = 5000 } = {}) {
    const startedAt = Date.now();
    const highWatermark = this.highWatermark(accountId);
    const ackState = this.db.prepare(`
      SELECT MIN(CASE WHEN updated_at >= ? THEN last_acked_sequence END) AS activeSequence,
             COUNT(*) AS clientCount
      FROM linked_client_sync_state WHERE account_id = ?
    `).get(Date.now() - retainMs, accountId);
    if (!ackState.clientCount) return { rowsRemoved: 0, durationMs: Date.now() - startedAt };
    const ack = Number.isSafeInteger(ackState.activeSequence) ? ackState.activeSequence : highWatermark;
    const maxSequence = Math.min(ack, Math.max(0, highWatermark - retainEvents));
    const candidates = this.db.prepare(`
      SELECT sequence FROM sync_events
      WHERE account_id = ? AND sequence <= ? AND created_at < ?
        AND event_type IN (
          'MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MESSAGE_STATUS_CHANGED', 'MESSAGE_DELETED',
          'CONVERSATION_UPSERT', 'CONVERSATION_UPSERTED', 'CONVERSATION_DELETED', 'THREAD_READ'
        )
      ORDER BY sequence ASC LIMIT ?
    `).all(accountId, maxSequence, Date.now() - retainMs, Math.max(1, Math.min(5000, limit)));
    if (candidates.length === 0) return { rowsRemoved: 0, durationMs: Date.now() - startedAt };
    const lastDeleted = candidates.at(-1).sequence;
    const result = this.db.transaction(() => {
      const removed = this.db.prepare(`
        DELETE FROM sync_events WHERE account_id = ? AND sequence IN (
          SELECT sequence FROM sync_events
          WHERE account_id = ? AND sequence <= ? AND created_at < ?
            AND event_type IN (
              'MESSAGE_CREATED', 'MESSAGE_UPDATED', 'MESSAGE_STATUS_CHANGED', 'MESSAGE_DELETED',
              'CONVERSATION_UPSERT', 'CONVERSATION_UPSERTED', 'CONVERSATION_DELETED', 'THREAD_READ'
            )
          ORDER BY sequence ASC LIMIT ?
        )
      `).run(accountId, accountId, maxSequence, Date.now() - retainMs, candidates.length).changes;
      this.db.prepare(`
        UPDATE replica_metadata
        SET minimum_available_sequence = MAX(minimum_available_sequence, ?)
        WHERE account_id = ?
      `).run(lastDeleted + 1, accountId);
      return removed;
    })();
    const report = {
      rowsRemoved: result,
      durationMs: Date.now() - startedAt,
      minimumAvailableSequence: this.replicaMetadata(accountId).minimumAvailableSequence,
    };
    this.log?.(`compaction rowsRemoved=${report.rowsRemoved} durationMs=${report.durationMs} minimumAvailableSequence=${report.minimumAvailableSequence}`);
    return report;
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

  highWatermark(accountId) {
    this.counterStmt.run(accountId);
    return Math.max(0, Number(this.nextSeqStmt.get(accountId)?.next_sequence || 1) - 1);
  }

  conversations(accountId, cursor, limit = 100) {
    const capped = Math.max(1, Math.min(200, Number(limit) || 100));
    const [sortKey, conversationId] = decodeCursor(cursor, [Number.MAX_SAFE_INTEGER, "\uffff"]);
    const rows = this.db.prepare(`
      SELECT conversation_id AS conversationId, revision, sort_key AS sortKey, tombstone,
             envelope, encoding, schema_version AS schemaVersion,
             crypto_version AS cryptoVersion, last_server_sequence AS lastServerSequence
      FROM encrypted_conversation_state
      WHERE account_id = ? AND (sort_key < ? OR (sort_key = ? AND conversation_id < ?))
      ORDER BY sort_key DESC, conversation_id DESC LIMIT ?
    `).all(accountId, Number(sortKey), Number(sortKey), String(conversationId), capped + 1);
    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;
    return {
      conversations: page.map(row => ({ ...row, tombstone: Boolean(row.tombstone), envelope: Buffer.from(row.envelope).toString("base64") })),
      nextCursor: hasMore ? encodeCursor([page.at(-1).sortKey, page.at(-1).conversationId]) : null,
      hasMore,
    };
  }

  messages(accountId, conversationId, cursor, limit = 50) {
    const capped = Math.max(1, Math.min(100, Number(limit) || 50));
    const [sortKey, messageId] = decodeCursor(cursor, [Number.MAX_SAFE_INTEGER, "\uffff"]);
    const rows = this.db.prepare(`
      SELECT message_id AS messageId, conversation_id AS conversationId, revision,
             sort_key AS sortKey, tombstone, event_type AS type, envelope, encoding,
             schema_version AS schemaVersion, crypto_version AS cryptoVersion,
             last_server_sequence AS lastServerSequence
      FROM encrypted_message_state
      WHERE account_id = ? AND conversation_id = ?
        AND (sort_key < ? OR (sort_key = ? AND message_id < ?))
      ORDER BY sort_key DESC, message_id DESC LIMIT ?
    `).all(accountId, String(conversationId), Number(sortKey), Number(sortKey), String(messageId), capped + 1);
    const hasMore = rows.length > capped;
    const page = hasMore ? rows.slice(0, capped) : rows;
    return {
      messages: page.map(row => ({ ...row, tombstone: Boolean(row.tombstone), envelope: Buffer.from(row.envelope).toString("base64") })),
      nextCursor: hasMore ? encodeCursor([page.at(-1).sortKey, page.at(-1).messageId]) : null,
      hasMore,
    };
  }

  contactBootstrapEvents(accountId) {
    const rows = this.db.prepare(`
      SELECT sequence, event_uuid AS eventId, event_type AS type, aggregate_id AS aggregateId,
             source_device_id AS sourceDeviceId, ciphertext, encoding,
             schema_version AS schemaVersion, crypto_version AS cryptoVersion, created_at AS createdAt
      FROM sync_events
      WHERE account_id = ?
        AND event_type IN ('CONTACTS_SNAPSHOT', 'CONTACTS_CHANGED')
        AND sequence >= COALESCE((
          SELECT MAX(sequence) FROM sync_events
          WHERE account_id = ? AND event_type = 'CONTACTS_SNAPSHOT'
        ), 0)
      ORDER BY sequence ASC
    `).all(accountId, accountId);
    return eventPage(rows, 0, rows.length).events;
  }

  bootstrap(accountId, limit = 100) {
    return this.db.transaction(() => ({
      protocolVersion: 3,
      ...this.replicaMetadata(accountId),
      highWatermark: this.highWatermark(accountId),
      contactEvents: this.contactBootstrapEvents(accountId),
      ...this.conversations(accountId, null, limit),
    }))();
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
