# Acceptance: lazy-encrypted-inbox-v1

## Verified locally

- `npm run check` passed.
- `npm test` passed: 479 tests, 0 failures. The new browser storage test verifies a cold bootstrap requests 100 encrypted conversation states and zero snapshot/message pages, then 10 and 20 message states for a selected thread. It also checks deferred contacts, revision ordering, offline cache and watermark polling.
- `npm run build:frontends` and `npm run verify:artifacts` passed for 0.19.20.
- `git diff --check` passed.

## Production evidence

Deployment revision, API/PWA version, and live route checks are recorded after rollout.

## Limits

Real browser decryption remains dependent on the primary Android phone publishing its signed trust root and key grants. A recovery-token linked session alone cannot establish that root. Real-device decryption and contact rendering are NOT VERIFIED by synthetic tests.
