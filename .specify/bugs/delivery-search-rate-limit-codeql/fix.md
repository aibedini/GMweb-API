# Bug Fix: Gateway diagnostics route rate limit

- **Slug**: delivery-search-rate-limit-codeql
- **Fixed**: 2026-09-28
- **Assessment**: `assessment.md`

## Implementation

- Added the existing per-IP `checkRateLimit` guard to
  `GET /admin/gateway-diagnostics` with a 120 requests/minute allowance.
- The denial path now returns `429 {"error":"rate_limited"}` and a
  `Retry-After` header before transport, carrier-report, callback, or device
  diagnostic reads execute.
- Declared the 429 response in the route schema and regenerated
  `docs/openapi.json`.
- Exposed the in-memory rate bucket only in the existing test-only export and
  added a Fastify injection regression that primes the bucket and verifies the
  denied response.
- Bumped the API patch version from `0.19.18` to `0.19.19`.

## Files Changed

- `src/server.js`
- `test/eveContract.test.js`
- `package.json`
- `package-lock.json`
- `docs/openapi.json`
- `public/web-app/index.html`
- `public/web-app/version.json`
- versioned `public/web-app/assets/` JavaScript bundle
- `.codebase-memory/artifact.json`
- `.codebase-memory/graph.db.zst`

## Targeted Verification

- `node --test test/eveContract.test.js` — passed (11 tests).
- `npm run generate:openapi` — regenerated version 0.19.19 with the 429 schema.

## Deviations

None. The fix follows the preferred remediation from the assessment.
