# Replication V2 contract draft

This is an additive contract. Existing `/api/v1/*` routes stay available during Android rollout. Final field names are frozen by fixture and generated OpenAPI when the implementation reaches the V2 activation gate.

## Capabilities

An authenticated client reads supported protocol versions, ingest limits, snapshot support, key pagination, command lease support and a feature activation flag. Seeing V2 support does not by itself enable V2 writes.

## Event ingest

Each item has a client-generated `eventId`, aggregate identity, type, occurred time, schema/crypto versions, key reference and opaque ciphertext. The result for every submitted index is `ACCEPTED`, `DUPLICATE` with original server sequence, or a safe rejection code. Only the server allocates sequence. Authorization binds source device from authentication, never a body field.

## Delta sync

`after` is the last durably stored sequence. Responses include ordered events, `nextCursor`, `highWatermark`, `hasMore`, and `replicaGeneration`. A cursor outside retained history produces `snapshot_required`; it never silently skips data. SSE is an invalidation hint.

## Snapshot

The first response supplies a snapshot token, baseline sequence, expiry, and first page. Continuations use the token and opaque keyset cursor. Every page belongs to the same baseline and generation. The browser records `snapshotComplete` only after the final page commits; then event catch-up begins after the baseline.

## Keys and commands

Key grants are filtered by authenticated device and paged with an independent cursor. Commands have stable idempotency and `clientMessageId`; claim/lease and final-result operations preserve command identity across retries. All endpoints use existing capability-scoped authentication and never expose plaintext SMS content.
