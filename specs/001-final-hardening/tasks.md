# Tasks: final-hardening-v1

## Code
- [ ] T1 `src/ackStateMachine.js` — pure ACK decision table (R6, R9, R10)
- [ ] T2 `src/androidOutbox.js` — consume the matrix; fix the tombstone branch; expose durable-replay handoff (R6, R7)
- [ ] T3 `src/sendStore.js` — expression index; `markSentFromLateAck`; once-only revocation audit (R8, R9, R12)
- [ ] T4 `src/gatewayRoutes.js` — durable replay, additive response fields + schema (R7, R8, R12)
- [ ] T5 `src/queueSnapshot.js` — idle/executing (R11)
- [ ] T6 `dashboard-next` — consume backend `idle` (R11)
- [ ] T7 `src/projectKeyScopes.js` + `server.js` — `requiredScope` on 403 + operator diagnostic (R13)
- [ ] T8 `/ready` + `/send/capacity` on transportHealth (R14)
- [ ] T9 `transportHealth` — rate-limited connect/stale transition logging (R15)
- [ ] T10 `scripts/gmweb-menu.sh` — atomic update + flock + rollback (R1, R3, R4, R5)
- [ ] T11 `adopt_git_checkout` — same gates (R2)

## Tests
- [ ] T12 `test/ackStateMachine.test.js` — cases 18–29, 40
- [ ] T13 `test/updateAtomicity.test.js` — cases 1–10, 23
- [ ] T14 `test/queueIdle.test.js` — cases 11–15
- [ ] T15 `test/ledgerWindow.test.js` — cases 16–17 (EXPLAIN QUERY PLAN)
- [ ] T16 `test/scopeDiagnostics.test.js` — cases 30–32
- [ ] T17 `test/readinessConsistency.test.js` — cases 33–35
- [ ] T18 existing suites still green — cases 36–39

## Release
- [ ] T19 version 0.19.3 + openapi + build:frontends + verify:artifacts
- [ ] T20 branch push, deploy with the new atomic flow, live verification
