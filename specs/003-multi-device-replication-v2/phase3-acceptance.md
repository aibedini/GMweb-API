# Phase 3 acceptance — key outage does not stop replication

Feature ID: `multi-device-replication-v2`

## Evidence

- `npm run check`: passed.
- `npm test`: passed (Node/fake-IndexedDB suite).
- `npm --prefix web run build`: passed.
- `npm run verify:artifacts`: passed at API/PWA version 0.19.10.
- `test/webKeySyncDegraded.test.js`: rejected grant leaves the ciphertext cursor durable, module reload retains it, stalled keyring fetch is aborted after two seconds, and snapshot/key progress is independent per browser identity.
- `test/messageCryptoV3.test.js`: a ciphertext remains locked before an authorized history grant and decrypts after the grant is installed.
- `test/webDiagnostics.test.js`: missing key, unsupported crypto and authentication failure have separate privacy-safe diagnostic counts; snapshot, keyring and grant positions are shown without content.

The page commit writes raw ciphertext and the event cursor in one IndexedDB transaction before key import or contact decryption. Key errors mark the run degraded without changing the event cursor. The key bootstrap cursor is device-scoped; old metadata without key positions reads as zero and is retried without resetting the event cursor.

## Limits

These are deterministic tests and a production build, not physical-browser, Android, modem, production, or 360k-message acceptance. A WebCrypto operation that ignores cancellation may finish after the two-second bound; the timeout protects event catch-up, while key import remains idempotent and a later bootstrap retries the same grant position. Physical acceptance remains in T029.
