# Implementation Plan: Android Gateway Observability

**Branch**: `feat/android-gateway-observability` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)

## Summary

Extend the existing Android pull bridge with a single bounded in-memory telemetry model, instrument the existing gateway routes without changing their delivery decisions, project telemetry through the existing transport-health authority, add independent gateway-key and AgentAuth probes, and expose a privacy-safe admin/dashboard view.

## Technical Context

**Language/Version**: Node.js 22.13+, TypeScript/React dashboard
**Primary Dependencies**: Fastify 5, existing AndroidOutbox, AgentAuthService, DeviceKeyStore, React/Vite
**Storage**: Existing SQLite/Redis delivery stores unchanged; telemetry is bounded process memory
**Testing**: Node built-in test runner plus dashboard build/artifact verification
**Target Platform**: Linux-hosted GMweb API and browser dashboard
**Project Type**: Web service with bundled dashboard
**Performance Goals**: Constant-time snapshot operations; no ledger or message scan per diagnostic refresh
**Constraints**: No delivery-state mutation, no secret/payload exposure, legacy Android compatibility, 24-hour default device TTL
**Scale/Scope**: One bridge aggregate and at most 256 recent explicit device identities per process

## Constitution Check

- Durable delivery ledger and stable request identity: PASS; telemetry observes existing decisions and never becomes delivery truth.
- ACK idempotency and revocation: PASS; existing `AndroidOutbox.acknowledge` and durable-transition logic remain authoritative.
- One readiness source: PASS; `src/transportHealth.js` is extended rather than replaced.
- Privacy: PASS; tokens are SHA-256 prefixes and diagnostics omit recipients, bodies and auth values.
- API contract: REQUIRED; bump patch version, regenerate `docs/openapi.json`, update `docs/API.md` and `docs/INTEGRATION.md`.
- Performance: PASS by design; bounded maps and queue/outbox counters only, no database scan.
- Production evidence: physical Android, deployment, proxy/TLS and real-SMS acceptance remain NOT RUN.

## Project Structure

```text
src/
├── gatewayPresence.js       # bounded privacy-safe telemetry
├── gatewayRoutes.js         # pull/ping/status/validate/ack instrumentation
├── transportHealth.js       # authoritative health projection
├── controlPlaneRoutes.js    # pure AgentAuth ping
└── server.js                # dependency wiring, health/admin schemas
dashboard-next/src/pages/
└── Controls.tsx             # operational gateway panel
test/
├── gatewayPresence.test.js
├── gatewayContract.test.js
├── androidGateway.test.js
├── transportHealth.test.js
└── controlPlaneApi.test.js
docs/
├── API.md
├── INTEGRATION.md
└── openapi.json
```

**Structure Decision**: Preserve the existing modular-monolith boundaries. Add one dependency-free telemetry module and inject it into gateway routes and transport health.

## Complexity Tracking

No constitution violation or new external dependency is required.
