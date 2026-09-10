# Messages-for-Web security report

Automated status:

- Encrypted server state has no `body`, `address`, contact or preview columns: PASS.
- Revision-aware state rejects stale history: PASS (automated test).
- Bootstrap/history responses contain opaque envelopes only: PASS (automated test).
- PWA SSE uses the linked HttpOnly cookie and sends contentless invalidation: PASS (automated implementation/tests).
- PWA CSP, no-referrer, nosniff, permissions policy and opener isolation: PASS (configuration inspection).
- Service worker caches no authenticated API response: PASS (configuration inspection).
- Synthetic plaintext canary against state rows and history response: PASS.
- Production SQLite/Redis/app log/Nginx log/browser-storage canary scan: NOT RUN — DEPLOYED ENVIRONMENT REQUIRED.
- TLS-termination network capture: NOT RUN — DEPLOYED ENVIRONMENT REQUIRED.
- Physical pairing, decrypt, tamper and revoke matrix: NOT RUN — PHYSICAL DEVICE REQUIRED.

Known metadata leakage is limited to opaque IDs, event type, revision, ciphertext length, server sequence and ordering time (`sortKey`).
