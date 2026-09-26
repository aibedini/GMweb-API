# Messages-for-Web Performance Report

The current report is [PERFORMANCE-REMEDIATION-REPORT.md](PERFORMANCE-REMEDIATION-REPORT.md).

## Replication V2 synthetic acceptance profile (2026-09-24)

Command: `node scripts/benchmark-encrypted-replica.js 360000` on Windows x64,
Node 24.19.0, SQLite 3.53.2, in-memory SQLite. Payloads are 256-byte synthetic
buffers; no customer messages or real browser/phone participated.

| Measure | Observed |
| --- | ---: |
| Message ingest | 360,000 in 16,138 ms (22,308/s) |
| Snapshot materialization and traversal | 6,484 ms; 1,805 pages; 361,000 rows (including 1,000 conversations) |
| Snapshot message identity | 360,000 unique, no duplicate; simultaneous new message excluded from baseline |
| Post-baseline sync | 1 realtime message returned by cursor |
| Peak sampled process RSS | 738.3 MiB |
| Message / conversation / sync query p95 | 0.894 / 1.16 / 6.183 ms (200 samples each) |

`EXPLAIN QUERY PLAN` reported indexed search for compaction selection via
`sqlite_autoindex_sync_events_1 (account_id=? AND sequence<?)` and linked ACK
lookup via `idx_linked_sync_ack (account_id=?)`. The benchmark also emits
plans for message pagination, conversation pagination, cursor sync and message
state lookup so future runs can detect scan regressions. These timings include
local synthetic data only; they do not measure browser decryption, IndexedDB,
network transfer, sustained concurrency, or physical-device performance.
