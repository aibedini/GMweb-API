# ADR: Encrypted Messages-for-Web replication

Status: implemented for automated verification; physical release gate pending.

## Decision

The phone remains the source of truth. Android encrypts canonical message and conversation snapshots before its durable outbox. GMweb stores the opaque delta in `sync_events` and, in the same SQLite transaction, revision-aware current state in `encrypted_message_state` or `encrypted_conversation_state`. The Web app bootstraps current encrypted state, then continues `/api/v1/sync` at the returned high watermark.

Full-history authorization continues to use one browser-bound History Master Key (crypto v3). This design does not add per-conversation grants or a new cipher.

## Wire metadata

The outer event contains only opaque `eventId`, `conversationId`, `messageId`, `revision`, `sortKey`, event type and crypto framing. `sortKey` leaks message/conversation ordering time. It is deliberately not encrypted because indexed pagination needs it; body, address, contact name, direction, status and preview remain inside AEAD ciphertext.

## Ordering and races

Android labels outbox rows `REALTIME` or `BACKFILL`; claim order always prefers realtime. Historical production is newest-first and stops at 2,000 pending backfill rows. History uses revision 1; live mutations use a later monotonic device timestamp. GMweb updates current state only when the incoming revision is newer (or the same revision has a later committed server sequence). Tombstones therefore cannot be replaced by stale history.

## Read path

- `GET /api/v1/web/bootstrap`: atomic high watermark plus first encrypted conversation page.
- `GET /api/v1/web/conversations`: keyset conversation pagination.
- `GET /api/v1/web/conversations/:conversationId/messages`: keyset message pagination.
- `GET /api/v1/sync`: durable post-bootstrap delta.
- `GET /api/v1/sse`: cookie-authenticated contentless wake-up only.

The legacy `/conversations` automation endpoints remain compatibility surfaces and are not used by the Android-backed `/web` inbox.

## Storage and migration

SQLite remains the only server database. The two current-state tables contain no plaintext body/address columns. PWA schema v6 stores encrypted conversation/message state in IndexedDB and clears the legacy decrypted conversation projection after a non-empty encrypted bootstrap. A deployment with no v3 snapshots keeps the old local projection until Android publishes snapshots, avoiding an empty inbox during rollout.

## Remaining release boundary

Synthetic and unit verification cannot establish Android ANR/OOM, radio throughput, battery use, real carrier behavior, browser revocation on a real device, or end-to-end plaintext absence in production logs. Those remain release blockers.
