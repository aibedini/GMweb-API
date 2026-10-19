# Claim long-poll

Feature ID: claim-long-poll-v1. Scope: GMweb-API only.

`POST /api/v1/agent/commands/claim` accepts an optional query `waitMs`. An
authenticated agent whose first claim is empty is held until a command is
enqueued for the same `agentId`, the clamped deadline expires, or the request
disconnects. The response body and status are unchanged; expiry returns the
existing `200 {commands: []}`.

## Requirements

- R1. Absent, 0, negative, fractional or non-numeric `waitMs` is exactly
  today's immediate path: one claim, no timers, no waiter entry.
- R2. Valid values are clamped to `[0, 25000]`. The parameter is declared in
  the route's `querystring` schema so it appears in the OpenAPI contract.
- R3. `waitMs` is honoured only when `authorizeAgent` returns an identity;
  unauthenticated callers ignore it. Runtime metadata is recorded once, at
  request start.
- R4. Every wake calls the unchanged `commandEngine.claimForAgent`; no new
  claim SQL and no parallel delivery path.
- R5. At most one waiter per `agentId`; a new waiter resolves the old one with
  the normal empty body. A global cap (500) makes excess requests immediate.
- R6. A fresh `createCommand` (`created:true`) notifies the target agent;
  idempotent replays (`created:false`) do not. A 2000 ms safety re-check covers
  inserts that bypass the hook.
- R7. Disconnect and Fastify shutdown release every waiter and timer.

## Acceptance

Immediate empty without `waitMs`; immediate command when already queued;
prompt wake after a real create; empty response at expiry; invalid values
immediate; same-agent replacement; one command for two concurrent claimers;
cross-agent isolation; disconnect releases the map; authenticated-only;
`created:false` does not wake; cap exceeded is immediate. `npm run check` and
the full `npm test` pass; OpenAPI and `docs/INTEGRATION.md` describe `waitMs`.

## Out of scope

Changing the POST method or AgentAuth canonical string, claim-v2,
`/gateway/pull`, `AndroidOutbox`, and the v1 caller-supplied `body.agentId`
trust model.
