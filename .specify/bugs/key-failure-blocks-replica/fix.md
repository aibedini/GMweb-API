# Bug Fix: Key failure blocks ciphertext replication

- **Slug**: key-failure-blocks-replica
- **Fixed**: 2026-09-23
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

`syncNow()` and `syncStep()` now continue replica synchronization after a key-bootstrap exception and retain a phase-specific degraded status.

## Changes

| File | Change | Notes |
|---|---|---|
| `web/src/lib/sync.ts` | modified | Catches key-bootstrap errors in `syncKeysSafely()` and preserves `DEGRADED` after successful replica drain. |
| `test/webKeySyncDegraded.test.js` | added | Exercises a failed key service with a successful ciphertext sync page. |

## Tests added

The new test checks that the event cursor reaches sequence 1 and the status names `KEY_SYNC` while key endpoints throw.

## Local verification

- Targeted sync tests: 3 passed.
- `npm run check`: passed.
- `npm test`: 396 passed, 0 failed.
- `npm --prefix web run build`: passed (`tsc -b` and Vite build).

## Deviations from assessment

None.

## Follow-ups

- Decouple decrypt and projection from the ciphertext commit as a separate replication change.
