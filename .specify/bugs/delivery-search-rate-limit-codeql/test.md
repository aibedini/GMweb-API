# Bug Verification: Gateway diagnostics route rate limit

- **Slug**: delivery-search-rate-limit-codeql
- **Verified**: 2026-09-28
- **Result**: PASS

## Acceptance Verification

- The authenticated admin diagnostics route returns `429 rate_limited` after
  its per-IP allowance is exhausted.
- The response includes a numeric `Retry-After` header.
- The limiter executes before transport and database-backed diagnostic reads;
  the regression primes the rate bucket so those dependencies are not needed.
- OpenAPI declares the 429 response and reports API version `0.19.19`.
- Generated console/PWA artifacts agree with API version `0.19.19`.

## Commands and Results

- `npm run check` — PASS.
- `node --test test/eveContract.test.js` — PASS, 11/11 tests.
- `npm run generate:openapi` — PASS; 123 paths generated.
- `npm run build:frontends` — PASS; artifacts built and verified.
- `npm run verify:artifacts` — PASS.
- `node --test test/frontendArtifacts.test.js test/eveContract.test.js` — PASS,
  18/18 tests.
- `npm test` — PASS, 476/476 tests across 20 suites.
- `git diff --check` — PASS.

## Notes

The OpenAPI generator logged expected local Redis connection refusals because
no Redis service was running; generation completed successfully with exit code
zero. Live deployed proxy behavior remains NOT VERIFIED until deployment.
