# Verification — agent replication route throttling

The regression test injects an exhausted limiter and asserts `429` plus
`Retry-After` for all three routes before an unsigned request reaches agent
authorization. Existing lease-disabled and signed-claim tests continue to
exercise the 409/authorized paths.

Local verification passed: targeted `node --test test/controlPlaneApi.test.js`,
`npm run check`, `npm test`, `npm run generate:openapi`,
`npm run build:frontends`, and `npm run verify:artifacts` (API and generated
frontends both 0.19.14). PR CodeQL re-scan is still required before merge.
These are code/CI evidence, not physical Android or production acceptance.
