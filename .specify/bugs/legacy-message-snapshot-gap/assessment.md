# Legacy message snapshot gap — assessment

Status: root cause established; fix and verification pending. Shared feature ID: `android-gmweb-multidevice-v2`.

## Symptom and scope

An accepted `MESSAGE_CREATED` event without a top-level `messageId` can be durable in `sync_events` but absent from `encrypted_message_state`. A new browser's snapshot is built from `encrypted_message_state` and then advances its event cursor to the snapshot baseline. Such an event is therefore not recoverable through normal snapshot-plus-delta after the baseline. This is a server visibility gap, not proof that any particular Android SMS was lost.

Production read-only aggregate evidence (2026-09-26): 1,055,190 `MESSAGE_CREATED` raw rows, 681,307 with null `message_id`; 370,484 materialized message rows. These are counts, not a one-to-one loss tally. Recent 100,000 sequences had no null `message_id` among v2/v3 `MESSAGE_CREATED` rows. Raw event compaction means absence in `sync_events` alone cannot prove never-ingested.

## Code path

- `EventStore.ingestBatch` inserts the raw event transactionally and returns per-item `ACCEPTED` or `DUPLICATE` with sequence. Its state upsert is conditional on both `messageId` and `conversationId`.
- `EventStore.beginSnapshot` materializes message rows exclusively from `encrypted_message_state` at a transactional baseline.
- The browser finishes snapshot pages before committing the baseline cursor, then requests only later events. Its durable IndexedDB cursor write is coupled to ciphertext persistence.
- `messageStateEvent` creates a synthetic event ID. Encrypted envelope decryption checks event-ID binding, so any legacy repair must preserve the original event ID or explicitly prove a safe compatible mapping. Merely inventing a message ID or copying ciphertext into state is not sufficient.

## Local reproduction (2026-09-26)

An in-memory `EventStore` accepted a `MESSAGE_CREATED` with conversation ID and no top-level message ID: `serverSequence=1`, raw count `1`, materialized-message count `0`. A fresh browser snapshot at baseline `1` returned zero rows; the post-baseline delta also returned zero events. This reproduces the visibility gap with opaque bytes; it does not establish actual browser decryption behavior. A separate formal regression test must cover duplicate retry and genuine encrypted envelope binding before the fix.

## Constraints for fix

Preserve the opaque envelope, original event ID, account isolation and idempotency. Do not reset browser identities or delete server rows. Handle existing production rows, including compacted raw rows, with an explicit migration/compatibility policy and query-plan evidence before a large backfill. Test snapshot paging, concurrent ingest at baseline, browser IndexedDB persistence, key-unavailable recovery and restart. Avoid claiming that the 71,000 Android rows belong to this class without Android event/batch identifiers.

## Process note

`specify`/`dsh` CLI was unavailable in this environment at assessment time. This manual Spec Kit bug assessment records the assess stage; fix and test reports remain pending.

## Read-only diagnostic

`node scripts/trace-replica-event.js <db-path> <account-id> <event-id>` opens the database read-only and reports retained raw-event sequence, snapshot-state match, replica minimum sequence and high watermark. IDs other than the queried event ID are truncated SHA-256 hashes. Ciphertext and plaintext are never selected. `NOT_CURRENT_STATE` can also mean superseded by a later revision; `UNKNOWN_AFTER_COMPACTION` is not proof of nonreceipt. Browser IndexedDB/projection state cannot be established from server DB alone.
