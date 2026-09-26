# Assessment — agent replication route throttling

GitHub PR #13 CodeQL reported three high-severity missing-rate-limit alerts on
`GET /api/v1/agent/replication-capabilities`, `POST /api/v1/agent/commands/claim-v2`,
and `POST /api/v1/agent/commands/:id/status-v2`. Each route invokes agent
authorization without first using the existing `checkRateLimit` dependency.
The first route is available now; the V2 routes remain behind the disabled
lease flag. Repeated unauthorized requests can still consume auth work.

Root cause: these new handlers omitted the same per-IP limiter already used by
other control-plane handlers. Scope the fix to these three handlers. The Spec Kit
CLI is unavailable here, so this assessment and subsequent fix/test evidence
are recorded manually against the repository constitution.
