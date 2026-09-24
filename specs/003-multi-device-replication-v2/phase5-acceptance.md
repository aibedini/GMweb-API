# Phase 5 acceptance — operable rollout diagnostics

Feature ID: `multi-device-replication-v2`

- Linked-session status distinguishes waiting for a history grant from a grant durably present for that browser. This is provider evidence, not proof of local key import. `test/pairingRevokeE2E.test.js` covers both stages and confirms revocation denies the old browser while another linked browser remains live.
- Linked sync diagnostics provide content-free event, snapshot, encrypted-history and requesting-browser ACK positions. `test/controlPlaneApi.test.js` covers capability denial and proves one browser's ACK position is not exposed as another's.
- `test/webSync.test.js` drops an SSE invalidation, then catches up from the IndexedDB cursor and verifies a repeated pull adds nothing.
- `npm run check`, `npm test`, `npm run generate:openapi`, `npm run build:frontends`, and `npm run verify:artifacts` passed at 0.19.12.

These checks use deterministic fixtures. Real browser network interruption, physical Android history grant, deployment and production diagnostics are NOT VERIFIED; those remain in the release gate.
