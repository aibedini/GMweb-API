# Research: Android Gateway Observability

## Decisions

### Reuse the existing global authentication gates

- `/gateway/*` already passes through `checkDeviceKey` in `server.js` and gateway handlers defend in depth.
- `/api/v1/agent/*` already verifies AgentAuth once and binds `request.authenticatedAgentId`.
- Decision: gateway ping/status use injected `checkDeviceKey`; agent ping reads the bound identity and role without re-verifying signatures.

### Preserve one readiness authority

- `AndroidOutbox.readyState()` owns raw pull liveness.
- `transportHealth.android()` normalizes configured/connected/stale state and `/ready` consumes its snapshot.
- Decision: telemetry supplies richer facts to `transportHealth`; no endpoint computes a second liveness rule.

### Keep telemetry process-local and bounded

- Diagnostic facts are operational hints, not delivery truth.
- A `Map` capped at 256 explicit IDs with a 24-hour TTL prevents unbounded growth.
- Snapshot pruning is proportional only to this small bound and never scans durable sends.

### Preserve ACK, validation and task contracts

- Existing validation and ACK paths encode durable revocation and canonical ACK decisions.
- Decision: observe inputs and final results around those calls; do not duplicate or branch their state machines.

### Version and OpenAPI policy

- `AGENTS.md` requires a version bump and generated OpenAPI whenever routes or schemas change.
- Decision: apply the smallest additive patch bump and use the repository's existing generator script discovered from the checkout; no invented workflow.

## Rejected Alternatives

- Persisting device telemetry: rejected because it adds migration/durability semantics without operator value.
- Deriving device identity from IP or user-agent: rejected as unstable and privacy-invasive.
- Counting open polls as devices: rejected because a normal 25-second poll cycle frequently reaches zero.
- Using event activity for pull readiness: rejected because the auth and transport paths are independent.
