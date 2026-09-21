# Bug Assessment: Gateway diagnostic routes lack explicit rate limiting

- **Slug**: gateway-probe-rate-limit
- **Created**: 2026-09-21
- **Source**: GitHub CodeQL check on PR #12
- **Verdict**: valid
- **Severity**: high

## Report

CodeQL `js/missing-rate-limiting` reported new authenticated gateway handlers without a rate-limit boundary. The existing validate handler already has a custom limiter, while the new ping/status handlers do not.

## Symptom

A caller holding or guessing the shared gateway credential can repeatedly invoke diagnostic authorization and status work without the repository's normal request limiter. Expected behavior is a bounded diagnostic surface returning `429 rate_limited` after the configured allowance.

## Reproduction

1. Register gateway routes with the existing `checkRateLimit` dependency.
2. Repeatedly call `/gateway/ping` or `/gateway/status` with a valid shared key.
3. Observe that the limiter dependency is never consulted.

## Suspected Code Paths

- `src/gatewayRoutes.js:registerGatewayRoutes()` — ping/status authenticate but do not call the injected limiter.
- `test/gatewayContract.test.js` — lacks a regression test for diagnostic throttling.

## Root Cause Hypothesis

Confidence: high. The diagnostic endpoints were added beside the pre-existing validate limiter, but no common gateway limiter helper was introduced and the new handlers omitted the check.

## Proposed Remediation

**Preferred**: Reuse the existing injected `checkRateLimit` dependency with a small common helper. Apply generous route-specific limits to ping/status and retain the existing validate allowance. Add a contract test proving `429` and `retry-after` without touching pull, ACK, validation decisions or queue state.

**Files likely change**:

- `src/gatewayRoutes.js`
- `test/gatewayContract.test.js`

**Tests add or update**:

- Valid credentials still succeed below the limit.
- The next diagnostic request returns `429 rate_limited` and does not mutate pull liveness.

## Risks & Considerations

- Limits must be high enough for normal diagnostics and dashboard refreshes.
- Delivery pull/ACK behavior must remain unchanged.

## Open Questions

None.
