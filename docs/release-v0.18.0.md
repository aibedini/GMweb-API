# GMweb 0.18.0 / Messages 3.3.0 remediation candidate

This candidate adds fail-closed content crypto policy across Android/API/Web, IndexedDB v7 plaintext-state purge, replica generation and snapshot recovery, ACK-gated bounded compaction, safe Android history ACK checkpoints, event-driven realtime upload wakeup, browser list virtualization, local keyset pagination, and explicit sensitive-message capability replay.

Automated Node/Web/Android unit, compile, lint, build, migration, canary, and 360k synthetic gates are documented in the remediation reports.

Physical-device and deployed production log/network canary gates remain **NOT RUN**. Do not describe this candidate as production-ready until `docs/MESSAGES-WEB-PHYSICAL-GATE.md` is completed with real evidence.

The clause-by-clause status is recorded in `docs/REMEDIATION-RFP-MATRIX.md`.
