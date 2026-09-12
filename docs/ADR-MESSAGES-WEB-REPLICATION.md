# ADR: Encrypted Messages-for-Web replication

Status: automated implementation verified; physical release gate pending.

## Decision

The phone remains the source of truth. GMweb is an encrypted durable replica, control plane, command queue, and bounded delta broker. An authorized Web client is a local decrypting replica. GMweb never receives SMS plaintext or decryption keys.

`FULL_HISTORY` uses one browser/origin-bound v3 History Master Key for ordinary messages. Sensitive categories remain separated by existing v2 capability-domain keys and explicit phone approval.

## Pipeline

```text
Telephony Provider
  -> Room source-of-truth mirror
  -> canonical message object
  -> Android encryption
  -> encrypted durable outbox (REALTIME before BACKFILL)
  -> GMweb encrypted current state + bounded delta log
  -> encrypted browser IndexedDB
  -> authorized local decryption
```

The outer event exposes only opaque IDs, event type, revision, ciphertext length, server sequence, and ordering time needed for indexed pagination. Body, address, contact, direction, status details, and preview remain inside AEAD ciphertext.

## History reliability

Historical production is newest-first and pauses when the bounded backfill queue reaches its cap. The producer watermark records what Android durably enqueued. The ACK watermark advances only across contiguous ACKed history ordinals. Completion requires provider exhaustion, a contiguous ACK through the final ordinal, and zero required dead letters. Recovery resumes/replays from durable checkpoint state with deterministic event IDs.

Realtime outbox work has priority over backfill. A committed Room outbox write wakes the uploader; a two-second timeout remains only as a reliability fallback. Revision-aware current-state UPSERTs prevent stale backfill from replacing newer realtime mutations or tombstones.

## Server replica lifecycle

GMweb publishes:

- `replicaGeneration`: persistent opaque replica identity
- `snapshotVersion`: encrypted snapshot contract version
- `minimumAvailableSequence`: oldest usable delta boundary

Linked browsers ACK a cursor only after its IndexedDB transaction commits. Compaction is ACK-gated, bounded, and limited to message/conversation/read events reconstructable from encrypted current-state tables. Key events are never compacted. Contact events are retained, and encrypted bootstrap carries the latest contact snapshot plus subsequent changes.

If a cursor is older than the retained floor, `/api/v1/sync` returns `snapshot_required`; Web transactionally installs encrypted bootstrap state and resumes from its high watermark.

## Read path

- `GET /api/v1/web/bootstrap`: encrypted current state, replica metadata, contact reconstruction events, and atomic high watermark
- `GET /api/v1/web/conversations`: keyset conversation pages
- `GET /api/v1/web/conversations/:conversationId/messages`: keyset message pages
- `GET /api/v1/sync`: durable deltas
- `POST /api/v1/web/sync/ack`: post-IndexedDB durable ACK
- `GET /api/v1/sse`: cookie-authenticated, contentless wake signal only

## Browser storage migration

IndexedDB v7 unconditionally removes legacy decrypted projections and v0 content events, resets data-plane cursors, and persists migration/replica metadata even for an empty bootstrap. Browser identity and non-extractable private keys are preserved. A replica-generation change replaces incompatible encrypted message/contact state, not device identity.

## Release boundary

Synthetic tests do not establish physical-device throughput, ANR/OOM, battery impact, real carrier behavior, deployed proxy/log plaintext absence, or real-device revocation. Those gates remain explicitly NOT RUN until executed in their required environments.
