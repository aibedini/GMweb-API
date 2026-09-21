# Bug Fix: Gateway diagnostic rate limiting

- **Slug**: gateway-probe-rate-limit
- **Fixed**: 2026-09-21
- **Assessment**: ./assessment.md
- **Status**: applied

## Summary

Reused the repository's injected request limiter for gateway ping/status, pull/validate/ACK, and AgentAuth ping. Excessive requests now receive `429 rate_limited` before bridge state is touched, without changing pull liveness, queue state or delivery decisions.

## Changes

| File | Change | Notes |
|------|--------|-------|
| `src/gatewayRoutes.js` | modified | Added a common limiter and 429 contracts for all authenticated gateway routes. |
| `src/controlPlaneRoutes.js` | modified | Added independent AgentAuth ping limiter and 429 contract. |
| `test/gatewayContract.test.js` | updated test | Pins 429 and Retry-After behavior. |
| `test/revocationHarness.js` | modified | Exposes the existing limiter injection to contract tests. |
| `docs/API.md` and `docs/INTEGRATION.md` | modified | Documents throttling behavior. |

## Tests Added or Updated

- `test/gatewayContract.test.js` — proves diagnostic, pull, and ACK routes use the injected limiter and return 429 safely.
- Existing auth-separation and control-plane tests prove both authentication dimensions still behave independently.

## Local Verification

- `node --check src/gatewayRoutes.js` → pass
- `node --check src/controlPlaneRoutes.js` → pass
- `node --test test/gatewayContract.test.js test/gatewayAuthSeparation.test.js test/controlPlaneApi.test.js` → pass

## Deviations from Assessment

AgentAuth ping and the operational pull/ACK routes received the same protection because the CodeQL finding covers authenticated handlers in both auth dimensions.

## Follow-ups

Re-run CodeQL through PR checks after push. Existing delivery endpoints remain unchanged.
