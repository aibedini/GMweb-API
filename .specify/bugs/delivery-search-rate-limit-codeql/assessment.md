# Bug Assessment: Gateway diagnostics route lacks rate limiting

- **Slug**: delivery-search-rate-limit-codeql
- **Created**: 2026-09-28
- **Source**: https://github.com/aibedini/GMweb-API/security/code-scanning/45
- **Source policy**: host `github.com`; allowlisted and fetched through the authenticated GitHub API
- **Verdict**: valid
- **Severity**: high

## Report

GitHub CodeQL alert 45 reports `js/missing-rate-limiting` on
`src/server.js:3079-3101`: the master-token-only
`GET /admin/gateway-diagnostics` handler performs several database-backed
diagnostic reads without an explicit request-rate boundary.

## Symptom

An authenticated caller can repeatedly invoke the aggregate gateway diagnostic
handler and force transport plus carrier/callback queries without the bounded
allowance used by adjacent operational endpoints. Expected behavior is a
generous per-IP limit that returns `429 rate_limited` with `Retry-After` before
any diagnostic/database work begins.

## Reproduction

1. Start the server with a master token and call `/admin/gateway-diagnostics`.
2. Repeat the authenticated request beyond the intended diagnostic allowance.
3. Observe that `checkRateLimit` is never consulted and every request performs
   the diagnostic reads.

## Suspected Code Paths

- `src/server.js:checkRateLimit()` - existing per-IP limiter used by adjacent
  administrative and EVE health routes.
- `src/server.js:/admin/gateway-diagnostics` - performs transport, carrier,
  callback and device diagnostic reads without invoking the limiter.
- `test/eveTransportHealth.test.js` - existing transport/diagnostic integration
  coverage; no regression assertion currently pins this admin route's limit.

## Root Cause Hypothesis

Confidence: high. Carrier and callback aggregates were added to the existing
admin diagnostic response in Contract v5, which made the handler database-backed,
but the route retained its previous unbounded handler shape. CodeQL correctly
identified the newly expensive route.

## Proposed Remediation

**Preferred**: apply the existing `checkRateLimit` helper at the first line of
the route handler with a generous diagnostic allowance of 120 requests per
minute per IP. On denial, return `429 {error: "rate_limited"}` and a bounded
`Retry-After` header before calling transport health, carrier report, callback
outbox or device telemetry dependencies. Declare the 429 response in the route
schema and add an injection-level regression test that proves the denied request
does not execute diagnostic work.

**Files likely to change**:

- `src/server.js`
- an existing focused diagnostic test under `test/`
- `package.json` and `package-lock.json` for the required API patch version
- `docs/openapi.json` regenerated from the route schema

**Tests to add or update**:

- Requests below the allowance still return the existing diagnostic projection.
- An exceeded allowance returns 429 with `Retry-After` before diagnostic reads.
- Existing EVE carrier/DLR and transport-health contract tests remain green.

## Risks & Considerations

- The allowance must remain high enough for the operations dashboard refresh
  cadence while still bounding abusive database reads.
- Authentication and response privacy must remain unchanged.
- This is server-side synthetic verification; deployed proxy and production
  behavior remain NOT VERIFIED.

## Open Questions

None.
