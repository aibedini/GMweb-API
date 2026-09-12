# Performance Remediation Report

Date: 2026-09-12.

## Synthetic 360k benchmark

Command: `node scripts/benchmark-encrypted-replica.js 360000`

Environment: local Windows development machine, Node.js, in-memory SQLite. This is not Android/device throughput.

| Measurement | Result |
|---|---:|
| encrypted message states | 360,000 |
| encrypted conversation states | 1,000 |
| ingest duration | 10,827 ms |
| synthetic ingest rate | 33,249 messages/s |
| message page query p95 | 0.730 ms |
| conversation page query p95 | 0.816 ms |
| sync-after-cursor query p95 | 4.222 ms |

Critical query plans were index-backed:

- message page: `idx_message_state_page (account_id, conversation_id, ...)`
- conversation page: `idx_conversation_state_page (account_id, ...)`
- sync cursor: primary `(account_id, sequence)` index
- state UPSERT lookup: primary `(account_id, message_id)` index
- compaction selection: primary `(account_id, sequence)` index
- linked ACK floor: `idx_linked_sync_ack (account_id, last_acked_sequence)`

No UI hot path uses deep SQL `OFFSET` pagination.

## Runtime design

Android keeps backfill bounded and prioritizes `REALTIME` over `BACKFILL`. Room post-commit invalidation wakes the uploader; the two-second timer is fallback only. Producer and contiguous ACK watermarks are separate, and dead letters block completion.

Web uses `@tanstack/react-virtual` for conversation and message lists. IndexedDB message pages use `[conversationId, sortKey, messageId]` keyset ordering, preserve cursor semantics, and were automatically exercised across 1,050 rows/21 pages with no duplicates. Raw reconstructable deltas are bounded to the latest 10,000 sequence window.

GMweb compaction is ACK-gated, age/count bounded, limited to 5,000 rows per run, and excludes key/contact events. Stale clients receive `snapshot_required`; encrypted bootstrap carries current state and reconstructable contact history.

## Measurements not available in this environment

- disk-backed DB and WAL size: **NOT RUN** (benchmark uses in-memory SQLite)
- compaction wall time/size reduction on production data: **NOT RUN**
- browser DOM node and memory peak on a real 30k thread: **NOT RUN**
- auth-to-first-paint p95 and network page p95: **NOT RUN**
- phone-to-Web p95/p99, backfill throughput, Android peak memory, ANR/OOM, and battery delta: **NOT RUN — PHYSICAL DEVICE REQUIRED**

Synthetic results must not be presented as real-device performance.
