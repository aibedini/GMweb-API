# GMweb API v0.17.0 — Encrypted Messages-for-Web replication v3

Pairs with **Messages v3.1.0** (matching encrypted replication protocol
`shared/messages-web-replication-v3.json`). GMweb becomes an **encrypted
replica / control plane**: it stores and relays ciphertext only and can never
read the user's SMS.

## Encrypted replica store

- `encrypted_message_state` + `encrypted_conversation_state` with
  **revision-aware UPSERT** — current state updates only on a newer revision,
  so stale backfill never overwrites a live update and tombstones are not
  resurrected.
- Snapshot consistency; primary key `(account_id, message_id)`. No plaintext
  body/address/contact columns.

## New web APIs (keyset, no OFFSET)

- `GET /api/v1/web/bootstrap` — encrypted conversation summaries +
  highWatermark + cursor; never returns all 360k messages.
- `GET /api/v1/web/conversations?cursor=&limit=` — paginated encrypted summaries.
- `GET /api/v1/web/conversations/:id/messages?before=&limit=` — latest-first,
  keyset message pages (max 100).

## PWA local replica

- Encrypted IndexedDB (ciphertext only; decrypt only to render).
- Progressive bootstrap + projection store + paged/virtualized thread reads.
- Delta sync via `/api/v1/sync` (kept) + contentless SSE `sync.available`
  wake-up.
- Web-send command with `clientMessageId` reconciliation; SSE/auth via
  `HttpOnly; Secure; SameSite` linked-session cookie (no query-string token).

## Security hardening

- CSP (`default-src 'self'; script-src 'self'; object-src 'none';
  frame-ancestors 'none'`), HSTS, no third-party scripts.
- Central log-redaction policy; `Cache-Control: no-store` on message routes.
- `sourceDeviceId` derived from authenticated agent identity, never request
  body (spoof regression test).

## Tests / benchmark

- `npm test`: **228/228** green (11 suites).
- 360k server-side benchmark passes: ingest ~33k msg/s, message/conversation
  query P95 < 1.4 ms, `COVERING INDEX` query plans.
- Migration tooling: `scripts/migrate-history-v3.js` (dry-run + `--apply`);
  dry-run shows **0 legacy accounts** on the local control-plane DB.

## Known limits / NOT RUN — DEPLOYED ENVIRONMENT REQUIRED

- Security canary + TLS-termination network capture on deployed SQLite/Redis/
  Nginx/log/browser-storage.
- Physical pairing, decrypt, tamper and revoke matrix.
- Matching **Messages v3.1.0** must be deployed together.

**Full Changelog**: https://github.com/aibedini/GMweb-API/compare/v0.16.9...v0.17.0
