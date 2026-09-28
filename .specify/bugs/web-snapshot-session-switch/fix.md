# Bug Fix: Recover stale device-bound snapshot

- **Slug**: web-snapshot-session-switch
- **Fixed**: 2026-09-28
- **Assessment**: ./assessment.md
- **Status**: applied locally

## Summary

The browser now treats the structured `403 snapshot_forbidden` response as a stale snapshot token and starts a new snapshot under the current linked session. Other 403 responses remain errors.

## Changes

| File | Change | Notes |
| --- | --- | --- |
| `web/src/lib/api.ts` | modified | Convert only `snapshot_forbidden` to `SnapshotRequiredError`. |
| `test/webSnapshotPageValidation.test.js` | modified | Pin both recovery and unrelated 403 behavior. |

## Tests Added or Updated

- `snapshot continuation restarts only for a stale device-bound token`.

## Local Verification

- `node --test test/webSnapshotPageValidation.test.js test/eventStore.test.js`: 23 passed.
- `npm.cmd run build:frontends` and `npm.cmd run verify:artifacts`: passed.
- `npm.cmd test`: 478 passed, 0 failed.

## Deviations from Assessment

None.

## Follow-ups

- Deploy with the repository release process.
- Pair the browser with the primary Android phone to establish its verified trust root and receive key grants.
