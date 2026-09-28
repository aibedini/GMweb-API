# Bug Verification: Recover stale device-bound snapshot

- **Slug**: web-snapshot-session-switch
- **Tested**: 2026-09-28
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: partial

## Summary

The focused recovery test passes. Production behavior and browser decryption remain unverified because this code is not deployed and the browser lacks a locally pinned Android trust root.

## Checks Performed

| Check | Action | Result | Notes |
| --- | --- | --- | --- |
| Stale token recovery | `node --test test/webSnapshotPageValidation.test.js test/eventStore.test.js` | pass | 23 tests passed. |
| Unrelated 403 | Same command | pass | Capability denial remains an error. |
| Full regression | `npm.cmd test` | pass | 478/478 tests passed. |
| Artifact integrity | `npm.cmd run verify:artifacts` | pass | API and generated PWA both 0.19.19. |
| Production browser | Re-pair and complete snapshot | not run | Requires primary phone and deployment. |

## Residual Risks

- QR pairing and Android-issued grants are required for decryption.
- The production web build lacks this recovery change.

## Recommendation

Restore build artifact consistency, deploy through the release pipeline, re-pair using the Android primary phone, then verify trust sequence, key grants, decrypted contacts, and decrypted messages in the browser.
