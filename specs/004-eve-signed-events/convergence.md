# Convergence report: eve-signed-events-v4

Status: **CODE CONVERGED; STAGING NOT VERIFIED**.

## Implemented

- `eve_sms_outbox` and two SQLite triggers atomically record Eve-tagged queued, sent, failed and cancelled transitions. `sent` requires `physical_submitted=1`; manual admin completion cannot emit it.
- `/send` responses now include explicit `terminal` and `successful` fields; queued acceptance is nonterminal and does not claim submission. `/send/status/{requestId}` includes the stable `statusUrl`.
- A dedicated HTTPS callback worker signs the exact persisted UTF-8 body, retries network/408/429/5xx failures with bounded jittered exponential backoff, recovers stale claims, and records delivered or dead-letter outcomes.
- The legacy generic webhook is rejected when configured to target Eve's SMS event path. Callback bodies and logs use bounded allowlisted fields.
- No carrier-delivered event is emitted; Android/Chrome have no verified carrier DLR in this checkout.

## Evidence

- `node --test test/eveSmsEvents.test.js`: 7/7 pass. Covers fixed signature bytes, privacy, transition identity, retry across restart, stale claim recovery, permanent rejection, late ACK truth and absence of fabricated DLR.
- Focused callback, key-scope, invalidation race and transport-health tests: 76/76 pass.
- `npm run check`: pass.
- `npm run build:frontends` and `npm run verify:artifacts`: pass for 0.19.17.
- `npm test`: 468/468 pass on final full run. An earlier Windows run hit an unrelated temporary-directory `EBUSY` and stale frontend artifacts before rebuild.
- `npm run generate:openapi`: generated `docs/openapi.json` for 0.19.17. Redis connection warnings occurred in this local environment; the generator completed and wrote the file.
- `git diff --check`: pass.

## Remaining acceptance gates

- NOT VERIFIED: deployed Eve key holds all six scopes, shared secret and receiver are configured, and callbacks reach Eve in staging.
- NOT VERIFIED: real Android/SIM submission, reconnect and carrier DLR capability. No real SMS was sent.
- NOT VERIFIED: byte compatibility with an EVE checkout; none is present locally. The version-4 shared JSON does not yet declare event names, so this implementation follows the handoff's explicit `send.*` names. Confirm these with EVE before deployment.
- NOT RUN: production or production-like full timeline and renewal acceptance tests.
