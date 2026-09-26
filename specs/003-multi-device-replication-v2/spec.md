# Feature Specification: Multi-device encrypted replication

**Feature ID**: `multi-device-replication-v2`
**Created**: 2026-09-23
**Status**: Draft
**Input**: User-supplied `new 39.txt`, sections 1–153. This specification covers the GMweb repository. Android consumer changes retain the same feature ID and require a separate repository implementation and physical acceptance.

## User Scenarios & Testing

### User Story 1 — Complete history on a new browser (P1)

A newly authorized browser sees its existing conversations quickly, continues loading the rest, and eventually displays the full authorized history even when the phone is offline.

**Independent test**: Pair a fresh browser against a server holding more than one page of conversations and messages; confirm first paint and eventual completion.

**Acceptance scenarios**:

1. Given 360,000 authorized messages and a new browser, when the browser pairs, then first conversations appear before full history completes and all pages eventually arrive without gaps or duplicate messages.
2. Given a new message during history loading, when catch-up finishes, then that message appears once in every authorized browser.
3. Given a browser crash after a page commit, when it restarts, then it resumes without re-pairing or losing stored ciphertext.

### User Story 2 — Key problems do not stop replication (P1)

A browser continues receiving encrypted history when its key service is temporarily unavailable. It clearly reports locked messages and unlocks them when authorized keys arrive.

**Independent test**: Fail key delivery while event delivery works, restart the browser, restore keys, and verify decryption without downloading the same ciphertext again.

**Acceptance scenarios**:

1. Given a key outage, when new events arrive, then their ciphertext is retained and the event cursor advances after durable storage.
2. Given a later valid grant, when key sync succeeds, then affected locked content is retried and projected.
3. Given an unsupported crypto version or failed authentication, then the browser distinguishes those states from a missing key.

### User Story 3 — Safe send through an offline phone (P1)

A user can request an SMS from the web while the phone is offline and see an honest queued state. A retry with the same logical identity must not create a second command.

**Independent test**: Queue a command, lose the response, restart the server and phone worker, and verify one logical command and accurate final status.

**Acceptance scenarios**:

1. Given a phone offline, when web send is accepted, then the command remains durable and visibly waits for the phone.
2. Given a lost response and retry, when the same idempotency identity is submitted, then the original command identity and state are returned.
3. Given a revoked browser, when it requests sync or a command, then access is refused while another authorized browser remains active.

### User Story 4 — Operable and compatible rollout (P2)

Operators can identify which stage is delayed without seeing message content. Existing V1 clients keep working while V2 is introduced.

**Independent test**: Run V1 and V2 contract suites together and inspect safe diagnostic output for healthy, key delayed, and snapshot delayed states.

**Acceptance scenarios**:

1. Given an older Android client, when V2 is enabled additively, then V1 ingest and sync contracts still function.
2. Given a delayed browser, when diagnostics are requested, then event, snapshot, key, projection and command progress are distinguishable without plaintext.

### Edge Cases

- Snapshot expiry or replica generation mismatch must trigger a safe restart of snapshot progress without deleting browser identity.
- A malformed event in a batch must be isolated and must not consume a sequence.
- A lost live notification must be recoverable by cursor catch-up.
- Replayed event IDs must return their original sequence and not create another logical event.
- Revocation must end future access and must not affect another authorized browser.

## Requirements

### Functional Requirements

- **FR-001**: The server MUST retain an encrypted event history with stable per-account order and idempotent event identity.
- **FR-002**: Batch ingest MUST report a result for each submitted event, including accepted, duplicate with original sequence, and rejected with safe reason.
- **FR-003**: Each authorized device MUST independently resume event delivery from its last durably stored event.
- **FR-004**: An initial history transfer MUST expose a stable baseline and support every page without advancing the event cursor past uncommitted history.
- **FR-005**: Event, snapshot, key, and projection progress MUST be tracked separately.
- **FR-006**: Key delivery or decryption failure MUST NOT prevent ciphertext storage and event progress.
- **FR-007**: Revocation MUST stop new data and command access for the revoked device without affecting other devices.
- **FR-008**: Web send commands MUST survive restart and preserve logical identity across retries and worker claims.
- **FR-009**: Live notifications MUST trigger catch-up; missed notifications MUST NOT lose data.
- **FR-010**: V1 behavior MUST remain available during the V2 rollout, with an explicit capability signal for new clients.
- **FR-011**: Diagnostics MUST distinguish phases and remain free of plaintext, recipients, keys, credentials and message bodies.
- **FR-012**: Existing encrypted replicas MUST migrate additively without clearing browser identity.

### Key Entities

- **Replicated event**: Opaque ciphertext, stable event ID, aggregate ID, source device, schema and crypto metadata, server sequence.
- **Snapshot session**: Stable baseline, generation, paging position, expiry and completion state.
- **Browser replica**: Per-device event, snapshot, key and projection progress plus encrypted local records.
- **Key grant**: Opaque browser-targeted authorization to decrypt a bounded category of content.
- **Command**: Durable web intent with stable idempotency and client message identity, claim state and honest result.
- **Device authorization**: Pairing and revocation state that gates reads, key grants and writes.

## Success Criteria

- **SC-001**: In a 360,000-message synthetic acceptance run, a new browser reaches complete history with no missing or duplicate logical messages.
- **SC-002**: In a two-page or larger snapshot run, no browser reports caught up after only the first page.
- **SC-003**: In a key outage run, every valid received ciphertext event is retained and its event progress advances; the browser reports locked content.
- **SC-004**: In a lost-response retry run, one logical event or command identity is observed after server restart.
- **SC-005**: In a three-browser run, revoking one stops its future access while the other two continue catch-up.
- **SC-006**: V1 and V2 contract suites pass together during the transition period.
- **SC-007**: Physical-device and production-like acceptance evidence is reported separately from synthetic tests.

## Assumptions

- Existing Android telephony remains the source of physical SMS outcomes.
- Existing V1 pairing and encryption identities remain valid until an explicit migration or revocation.
- This repository provides the GMweb side first; Android changes are coordinated by the shared feature ID and compatibility contract.
- Default retention cannot discard an event required by an authorized lagging device unless a complete replacement snapshot is available.
