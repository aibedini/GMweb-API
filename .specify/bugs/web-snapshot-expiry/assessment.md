# Bug Assessment: Web snapshot expires during large replica bootstrap

- **Slug**: web-snapshot-expiry
- **Created**: 2026-09-28
- **Source**: user report and read-only production diagnostics
- **Verdict**: valid
- **Severity**: high

## Report

Contacts and messages from the phone do not become usable and decrypted in the web client.

## Symptom

The browser is still fetching an encrypted snapshot long after startup. Its fixed one-hour token lifetime is shorter than the observed transfer time, causing a restart before the full replica and contact projection can complete.

## Reproduction

1. Start a web snapshot with a large encrypted replica.
2. Continue paging for more than one hour while making steady progress.
3. The server rejects the next page with `snapshot_expired`; the client starts from page one.

## Suspected Code Paths

- `src/eventStore.js:beginSnapshot` creates a fixed one-hour expiration.
- `src/eventStore.js:snapshotPage` rejects expired sessions without extending active sessions.
- `web/src/lib/sync/snapshot-sync.ts:runSnapshotBootstrap` restarts after `SnapshotRequiredError` and repairs contacts only after the final page.

## Root Cause Hypothesis

High confidence. Production has 373,642 snapshot rows. In about 20 minutes the browser fetched roughly 91,000 rows; completion at that pace exceeds one hour. The active token expires at 2026-09-28 16:31 UTC. The browser ACK cursor was last advanced on 2026-09-21, consistent with incomplete bootstrap. This establishes a snapshot completion blocker, but does not alone establish whether all browser keys are available.

## Proposed Remediation

Extend the lease of an actively progressing snapshot when it is near expiry, while retaining an inactivity expiry for abandoned snapshots. Keep the token, baseline, and immutable rows stable. Add a clock-controlled test showing continuation after one hour of steady progress and expiration after one hour without progress.

**Files likely to change**:
- `src/eventStore.js`
- `test/eventStore.test.js`

**Tests to add or update**:
- Snapshot continuation with periodic paging beyond the old fixed deadline; idle expiration remains enforced.

## Risks & Considerations

- A busy snapshot remains stored longer; abandoned snapshots still expire.
- Browser key availability and physical device sync remain separately unverified.

## Open Questions

- What exact locked/empty state appears in the user's browser?
