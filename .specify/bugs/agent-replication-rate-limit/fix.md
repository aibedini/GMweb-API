# Fix — agent replication route throttling

Use the existing `checkRateLimit` before agent authorization: 60 requests per
minute per IP for capabilities and claims, 120 for status. On exhaustion,
return `429 agent_rate_limit` and `Retry-After`. Disabled V2 routes continue to
return `409 lease_protocol_unavailable` before rate limiting; no lease rollout
is implied. Bump the API/frontend release version to 0.19.14, regenerate
OpenAPI, and document consumer retry behavior in `docs/INTEGRATION.md`.

No new rate-limit service, dependency, or persistent state is introduced.
