# Feature Specification: Android Gateway Observability

**Feature Branch**: `feat/android-gateway-observability`
**Created**: 2026-09-21
**Status**: Approved for planning
**Input**: Add privacy-safe diagnostics for the Android SMS pull bridge without changing delivery semantics.

## User Scenarios & Testing

### User Story 1 - Diagnose pull-bridge authentication (Priority: P1)

An operator or Android diagnostic can independently verify the shared gateway key and inspect pull-bridge health without claiming a task or making a stopped phone appear connected.

**Why this priority**: Event/control-plane authentication currently can appear healthy while the SMS pull bridge is unusable.

**Independent Test**: Exercise the gateway ping and status endpoints with valid and invalid keys and prove neither changes pull liveness or queue state.

**Acceptance Scenarios**:

1. **Given** pull mode and a valid device key, **When** gateway ping is requested, **Then** it returns accepted-key and bridge health data.
2. **Given** a wrong device key, **When** gateway ping or status is requested, **Then** it returns 401 without revealing key material.
3. **Given** no recent pull, **When** ping or status is requested, **Then** last-pull time remains unchanged and readiness remains stale.

---

### User Story 2 - Diagnose agent authentication separately (Priority: P1)

An Android diagnostic can verify AgentAuth identity without inserting an event or consuming an event sequence.

**Why this priority**: AgentAuth and the shared gateway key protect independent paths and must never imply each other's health.

**Independent Test**: Authenticate the agent ping with a signed request, verify its identity response and unchanged event store, then prove both asymmetric auth combinations.

**Acceptance Scenarios**:

1. **Given** valid AgentAuth, **When** agent ping is posted, **Then** the authenticated device identity and role are returned with no durable application/sync mutation.
2. **Given** valid AgentAuth and a bad gateway key, **Then** agent ping succeeds while gateway ping fails.
3. **Given** a valid gateway key and invalid AgentAuth, **Then** gateway ping succeeds while agent ping fails.

---

### User Story 3 - Observe bridge lifecycle safely (Priority: P2)

An operator can see the most recent pull, empty pull, task pull, validation and ACK, plus active polls, bounded known devices and queue counts.

**Why this priority**: Operators need to identify the exact stage at which delivery stopped without inspecting sensitive payloads.

**Independent Test**: Run synthetic pull, validate and ACK lifecycles and inspect admin diagnostics for accurate timestamps, counters and redaction.

**Acceptance Scenarios**:

1. **Given** an empty long poll, **When** it completes, **Then** it records a successful and empty pull and leaves active polls at zero.
2. **Given** a task lifecycle, **When** pull, validation and ACK occur, **Then** each safe lifecycle marker is updated without changing the existing response/state-machine semantics.
3. **Given** optional device IDs, **When** distinct devices poll within the TTL, **Then** the bounded count is accurate; legacy clients remain supported and are not fabricated as distinct devices.

---

### User Story 4 - Operate from the dashboard (Priority: P3)

An authenticated dashboard operator can distinguish connected, stale and unconfigured gateway states and see actionable queue warnings.

**Why this priority**: The current card labels open long polls as devices and can mislead incident response.

**Independent Test**: Feed connected, stale, missing-key and queue-risk snapshots into the Controls page and verify labels, warnings, refresh and safe diagnostic-copy behavior.

**Acceptance Scenarios**:

1. **Given** a fresh last pull, **When** active polls temporarily reach zero, **Then** the dashboard still reports connected.
2. **Given** pending work and stale pull liveness, **Then** the dashboard warns that messages are waiting without a connected Android device.
3. **Given** legacy clients with no device ID, **Then** known devices renders as unknown rather than the active-poll count.

### Edge Cases

- Pull mode is disabled after a key was configured.
- A long poll times out, aborts or throws; active-poll accounting must return to zero.
- A device-supplied observability ID is missing, oversized or maliciously formatted.
- Device entries expire while other device entries remain active.
- Diagnostics are requested while queue counts change concurrently.
- ACK or validation references an unknown or terminal request; existing canonical semantics remain authoritative.

## Requirements

### Functional Requirements

- **FR-001**: The existing public health response MUST add server time and process uptime without exposing deployment secrets.
- **FR-002**: Gateway ping and status MUST use the exact existing shared-key authorization used by pull, validate and ACK.
- **FR-003**: Gateway ping and status MUST be read-only and MUST NOT refresh pull liveness, claim tasks or open long polls.
- **FR-004**: Agent ping MUST use the existing global AgentAuth gate and MUST perform no durable application/sync mutation.
- **FR-005**: AgentAuth health and gateway-key health MUST remain independent in code, contracts, tests and UI wording.
- **FR-006**: One bounded, TTL-pruned telemetry source MUST track safe pull, validate, ACK, auth-failure and per-device presence data.
- **FR-007**: Pull instrumentation MUST treat an empty 200 response as successful and MUST release active-poll accounting on all completion paths.
- **FR-008**: Optional gateway device identity MUST be sanitized, used only for observability and never influence authorization.
- **FR-009**: Legacy clients without a device identity header MUST retain all current gateway behavior.
- **FR-010**: Active polls and distinct devices MUST be separate fields; no active-poll count may be presented as a device count.
- **FR-011**: Existing transport health and readiness MUST remain the sole authority and derive connectivity only from pull liveness in pull mode.
- **FR-012**: Authenticated admin diagnostics MUST expose only safe telemetry and queue aggregates, never keys, recipients or message bodies.
- **FR-013**: The dashboard MUST show status, last pull, active polls, known devices, pending, inflight, last task, last ACK and stable warnings.
- **FR-014**: Structured gateway logs MUST use irreversible short request tokens and MUST exclude authentication values, recipients and message bodies.
- **FR-015**: Existing delivery identity, dedupe, validation, ACK, revocation, retry and send-ledger semantics MUST remain unchanged.
- **FR-016**: API documentation, integration guidance, generated OpenAPI and package version MUST be updated together under repository policy.

### Key Entities

- **Gateway bridge telemetry**: A process-local aggregate of recent safe lifecycle facts and counters.
- **Gateway device presence**: A bounded, expiring observability record keyed by sanitized caller-provided identity.
- **Transport health snapshot**: The existing authoritative readiness projection enriched with gateway telemetry.

## Success Criteria

- **SC-001**: All four new diagnostic endpoints return their documented status and schema in automated contract tests.
- **SC-002**: Tests prove both asymmetric authentication combinations without coupling the two health dimensions.
- **SC-003**: Every tested timeout, abort and error path finishes with zero leaked active polls.
- **SC-004**: Diagnostic responses and copied JSON contain no supplied key, recipient or message content.
- **SC-005**: Legacy gateway requests without a device ID pass unchanged, while two fresh explicit IDs report two distinct devices and expired entries are excluded.
- **SC-006**: Existing duplicate-delivery, ACK, revocation, readiness and full repository suites remain green.

## Assumptions

- Telemetry is intentionally in-memory and resets on process restart; delivery truth remains in existing durable stores.
- Device presence uses a 24-hour default TTL and a bounded maximum entry count.
- This repository is the only repository changed; Android adoption of the optional header is future work.
