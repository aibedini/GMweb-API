# Bug Assessment: Browser snapshot cannot recover after linked session changes

- **Slug**: web-snapshot-session-switch
- **Created**: 2026-09-28
- **Source**: user browser diagnostics and screenshot
- **Verdict**: valid
- **Severity**: high

## Report

Browser shows `HTTP 403: {"error":"snapshot_forbidden"}`, cursor 0, incomplete snapshot at position 119200, and degraded sync.

## Symptom

An authenticated browser cannot finish or restart a snapshot after its linked session changes device identity.

## Reproduction

1. Begin a snapshot under linked device A and persist its token in the browser.
2. Establish a linked session for device B in the same browser.
3. Continue the old token; the server correctly returns `403 snapshot_forbidden`, but the web client treats it as a terminal generic error.

## Suspected Code Paths

- `src/eventStore.js:snapshotPage` binds snapshots to their initiating linked device.
- `web/src/lib/api.ts:continueWebSnapshot` converts only HTTP 409 to `SnapshotRequiredError`.
- `web/src/lib/sync/snapshot-sync.ts:runSnapshotBootstrap` can start a fresh snapshot for `SnapshotRequiredError`.

## Root Cause Hypothesis

High confidence for the recovery failure. The screenshot's exact error matches the device binding branch. The separate lack of a locally pinned Android trust root explains locked contacts and messages; this patch cannot create that trust root.

## Proposed Remediation

Treat only a structured `403 snapshot_forbidden` from the continuation route as a request to discard the old token and start a new device-bound snapshot. Preserve all other 403 errors. Add a focused test.

**Files likely to change**:
- `web/src/lib/api.ts`
- `test/webSnapshotPageValidation.test.js`

**Tests to add or update**:
- Structured `snapshot_forbidden` restarts; unrelated 403 remains an error.

## Risks & Considerations

- Restarting a very large snapshot is expensive; this must only happen when the linked device changes.
- Re-pairing with the primary Android phone is still required to establish local trust and decryption keys.

## Open Questions

- Was the browser authenticated with a recovery token or by scanning the Android pairing QR?
