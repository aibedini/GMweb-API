# Implementation Plan: Lazy Encrypted Inbox

## Technical context

- Backend: Fastify, SQLite `encrypted_conversation_state` and `encrypted_message_state` with keyset indexes.
- Frontend: React PWA, IndexedDB ciphertext cache, WebCrypto decryption, SSE invalidation.
- Existing `/api/v1/web/bootstrap` transaction captures replica metadata, high watermark, contacts and a bounded conversation page. Existing conversation and message page routes already query indexed current state.

## Constitution check

- Preserve ciphertext-only server storage and local decryption.
- Preserve old snapshot/delta API behavior; add an opt-in `includeContacts=false` bootstrap query.
- Keep cursor honesty: observed watermark is not sent as `/web/sync/ack`.
- Keep page identity stable with keyset cursors and revision-aware cache writes.
- Bump package version and regenerate OpenAPI because the route schema changes.
- Use focused contract, concurrency and browser tests plus production evidence. Physical decryption remains NOT VERIFIED until Android QR pairing and grant acceptance are observed.

## Design

1. Add `includeContacts` to `/web/bootstrap`, default true for existing consumers. The new PWA requests false initially and true when Contacts is opened.
2. Add a lazy browser mode marker to IndexedDB metadata. On first use, atomically clear a partial/full historical replica, store the bounded initial conversation page, server generation/version, and observed watermark. Do not ACK unseen history.
3. In lazy mode, read online conversation and message pages from indexed server current state; cache ciphertext with revision/sequence guards, decrypt only requested rows, use cache while offline.
4. App startup calls lazy bootstrap instead of full snapshot. SSE and periodic polling refresh the bounded first page and selected thread. Thread first page is 10; older pages are 20. Conversation list pages at 100.
5. Make diagnostics label the mode and distinguish observed watermark from full-replica cursor and lag.

## Data model

- No server schema migration.
- New IndexedDB meta key `lazy_inbox_v1` stores a boolean marker. Existing stores hold only requested encrypted rows in this mode.
- Current-state queries remain keyed by `(account_id, sort_key, id)` and `(account_id, conversation_id, sort_key, message_id)`.

## API contract

- `GET /api/v1/web/bootstrap?limit=100&includeContacts=false`: same response shape, `contactEvents: []`, at most 100 conversations; `highWatermark`, `replicaGeneration`, and `snapshotVersion` remain present.
- Omitted `includeContacts` retains old behavior.
- `GET /api/v1/web/conversations?limit=100&cursor=...` and `/api/v1/web/conversations/{id}/messages?limit=10&before=...` remain unchanged.

## Rollout and rollback

- Ship frontend and additive backend in one atomic release. Old clients still receive contacts and can run full snapshots.
- Rollback to the previous build resumes old snapshot behavior. Lazy-mode cache can be discarded and reconstructed from server current state.

## Verification

- Cold bootstrap request counts, 10/20 thread pages, live refresh, offline cache, revision race, authentication negatives, OpenAPI drift, artifact integrity, full suite, staging/live deployment.
