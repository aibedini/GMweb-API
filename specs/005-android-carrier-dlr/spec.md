# Android carrier DLR and Eve delivery evidence

Shared feature ID: `android-carrier-dlr-v5`. Baseline: GMweb 0.19.17, Android Messages 3.4.12, EVE 2.7.47. This feature extends GMweb only. The source of carrier evidence is an authenticated Android report of a definitive Telephony delivery result; GMweb cannot infer it from a gateway ACK.

## User stories

1. Android can submit a stable carrier delivery report and safely retry after losing GMweb's HTTP response.
2. EVE receives one durable, signed, privacy-safe callback for each accepted DLR event, including after GMweb restarts or EVE is unavailable.
3. An operator can distinguish queue acceptance, device submission and carrier receipt using stable identities and bounded diagnostics.

## Functional requirements

- FR-001: `POST /gateway/delivery-report` uses the existing X-API-Key gateway authentication and operational rate limit. It accepts only `eventId`, `requestId`, `status`, `occurredAt`; status is `delivered|failed` and event IDs start `dlr_`.
- FR-002: Validate bounded IDs and a safe integer millisecond timestamp, then resolve `requestId` through the durable gateway request binding. Unknown IDs create no carrier fact.
- FR-003: Persist each report with `event_id UNIQUE`. Replaying the same event ID and meaning returns 2xx without another DLR, callback or send-state mutation; a bounded duplicate counter may increment. Contradictory reuse returns 409.
- FR-004: Persist the DLR and its `sms.delivered|sms.delivery_failed` Eve event in one SQLite transaction. The existing callback worker handles sending, signing, retry and restart recovery.
- FR-005: Carrier state is a separate dimension from the send ledger status. Definitive delivered evidence dominates failed evidence when reporting current carrier status; history remains append-only.
- FR-006: Callback bodies and operator diagnostics use only bounded allowlisted identifiers and outcomes. No SMS text, recipient, key, token, raw provider payload or exception is emitted.
- FR-007: Preserve EVE notification identity metadata when supplied and carry it through the pull task. Keep generation validation and gateway request identity unchanged.
- FR-008: Extend `/send/status/{requestId}`, the Eve transport-health projection and bounded operator read APIs with carrier/callback state without weakening authentication or active-transport semantics.
- FR-009: Bump the shared GMweb/EVE contract version and document Android/EVE compatibility and the absence of real-device proof.
- FR-010: Define retention, performance and transport-consolidation/MMS follow-up boundaries without claiming unsupported capabilities.

## Success criteria

- SC-001: Duplicate same-meaning reports (including after restart) yield one report row and one Eve outbox row; contradictory and unknown reports create no new evidence.
- SC-002: Fault injection before transaction commit leaves neither row; after commit but before HTTP response a retry returns a duplicate success.
- SC-003: Simulated 500, timeout and 429 callbacks remain scheduled across restart; permanent 4xx remains visible as dead letter.
- SC-004: A definitive DLR creates a carrier callback but gateway acceptance and device ACK alone do not.
- SC-005: Full syntax, unit/contract, artifact and OpenAPI gates pass. Staging and physical SIM acceptance are reported separately as NOT VERIFIED until performed.

## Boundaries and assumptions

- Device-key authentication proves the report came from a holder of the shared gateway key. It does not independently attest the Android Telephony API or isolate multiple phones that share that key.
- The given Android v3.4.12 request shape is the wire input. Its source code and a physical SIM are unavailable in this checkout.
- Existing `send.sent` is device submission; carrier events are named `sms.delivered` and `sms.delivery_failed` as requested. No fake `send.delivered` transition is added.
- Existing EVE 2.7.47 may need a contract/ingestion update for v5; this task does not edit that repository.
