# Bug Assessment: Key failure blocks ciphertext replication

- **Slug**: key-failure-blocks-replica
- **Created**: 2026-09-23
- **Source**: user-supplied `new 39.txt`, sections 4, 18, 25–26, 101, 143
- **Verdict**: valid
- **Severity**: high

## Report

The plan identifies `bootstrapKeyGrants()` as a prerequisite of event drain. A key API failure therefore prevents ciphertext from reaching IndexedDB, even though the event API is healthy.

## Symptom and reproduction

1. Give a paired browser a valid encrypted replica and a healthy `/api/v1/sync` response.
2. Make `/api/v1/linked-device/keyring` fail.
3. Call `syncNow()`.

Before the fix, `syncNow()` rejected at key bootstrap and did not call `drainSync()`. This follows directly from the awaited call order in `web/src/lib/sync.ts`. The same ordering existed in `syncStep()`.

## Code paths and root cause

- `web/src/lib/sync.ts:syncNow()` and `syncStep()` awaited `bootstrapKeyGrants()` before initializing or draining the replica.
- `web/src/lib/sync.ts:bootstrapKeyGrants()` propagates fetch and grant-validation failures.
- `web/src/lib/sync.ts:drainSync()` owns the event cursor and ciphertext commit.

Confidence: high. A failed awaited promise skips the remainder of the `try` body.

## Proposed remediation

Catch key-bootstrap failures as a phase-specific degradation, then continue the existing replica path. Keep a failing replica fetch or IndexedDB transaction fatal to that run. Mark the browser `DEGRADED` when key bootstrap failed, without claiming `UP_TO_DATE`.

Files: `web/src/lib/sync.ts`, `test/webKeySyncDegraded.test.js`.

Test: force key fetch failure while returning an event page; assert ciphertext cursor advances and state reports `KEY_SYNC` degradation. Run existing sync and generation tests, web build, `npm run check`, and `npm test`.

## Risks and open questions

- This change covers key API failure; it does not yet make decryption and projection fully asynchronous to event persistence.
- Physical multi-browser acceptance remains NOT RUN.
