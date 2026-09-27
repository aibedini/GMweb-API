# Tasks: Eve signed SMS events

- T001 [FR-001, FR-002, FR-005] Add the SQLite outbox and status triggers with immutable, bounded event bodies.
- T002 [FR-003, FR-004, FR-007] Add config validation, HMAC sender, retry scheduling and restart recovery.
- T003 [FR-006, FR-008] Integrate worker lifecycle; preserve send/ACK/revocation and transport-health semantics; declare `terminal`/`successful` on accepted `/send` responses and `statusUrl` on polling responses.
- T004 [SC-001, SC-002, SC-003] Test transitions, duplicate ACK, restart/retry, signature, privacy and both transport modes.
- T005 [SC-004] Update integration and operations docs; run syntax and full test suite; record remaining staging gates.

## Analysis before implementation

All FRs and buildable SCs map to tasks. The design uses the existing durable ledger; callback insertion occurs in the same transaction as status mutation. The missing v4 event vocabulary is resolved by the handoff's explicit event names and documented as a cross-repository contract follow-up. No unresolved contradiction blocks implementation. Status: coherent enough to proceed.
