# Tasks: android-carrier-dlr-v5

- T001 [FR-003, FR-004, SC-001, SC-002] Migrate the v4 Eve outbox without losing records, and add the append-only DLR table plus atomic report/outbox transaction.
- T002 [FR-001, FR-002] Implement authenticated, bounded `/gateway/delivery-report` with stable error and duplicate responses.
- T003 [FR-005, FR-008] Add separate carrier state to polling and bounded DLR/callback health/operations views.
- T004 [FR-006, FR-007] Preserve optional Eve notification identity and test all callback/log privacy bounds.
- T005 [FR-009, FR-010] Bump shared contract and package version; update OpenAPI, integration and operations docs; write retention, MMS and transport-consolidation follow-up.
- T006 [SC-001–SC-005] Add integration, duplicate, conflict, crash-window, restart, security, ordering, performance and regression evidence; run full gates.

## Pre-implementation analysis

Every FR and buildable SC maps to a task. The only external assumption is that Android's `delivered|failed` reports reflect definitive Telephony statuses; authenticated GMweb ingestion cannot independently verify modem/carrier internals. The outbox uniqueness migration and rollback caveat are explicit. The design is coherent enough to implement without weakening the constitution.

## Phase 2: Convergence

- [x] T007 Add a bounded, project-scoped structured carrier-event search with date, status, request ID, event ID and callback-state filters per FR-008 (partial).
