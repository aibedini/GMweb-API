# Plan: android-carrier-dlr-v5

## Architecture

- Add an append-only `carrier_delivery_reports` table in `data/sends.db` with `event_id` primary key, gateway and send IDs, status, occurred/received times and bounded device ID. Add indexes for current status and time-window metrics.
- Migrate `eve_sms_outbox` from the v4 table-level `UNIQUE(send_id,event_type)` to a partial unique index for legacy `send.*` types, preserving all existing rows, IDs, bodies, retry states and attempt timestamps. DLR event IDs can then each have their own `sms.*` row. Recreate existing send triggers after migration.
- `SendStore.recordCarrierReport` uses one SQLite transaction: lookup/replay/conflict decision, insert report, optional physical-truth reconciliation, insert immutable Eve callback body. Commit before the Android 2xx response. No network I/O occurs inside this transaction.
- Register the DLR route in `gatewayRoutes.js` using the existing device-key check and operational limiter. Reject unsupported fields, statuses and timestamps with stable 400/404/409 outcomes.
- Project `carrierStatus` separately on the status route and bounded callback/DLR counters on transport health. Provide a scoped operator timeline API with no SMS text/recipient.
- Extend notification metadata, shared contract v4→v5, OpenAPI, integration/operations docs and synthetic regression tests.

## Constitution checks

- I, II, XVII, XVIII: SQLite is the authority; the DLR event ID is unique, gateway task identity is not regenerated, and carrier truth is distinct from submission.
- IV–VII: Notification tags and generation validation remain in the existing ledger/final-device gate.
- XXII: Index DLR by send/time; health uses bounded aggregate/indexed queries. Callback HTTP remains asynchronous and cannot delay Android pull.
- XXIII: Automated evidence is not presented as physical SIM or staging proof.

## Migration and rollback

All existing send rows and callback rows retain their values. The outbox rebuild happens in one SQLite transaction before route startup; a failure rolls it back. Older GMweb binaries may read the new outbox but their `ON CONFLICT(send_id,event_type)` triggers require the old unique constraint, so binary rollback after migration requires the documented database restore or a compatible backport. This is a release gate, not a silent backward-compatibility claim.

## Validation

Use Fastify inject and temporary SQLite files to test auth, validation, duplicate/conflict, transaction rollback, restart recovery, callback signing/privacy, carrier status, health and regression routes. Run `npm run check`, `npm test`, OpenAPI generation, artifact verification, and a scoped query-plan/latency check. Physical SIM and EVE staging remain external gates.
