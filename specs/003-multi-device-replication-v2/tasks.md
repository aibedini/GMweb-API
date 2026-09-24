# Tasks: Multi-device encrypted replication

**Feature ID**: `multi-device-replication-v2`
**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/replication-v2.md`

## Phase 1: Baseline and contract

- [X] T001 Record existing V1/V2 capability and compatibility inventory in `docs/REPLICATION_PROTOCOL_V2.md` (FR-010).
- [X] T002 Add implemented-feature capability endpoints in `src/controlPlaneRoutes.js`, update `src/server.js` authorization, bump `package.json`, regenerate `docs/openapi.json`, and update `docs/INTEGRATION.md` (FR-010).
- [X] T003 Add V1/V2 capability and authorization contract tests in `test/controlPlaneApi.test.js` (FR-010).
- [X] T004 Add per-item ingest outcome contract and duplicate original sequence in `src/eventStore.js` and `src/controlPlaneRoutes.js`, with V1 compatibility in `test/eventStore.test.js` and `test/controlPlaneApi.test.js` (FR-001–002, FR-010).

## Phase 2: User Story 1 — Complete history on a new browser (P1)

**Independent test**: More than one snapshot page and an event arriving during pagination converge on a fresh and restarted browser.

- [X] T005 [US1] Add a failing multi-page snapshot and concurrent-event regression test in `test/webEncryptedBootstrap.test.js` (FR-004, SC-002).
- [X] T006 [US1] Add immutable snapshot session state, baseline, expiry and keyset page reads in `src/eventStore.js` (FR-004).
- [X] T007 [US1] Add additive snapshot V2 endpoints and authorization in `src/controlPlaneRoutes.js` and `src/server.js`, bump `package.json`, regenerate `docs/openapi.json`, and update `docs/INTEGRATION.md` (FR-004, FR-010).
- [X] T008 [US1] Extend typed V2 snapshot responses in `web/src/lib/api.ts` (FR-004).
- [X] T009 [US1] Persist snapshot token/cursor/completion separately from event cursor, continue every page, and start delta at the baseline only after final commit in `web/src/lib/sync.ts` (FR-003–005, FR-012).
- [X] T010 [US1] Verify crash, expiry, generation mismatch, late event and two-page completion in `test/webEncryptedBootstrap.test.js` and `test/controlPlaneApi.test.js` (SC-001–002).

## Phase 3: User Story 2 — Key problems do not stop replication (P1)

**Independent test**: Key API failure leaves ciphertext and event progress intact; later grant unlocks only affected content.

- [X] T011 [US2] Add a failing decrypt-before-commit and key-timeout regression in `test/webKeySyncDegraded.test.js` (FR-005–006).
- [X] T012 [US2] Commit ciphertext and event cursor in one IndexedDB transaction before key import or decryption in `web/src/lib/sync.ts` (FR-003, FR-006).
- [X] T013 [US2] Add separate key and snapshot progress, plus migration from old metadata, in `web/src/lib/sync.ts` (FR-005, FR-012).
- [X] T014 [US2] Distinguish missing key, unsupported version and decrypt failure; retry affected locked events after grants in `web/src/lib/inbox.ts` and `web/src/lib/sync.ts` (FR-006).
- [X] T015 [US2] Add phase-specific progress and privacy-safe counts in `web/src/lib/diagnostics.ts` and `web/src/app/App.tsx` (FR-011).
- [X] T016 [US2] Verify key outage, late grant, restart and independent browser cursors in `test/webKeySyncDegraded.test.js`, `test/webProjection.test.js` and `test/webDiagnostics.test.js` (SC-003).

## Phase 4: User Story 3 — Safe send through an offline phone (P1)

**Independent test**: Queue offline, replay a lost response, restart and reclaim an expired lease without changing logical identity.

- [X] T017 [US3] Add lease expiry, lost-response replay after restart, claim ownership and guarded recovery tests in `test/commandEngine.test.js` (FR-008, SC-004).
- [X] T018 [US3] Add additive lease fields and transactional claim/reclaim in `src/commandEngine.js` (FR-008).
- [X] T019 [US3] Add command V2 result/identity fields and authorized status routes in `src/controlPlaneRoutes.js`, update `src/server.js`, bump `package.json`, regenerate `docs/openapi.json`, and update `docs/INTEGRATION.md` (FR-008, FR-010).
- [X] T020 [US3] Reconcile optimistic messages by `clientMessageId` in `web/src/app/App.tsx` and `web/src/lib/api.ts` (FR-008).
- [X] T021 [US3] Verify revoked-device denial and unaffected second device in `test/pairingRevokeE2E.test.js` (FR-007, SC-005).

## Phase 5: User Story 4 — Operable and compatible rollout (P2)

**Independent test**: Both protocol versions work together and diagnostics identify the delayed phase without content.

- [X] T022 [US4] Add durable pairing/history stages and explicit revocation tests in `src/pairingRoutes.js` and `test/pairingRevokeE2E.test.js` (FR-007, FR-011).
- [X] T023 [US4] Add stage-specific server diagnostics and secure negative tests in `src/eventStore.js`, `src/controlPlaneRoutes.js` and `test/controlPlaneApi.test.js` (FR-011).
- [X] T024 [US4] Confirm SSE loss recovers by cursor in `test/webSync.test.js` (FR-009).

## Phase 6: Scale and release evidence

- [X] T025 Add a deterministic 360k synthetic history and simultaneous realtime load profile in `scripts/benchmark-encrypted-replica.js`; record query plans, duration and peak memory in `docs/MESSAGES-WEB-PERFORMANCE-REPORT.md` (SC-001).
- [X] T026 Update V2 state machine, failure matrix, data lifecycle and migration documents in `docs/` (FR-001–012).
- [X] T027 Byte-compare shared cross-repository fixtures, bind both to release evidence in `scripts/check-pairing-release.js`, and record Android comparison (SC-006; V2 consumer activation remains gated).
- [ ] T028 Run `npm run check`, `npm test`, web build, artifact verification and OpenAPI consistency on the candidate; record exact results in `docs/REPLICATION_V2_ACCEPTANCE.md` (SC-001–006).
- [ ] T029 Complete controlled physical-device, three-browser, revocation and modem acceptance in `docs/MESSAGES-WEB-PHYSICAL-GATE.md`, then record actual evidence in `docs/REPLICATION_V2_ACCEPTANCE.md` (SC-007).
- [ ] T030 Define item and phase error taxonomy in `src/controlPlaneRoutes.js` and `web/src/lib/diagnostics.ts`, with safe contract tests in `test/controlPlaneApi.test.js` (FR-011).

## Dependencies and execution order

T001–T004 establish the provider contract and ingest semantics. T005–T010 establish snapshot consistency before T011–T016 finalize browser progress. T017–T021 can proceed after contract establishment but command activation waits for Android compatibility. T022–T024 converge observability and V1 compatibility. T025–T029 validate the completed system. Tests precede corresponding code changes. `src/controlPlaneRoutes.js` and `web/src/lib/sync.ts` tasks are sequential because they share files.

## Implementation strategy

Commit each verified, backward-compatible slice after the mandated Ponytail review and state-bound guard approval. Keep capability activation off until provider/consumer fixtures pass. Re-run convergence after each implementation pass and append any remaining buildable gaps.
