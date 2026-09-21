# Bug Verification: Gateway diagnostic rate limiting

- **Slug**: gateway-probe-rate-limit
- **Tested**: 2026-09-21
- **Assessment**: ./assessment.md
- **Fix**: ./fix.md
- **Result**: verified

## Summary

The original missing-limiter behavior no longer reproduces: the injected limiter is consulted and an exceeded diagnostic allowance returns 429 with Retry-After. The complete local regression suite and artifact checks pass.

## Checks Performed

| Check | Command / Action | Result | Notes |
|-------|------------------|--------|-------|
| Reproduction after fix | Gateway contract sends two probes through a one-request allowance | pass | Second request returns 429 and does not enter bridge logic. |
| New and updated tests | `node --test test/gatewayContract.test.js test/gatewayAuthSeparation.test.js test/controlPlaneApi.test.js` | pass | Rate limiting and auth independence remain correct. |
| Regression suite | `npm test` | pass | Complete repository suite passed. |
| Syntax check | `npm run check` | pass | All configured syntax checks passed. |
| Frontend build | `npm run build:frontends` | pass | API and dashboard artifacts rebuilt for 0.19.5. |
| Artifact integrity | `npm run verify:artifacts` | pass | API and generated frontends both report 0.19.5. |
| Whitespace | `git diff --check` | pass | No whitespace errors. |

## Output Excerpts

- `frontend artifacts OK — API and generated front-ends are both 0.19.5`

## Residual Risks

- Cloud CodeQL must rerun on the pushed revision; custom repository rate limiting may require false-positive triage for older unchanged routes.
- Physical Android and deployed production acceptance remain NOT RUN.

## Recommendation

Push the fix to PR #12 and require all protected-branch checks, including CodeQL, to pass before merge.
