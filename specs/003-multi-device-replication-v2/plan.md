# Implementation Plan: Multi-device encrypted replication

**Feature ID**: `multi-device-replication-v2`
**Date**: 2026-09-23
**Spec**: [spec.md](spec.md)

## Summary

Complete the existing encrypted event and command architecture incrementally. Add a stable paged snapshot protocol, separate browser progress, explicit per-item ingest outcomes and claim leases, then converge pairing, diagnostics and scale evidence. Retain V1 until Android has adopted V2 and physical acceptance passes.

## Technical context

- **Language**: Node.js 22+, JavaScript backend, TypeScript React PWA.
- **Dependencies**: Fastify, better-sqlite3, IndexedDB, existing WebCrypto code.
- **Storage**: Existing SQLite event/command stores and additive IndexedDB migration.
- **Testing**: Node built-in test runner, fake IndexedDB, Fastify inject, TypeScript build, physical device gate.
- **Scale**: 360k synthetic messages plus concurrent realtime events and three browsers.
- **Constraint**: No plaintext server persistence, V1 compatibility, no destructive migration, account and device authorization.

## Constitution check

- **I–III, XVII–XVIII**: Durable identity and replay semantics remain authoritative. Explicit original sequence and command identity require retry/restart tests.
- **V–VIII**: Send lifecycle and physical outcomes remain governed by current ledger and Android validation. No V2 command may bypass revocation.
- **XIV–XV**: Diagnostic fields must be content-free.
- **XVI, XXII–XXIII**: Contract, race, restart, query-plan and physical evidence are required according to change shape. Synthetic tests cannot certify physical delivery.
- **Cross-repository**: Use `multi-device-replication-v2` in Android contract fixtures and acceptance report. Provider contract precedes consumer activation.

No constitution exception is planned. The codebase currently has known incomplete snapshot and key/projection separation; those are implementation tasks, not accepted exceptions.

## Delivery order

1. **Phase A — diagnostics and contract**: Inventory existing behavior, publish V2 capability and error vocabulary, align protocol document and OpenAPI while preserving V1.
2. **Phase B — ingest V2**: Add per-item accepted/duplicate/rejected ACK, safe validation and source binding; verify concurrency and restart.
3. **Phase C — browser replica separation**: Persist ciphertext and event cursor together, isolate key and projection failures, introduce separate progress and locked states.
4. **Phase D — snapshot V2**: Freeze a stable baseline, page all encrypted state, resume after crash, and begin delta from baseline only after snapshot completion.
5. **Phase E — pairing V2**: Expose durable explicit stages, full-history authorization, revoke access and progress.
6. **Phase F — command broker**: Extend existing command queue with lease recovery and client identity reconciliation while preserving current V1 command behavior.
7. **Phase G — hardening**: 360k synthetic, race/restart/security tests, rollout and rollback documentation, cross-repository fixture and physical acceptance.

## Repository touch points

```text
src/eventStore.js
src/controlPlaneRoutes.js
src/commandEngine.js
src/pairingRoutes.js
src/server.js
web/src/lib/api.ts
web/src/lib/sync.ts
web/src/lib/diagnostics.ts
web/src/app/App.tsx
test/*.test.js
docs/INTEGRATION.md
docs/openapi.json
shared/*
```

## Migration and rollback

Server schema is additive. New browser metadata is migrated without resetting identity. V1 routes stay live during rollout. Activation is capability gated. Rollback uses the previous frontend while retaining additive server columns and event rows; never downgrade or erase ciphertext. A server-side contract change bumps the package version and regenerates OpenAPI in the same commit.

## Research and contracts

- [Research decisions](research.md)
- [Data model](data-model.md)
- [V2 contract draft](contracts/replication-v2.md)
- [Validation guide](quickstart.md)
