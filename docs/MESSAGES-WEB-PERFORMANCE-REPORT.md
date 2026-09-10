# Messages-for-Web performance report

Date: 2026-09-10. Environment: local Windows development machine, Node.js + in-memory SQLite. Script: `node scripts/benchmark-encrypted-replica.js 360000`.

Results:

- 360,000 encrypted message states plus 1,000 encrypted conversation states ingested in 10,402 ms.
- Synthetic ingest throughput: 34,610 messages/second.
- Latest-50 message query p95 over 200 samples: 1.037 ms.
- Latest-100 conversation query p95 over 200 samples: 1.214 ms.
- Message query plan: `SEARCH encrypted_message_state USING COVERING INDEX idx_message_state_page (account_id=? AND conversation_id=?)`.
- Conversation query plan: `SEARCH encrypted_conversation_state USING COVERING INDEX idx_conversation_state_page (account_id=?)`.

This proves the server query/index gate in this benchmark environment. It does not prove disk-backed production latency, browser memory, Android throughput, battery, radio latency, ANR/OOM behavior or Phone→Web p95/p99.

Physical 360k history test: **NOT RUN — PHYSICAL DEVICE REQUIRED**.
