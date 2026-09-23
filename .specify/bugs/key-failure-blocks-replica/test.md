# Bug Verification: Key failure blocks ciphertext replication

- **Slug**: key-failure-blocks-replica
- **Tested**: 2026-09-23
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: partial

## Summary

The automated reproduction no longer fails: a key-service exception leaves event synchronization active and the local cursor advances. Real-device and deployed-browser acceptance has not run.

## Checks performed

| Check | Command / action | Result | Notes |
|---|---|---|---|
| Key API failure reproduction | `node --test test/webKeySyncDegraded.test.js` | pass | One event stored; cursor 1; `DEGRADED` and `KEY_SYNC`. |
| Related sync regressions | `node --test test/webKeySyncDegraded.test.js test/webSync.test.js test/webReplicaGeneration.test.js` | pass | 3 tests. |
| Syntax gate | `npm run check` | pass | Syntax only. |
| Unit and contract suite | `npm test` | pass | 396 passed, 0 failed. |
| Web type check and build | `npm --prefix web run build` | pass | `tsc -b` and Vite build. |
| Physical acceptance | paired Android and multiple browsers | NOT RUN | Device and deployment required. |

## Residual risks

- Key bootstrap still runs before the replica request; a slow request can delay the drain until it fails. The failure no longer prevents persistence.
- `drainSync()` still processes grants and contacts before the ciphertext transaction. A separate change must make the commit independent of those operations.

## Recommendation

Keep this bounded fix, then complete the larger replica/projection separation before claiming Phase C converged.
