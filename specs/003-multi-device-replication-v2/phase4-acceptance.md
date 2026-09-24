# Phase 4 acceptance — staged command leases and offline send

Feature ID: `multi-device-replication-v2`

## Mechanisms and evidence

- SQLite `UNIQUE(account_id, idempotency_key)` preserves logical command identity. A mismatched payload, target or owner is rejected with HTTP 409; `test/commandEngine.test.js` and `test/controlPlaneApi.test.js` cover replay and conflict.
- The V2 claim runs in a SQLite transaction and increments `claim_generation` on a bounded lease. Reclaim only selects unaccepted V2 leases for the same target agent, preserving the command ID. Tests cover restart, lease expiry, stale generation, foreign agent and two SQLite connections.
- Agent V2 routes require a signed, bound device identity. Legacy status cannot acknowledge a V2 lease. Linked browsers can read only their own command status. `test/pairingRevokeE2E.test.js` verifies a revoked browser loses access while a second linked browser remains available.
- The PWA persists only opaque encrypted command envelopes and stable retry IDs in IndexedDB before POST. On reload it retries unknown outcomes with the same payload and idempotency key, then polls by `commandId`. A received message reconciles the optimistic bubble by `clientMessageId`. `test/webCommandOutbox.test.js` verifies storage survives module reload; this is not a full real-browser process-death test.
- `npm run check`, `npm test`, `npm run build:frontends`, `npm run verify:artifacts`, and `npm run generate:openapi` passed for 0.19.11.

## Rollout limit

`enableCommandLeases` defaults to `false`: V2 claim/status return 409 and capability negotiation reports `commands.leases: false`. A returned claim may have reached Android before the HTTP response was lost. Only Android's durable, physical-boundary dedupe by the unchanged command ID can rule out a second modem submission on reclaim. That Android contract and real-device acceptance are NOT VERIFIED; V2 leases must not be enabled in production until the cross-repository gate passes. No customer SMS was used in tests.
