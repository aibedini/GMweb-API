# Tasks: Android Gateway Observability

## Phase 1: Setup

- [x] T001 Record feature contract and governance artifacts in `specs/002-android-gateway-observability/`
- [x] T002 Confirm exact baseline and feature branch in Git

## Phase 2: Foundational

- [x] T003 Write focused telemetry tests in `test/gatewayPresence.test.js`
- [x] T004 Implement bounded privacy-safe telemetry in `src/gatewayPresence.js`
- [x] T005 Wire telemetry into `src/server.js`, `src/gatewayRoutes.js` and `src/transportHealth.js`

## Phase 3: User Story 1 - Pull Bridge Diagnostics

- [x] T006 [US1] Add gateway ping/status contract tests in `test/gatewayContract.test.js`
- [x] T007 [US1] Implement read-only gateway ping/status in `src/gatewayRoutes.js`
- [x] T008 [US1] Verify inactive mode, wrong key and liveness non-mutation in `test/gatewayContract.test.js`

## Phase 4: User Story 2 - Agent Authentication Diagnostics

- [x] T009 [US2] Add pure agent-ping and auth-independence tests in `test/controlPlaneApi.test.js`
- [x] T010 [US2] Implement AgentAuth-bound ping in `src/controlPlaneRoutes.js`

## Phase 5: User Story 3 - Lifecycle and Admin Observability

- [x] T011 [US3] Add pull/validate/ACK/presence/redaction tests in `test/androidGateway.test.js` and `test/gatewayContract.test.js`
- [x] T012 [US3] Instrument existing lifecycle paths in `src/gatewayRoutes.js` without altering decisions
- [x] T013 [US3] Extend health projection and warning reasons in `src/transportHealth.js`
- [x] T014 [US3] Add authenticated safe diagnostics and transport fields in `src/server.js`

## Phase 6: User Story 4 - Dashboard Operations

- [x] T015 [US4] Upgrade transport typings, status, metrics and warnings in `dashboard-next/src/pages/Controls.tsx`
- [x] T016 [US4] Add collapsible refresh/copy diagnostic panel in `dashboard-next/src/pages/Controls.tsx`

## Phase 7: Contract and Convergence

- [x] T017 Update package version, `docs/API.md` and `docs/INTEGRATION.md`
- [x] T018 Regenerate and verify `docs/openapi.json` using the repository workflow
- [x] T019 Run focused tests then the one final complete gate
- [x] T020 Run Ponytail review, address findings, approve unchanged state, commit logical groups and push the feature branch

## Dependencies & Execution Order

T003-T005 establish the shared telemetry foundation. US1 and US2 are independent after that foundation. US3 consumes lifecycle instrumentation; US4 consumes its admin contract. Contract generation and convergence follow all source changes.

## Independent Test Criteria

- **US1**: gateway credentials and reachability can be tested without changing liveness.
- **US2**: AgentAuth identity can be tested without inserting an event.
- **US3**: a synthetic lifecycle exposes safe timestamps/counters with no payload data.
- **US4**: dashboard fixtures render truthful connected/stale/unconfigured and queue-risk states.
