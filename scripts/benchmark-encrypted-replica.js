"use strict";

const { performance } = require("node:perf_hooks");
const Database = require("better-sqlite3");
const { EventStore } = require("../src/eventStore");

const count = Math.max(1, Number(process.argv[2]) || 360_000);
const db = new Database(":memory:");
const store = new EventStore(db);
const payload = Buffer.alloc(256, 7);
const started = performance.now();
for (let offset = 0; offset < count; offset += 100) {
  const events = [];
  for (let i = offset; i < Math.min(count, offset + 100); i += 1) {
    events.push({ eventId: `event-${i}`, type: "MESSAGE_CREATED", messageId: `message-${i}`,
      conversationId: `conversation-${i % 1_000}`, revision: 1, sortKey: i + 1,
      payload, encoding: "envelope.v3", cryptoVersion: 3 });
  }
  store.ingestBatch({ accountId: "benchmark", sourceDeviceId: "phone", events });
}
for (let offset = 0; offset < 1_000; offset += 100) {
  const events = Array.from({ length: 100 }, (_, index) => {
    const i = offset + index;
    return { eventId: `conversation-event-${i}`, type: "CONVERSATION_UPSERTED",
      conversationId: `conversation-${i}`, revision: 1, sortKey: count - i,
      payload, encoding: "envelope.v3", cryptoVersion: 3 };
  });
  store.ingestBatch({ accountId: "benchmark", sourceDeviceId: "phone", events });
}
const ingestMs = performance.now() - started;
const samples = [];
const conversationSamples = [];
const syncSamples = [];
for (let i = 0; i < 200; i += 1) {
  const begin = performance.now();
  store.messages("benchmark", `conversation-${i % 1_000}`, null, 50);
  samples.push(performance.now() - begin);
  const conversationBegin = performance.now();
  store.conversations("benchmark", null, 100);
  conversationSamples.push(performance.now() - conversationBegin);
  const syncBegin = performance.now();
  store.after("benchmark", Math.max(0, count - 500), 500);
  syncSamples.push(performance.now() - syncBegin);
}
samples.sort((a, b) => a - b);
conversationSamples.sort((a, b) => a - b);
syncSamples.sort((a, b) => a - b);
const plan = db.prepare(`EXPLAIN QUERY PLAN
  SELECT message_id FROM encrypted_message_state
  WHERE account_id = ? AND conversation_id = ?
    AND (sort_key < ? OR (sort_key = ? AND message_id < ?))
  ORDER BY sort_key DESC, message_id DESC LIMIT ?`)
  .all("benchmark", "conversation-1", Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER, "\uffff", 50).map(row => row.detail);
const conversationPlan = db.prepare(`EXPLAIN QUERY PLAN
  SELECT conversation_id FROM encrypted_conversation_state
  WHERE account_id = ? AND (sort_key < ? OR (sort_key = ? AND conversation_id < ?))
  ORDER BY sort_key DESC, conversation_id DESC LIMIT ?`)
  .all("benchmark", Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "\uffff", 100)
  .map(row => row.detail);
const plans = {
  syncAfterCursor: db.prepare(`EXPLAIN QUERY PLAN SELECT sequence FROM sync_events
    WHERE account_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`)
    .all("benchmark", count - 500, 500).map(row => row.detail),
  messageStateLookup: db.prepare(`EXPLAIN QUERY PLAN SELECT message_id FROM encrypted_message_state
    WHERE account_id = ? AND message_id = ?`).all("benchmark", "message-1").map(row => row.detail),
  compactionSelection: db.prepare(`EXPLAIN QUERY PLAN SELECT sequence FROM sync_events
    WHERE account_id = ? AND sequence <= ? AND created_at < ?
      AND event_type IN ('MESSAGE_CREATED','MESSAGE_UPDATED','MESSAGE_STATUS_CHANGED','MESSAGE_DELETED',
        'CONVERSATION_UPSERT','CONVERSATION_UPSERTED','CONVERSATION_DELETED','THREAD_READ')
    ORDER BY sequence ASC LIMIT ?`).all("benchmark", count - 100000, Date.now(), 5000).map(row => row.detail),
  linkedAckLookup: db.prepare(`EXPLAIN QUERY PLAN
    SELECT MIN(CASE WHEN updated_at >= ? THEN last_acked_sequence END), COUNT(*)
    FROM linked_client_sync_state WHERE account_id = ?`)
    .all(Date.now() - 7 * 24 * 60 * 60 * 1000, "benchmark").map(row => row.detail),
};
console.log(JSON.stringify({ count, ingestMs: Math.round(ingestMs),
  messagesPerSecond: Math.round(count / (ingestMs / 1_000)),
  messageQueryP95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(3)),
  conversationQueryP95Ms: Number(conversationSamples[Math.floor(conversationSamples.length * 0.95)].toFixed(3)),
  syncQueryP95Ms: Number(syncSamples[Math.floor(syncSamples.length * 0.95)].toFixed(3)),
  messagePlan: plan, conversationPlan, ...plans }, null, 2));
