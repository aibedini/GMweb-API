# Eve signed SMS events

Shared feature ID: `eve-signed-events-v4`. The binding consumer contract is `shared/eve-gmweb-contract-v1.json` version 4. This feature adds callback delivery without changing the existing send, invalidation, or transport-health contracts.

## User stories

1. Eve receives a privacy-safe timeline of queued, physically sent, failed and cancelled SMS outcomes for notifications it originated.
2. An Eve outage or GMweb restart does not erase an undelivered callback; retries preserve its event and delivery IDs and body.
3. Operators can determine whether a callback is pending, delivered, or in retry without seeing message content or recipient data.

## Requirements

- FR-001: Persist each Eve send status transition and its callback in the same SQLite transaction; do not emit callbacks for non-Eve sends.
- FR-002: Use stable event/delivery IDs and immutable serialized bodies across retries and restarts.
- FR-003: Sign the exact transmitted bytes with HMAC-SHA256 over `<unix-seconds>.<delivery-id>.<body>`.
- FR-004: Retry network errors, 408, 429 and 5xx with bounded exponential backoff and jitter. Recover interrupted attempts at boot and retain bounded diagnostics.
- FR-005: Limit payloads to allowlisted operational fields. Never include SMS text, recipient, secrets, raw provider data or exception objects.
- FR-006: `send.sent` requires the durable ledger to record physical submission. No `send.delivered` is produced without genuine carrier DLR evidence.
- FR-007: Callbacks remain disabled when URL and secret are absent; invalid partial configuration fails startup rather than silently disabling.
- FR-008: Existing send metadata, generation invalidation, and transport-health behavior remain intact.

## Acceptance

- SC-001: A queued Eve send, a device ACK and an Eve 2xx produce one queued and one sent event; no delivery claim.
- SC-002: A failed callback survives restart and is retried with identical IDs/body.
- SC-003: Tests prove signature bytes, privacy, response classification, and the Android/Chrome health contract.
- SC-004: Full `npm run check` and `npm test` pass. Staging, physical device and DLR acceptance remain separate evidence gates.

## Edge cases

- A late authenticated sent ACK can correct a previously failed or cancelled row; the new sent transition must be visible.
- Duplicate ACKs and unchanged status writes do not create extra events.
- Old rows lack Eve metadata and must not be backfilled into callbacks.
- The shared version-4 JSON declares transport and send contracts but no event vocabulary; event names here follow the handoff (`send.queued`, `send.sent`, `send.failed`, `send.cancelled`). `send.delivered` is reserved until a DLR contract and evidence exist.
