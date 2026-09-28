# Bug Verification: Web snapshot lease renewal

- **Slug**: web-snapshot-expiry
- **Tested**: 2026-09-28
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: partial

## Summary

Clock-controlled local reproduction confirms that steady paging can continue beyond the old one-hour deadline and an idle snapshot still expires. Production browser completion and decryption are not verified because the patch is not deployed.

## Checks Performed

| Check | Action | Result | Notes |
| --- | --- | --- | --- |
| Reproduction | `node --test test/eventStore.test.js` | pass | 21 tests, including the new lease case. |
| Syntax | `npm.cmd run check` | pass | Repository syntax gate. |
| Regression | `npm.cmd test` | pass | 478/478 pass after rebuilding frontend artifacts. |
| Artifact integrity | `npm.cmd run verify:artifacts` | pass | API and PWA both 0.19.19. |
| Production browser | Complete snapshot and open contacts/messages | not run | Local patch not deployed; browser key state unknown. |

## Output Excerpts

- Final run: `# tests 478`, `# pass 478`, `# fail 0`.
- The initial artifact drift was repaired by the frontend build.

## Residual Risks

- Existing production snapshot still uses the old fixed expiry.
- Browser key grants and decryption require a browser-side check.
- Subsequent browser diagnostics showed `403 snapshot_forbidden` and `Primary trust root unavailable`. Those are additional immediate blockers; lease renewal alone cannot resolve the user's current session.

## Recommendation

Deploy through the repository release process, then verify the browser finishes snapshot and decrypts the data.
