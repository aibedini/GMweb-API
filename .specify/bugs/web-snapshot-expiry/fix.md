# Bug Fix: Web snapshot lease renewal

- **Slug**: web-snapshot-expiry
- **Fixed**: 2026-09-28
- **Assessment**: ./assessment.md
- **Status**: applied locally

## Summary

An active snapshot now renews its one-hour expiry when less than 30 minutes remain. Its token, baseline, and rows stay unchanged. A snapshot without requests still expires.

## Changes

| File | Change | Notes |
| --- | --- | --- |
| `src/eventStore.js` | modified | Renew active snapshot lease and return updated expiry. |
| `test/eventStore.test.js` | modified | Verify continuation after 80 minutes of progress and idle expiry. |

## Tests Added or Updated

- `active snapshot pages renew expiry while an idle snapshot still expires`.

## Local Verification

- `node --test test/eventStore.test.js`: 21 passed.
- `npm.cmd run check`: passed.
- Initial `npm.cmd test`: 476 passed, 1 failed due to PWA build-info version drift (0.19.18 vs package 0.19.19).
- `npm.cmd run build:frontends` and `npm.cmd run verify:artifacts`: passed; generated PWA build now matches 0.19.19.
- Final `npm.cmd test`: 478 passed, 0 failed.

## Deviations from Assessment

None.

## Follow-ups

- Deploy through the repository release process.
- Check the browser's key state and contacts display after snapshot completion.
