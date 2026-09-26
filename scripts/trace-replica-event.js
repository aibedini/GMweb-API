#!/usr/bin/env node
"use strict";

// Privileged, read-only local diagnostic. Never select ciphertext or message content.
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const safeId = value => value
  ? crypto.createHash("sha256").update(value).digest("hex").slice(0, 16) : null;

function traceEvent(db, accountId, eventId) {
  const row = db.prepare(`
    SELECT sequence, event_type, aggregate_id, message_id, source_device_id,
           crypto_version, created_at
    FROM sync_events WHERE account_id = ? AND event_uuid = ?
  `).get(accountId, eventId);
  const meta = db.prepare(`
    SELECT minimum_available_sequence
    FROM replica_metadata WHERE account_id = ?
  `).get(accountId);
  const next = db.prepare("SELECT next_sequence FROM event_counters WHERE account_id = ?").get(accountId);
  if (!row) return {
    presentInRetainedEvents: false,
    receipt: "UNKNOWN_AFTER_COMPACTION",
    minimumAvailableSequence: meta?.minimum_available_sequence ?? null,
    highWatermark: next ? next.next_sequence - 1 : 0,
  };
  const messageState = row.message_id ? db.prepare(`
    SELECT last_server_sequence FROM encrypted_message_state
    WHERE account_id = ? AND message_id = ?
  `).get(accountId, row.message_id) : null;
  const conversationState = row.aggregate_id ? db.prepare(`
    SELECT last_server_sequence FROM encrypted_conversation_state
    WHERE account_id = ? AND conversation_id = ?
  `).get(accountId, row.aggregate_id) : null;
  return {
    presentInRetainedEvents: true,
    eventId,
    serverSequence: row.sequence,
    eventType: row.event_type,
    aggregateHash: safeId(row.aggregate_id),
    messageHash: safeId(row.message_id),
    sourceDeviceHash: safeId(row.source_device_id),
    cryptoVersion: row.crypto_version,
    ingestedAt: row.created_at,
    keyRef: "NOT_INDEXED_SERVER_SIDE",
    rawReplicaVisibleFromCursor: row.sequence >= (meta?.minimum_available_sequence ?? 1),
    messageSnapshotStateSequence: messageState?.last_server_sequence ?? null,
    conversationSnapshotStateSequence: conversationState?.last_server_sequence ?? null,
    snapshotVisibility: row.event_type.startsWith("MESSAGE_")
      ? (messageState?.last_server_sequence === row.sequence ? "CURRENT_STATE" : "NOT_CURRENT_STATE")
      : (conversationState?.last_server_sequence === row.sequence ? "CURRENT_STATE" : "NOT_CURRENT_STATE"),
    minimumAvailableSequence: meta?.minimum_available_sequence ?? null,
    highWatermark: next ? next.next_sequence - 1 : 0,
  };
}

if (require.main === module) {
  const [filename, accountId, eventId] = process.argv.slice(2);
  if (!filename || !accountId || !eventId) {
    process.stderr.write("Usage: node scripts/trace-replica-event.js <db-path> <account-id> <event-id>\n");
    process.exitCode = 2;
  } else {
    const db = new Database(filename, { readonly: true, fileMustExist: true });
    try { process.stdout.write(`${JSON.stringify(traceEvent(db, accountId, eventId), null, 2)}\n`); }
    finally { db.close(); }
  }
}

module.exports = { traceEvent };
