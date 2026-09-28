# Acceptance report: android-carrier-dlr-v5

## Scope and state model

EVE `POST /send` → GMweb queued ledger/outbox → Android pull → validation →
modem submission ACK (`send.sent`) → definitive Android carrier receipt →
GMweb DLR ledger (`sms.delivered` or `sms.delivery_failed`) → durable signed Eve
callback. `GET /send/status/{requestId}` keeps gateway status and carrierStatus
as separate dimensions. Carrier `delivered` requires an authenticated Android
DLR; no gateway HTTP response or ACK is promoted into carrier evidence.

## Implementation and contract

- `src/gatewayRoutes.js`: bounded device-key DLR route with operational rate
  limit, stable replay/conflict/unknown errors, and no callback network I/O.
- `src/sendStore.js`: v4 Eve outbox migration preserving immutable body, IDs and
  retry state; append-only DLR rows; atomic report, physical-truth reconciliation
  and callback insertion; bounded timeline/search and indexed diagnostics.
- `src/eveSmsEvents.js`, `src/eveTransportHealth.js`, `src/server.js` and
  `src/projectKeyScopes.js`: callback health, active-transport projection,
  project-scoped status/search, and optional opaque notification identity.
- Shared contract version **4 → 5** in `shared/eve-gmweb-contract-v1.json`;
  transport-health response contract remains **1**. API version **0.19.17 →
  0.19.18**, with generated `docs/openapi.json` and rebuilt frontend artifacts.
- `docs/INTEGRATION.md` documents rollout/retention and
  `docs/ANDROID_FOLLOW_UP.md` records MMS and transport-consolidation work.

## Verification

Final `npm test`: **476 tests, 476 pass, 0 fail, 0 skipped, 0 cancelled;
35,800 ms**. `npm run check`, `npm run verify:artifacts`,
`npm run generate:openapi` and `git diff --check` passed. OpenAPI generation
printed Redis ECONNREFUSED diagnostics because Redis was unavailable, but it
wrote the 0.19.18 document with 123 paths. Synthetic tests cover replay,
conflict, unknown IDs, a failed carrier receipt, response-loss retry, restart,
transaction fault rollback, v4 outbox migration, signed callback privacy,
late receipt after revocation, device auth/body bounds/rate limiting, project
scope mapping and index use. Existing callback tests cover 500/429/network
retry and dead letter behaviour. No customer SMS was used.

The receipt/outbox atomicity claim rests on one `better-sqlite3` transaction
that inserts both rows before HTTP success, plus fault-injection and restart
tests. Idempotency rests on the `event_id` primary key and exact semantic
comparison, with tests for ten replays and contradictory reuse. The query-plan
test confirms the last-report lookup uses `idx_carrier_reports_received`.
No physical-device latency benchmark was run.

## Migration, security and performance

Startup rebuilds the v4 outbox inside one SQLite transaction to replace the
old `(send_id,event_type)` uniqueness constraint with a partial `send.*`
unique index. Existing callback retry data is preserved; a synthetic legacy
database migration test verifies this. Back up `sends.db` and WAL before
deployment. Rolling back to a pre-v5 binary requires database restoration or
a compatible schema backport.

The DLR route uses the existing shared Android key, a 1 KiB body cap, bounded
IDs/status/timestamp, and the existing gateway rate limiter. Callback payloads
are allowlisted; SMS body, recipient, credentials and raw errors are excluded.
An optional `x-gateway-device-id` is a diagnostic hint, **not** an authenticated
per-device identity. A shared key does not isolate multiple phones. Carrier
health uses durable counters and indexes; search is limited to 100 rows and
filtered by project key. Callback HTTP delivery remains asynchronous outside
the DLR transaction and cannot block the route on Eve's response.

## External acceptance and remaining gaps

- **NOT VERIFIED:** Android 3.4.12's actual Telephony receipt mapping and a
  physical SIM/carrier DLR. GMweb trusts a holder of the device key to report
  a definitive status; it cannot independently attest the modem result.
- **NOT VERIFIED:** EVE 2.7.47 ingestion of contract v5, signed callbacks and
  the Delivery log timeline. The peer checkout was not edited or byte-compared.
- **NOT VERIFIED:** Staging network delivery, real callback outage recovery,
  production credentials and the deployed Eve project's `transport:read` scope.
- **NOT RUN:** `npm run doctor`/`npm run smoke` against deployed services and a
  physical-device latency benchmark; Redis was unavailable locally.
- **NOT RUN:** `codebase-memory-mcp` coverage/detect_changes because those MCP
  tools were unavailable in this session. Targeted source reads and the full
  test suite were used instead.
- A shared gateway key remains the authority for all Android phones. Strong
  per-device DLR binding needs a separate cross-repository identity protocol.
- MMS and CONTROL_PLANE_COMMANDS parity remain separate follow-up work.

## Git state

Branch `feat/android-carrier-dlr`; HEAD before and after:
`602a0dcf7b99c00ffb0c1d072c2eccc26998be01`. The code, docs, contract,
tests, spec artifacts and generated PWA asset are uncommitted. No commit,
push, deployment or release was performed, as requested in the current handoff.
