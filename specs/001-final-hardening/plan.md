# Plan: final-hardening-v1

## Design decisions

### D1 — Atomic update via staging (R1–R5)
`update_app()` mirrors `deploy-gmweb.sh`:

```
flock -n /run/lock/gmweb-update.lock        # R3, exit 75 -> update_already_running
OLD_SHA=$(git rev-parse HEAD)
git fetch origin main; CANDIDATE=$(git rev-parse FETCH_HEAD)   # pinned ONCE
git archive CANDIDATE | tar -x -C $STAGE   # live checkout untouched
( cd $STAGE && npm ci --include=dev && npm run check && npm test
              && GMWEB_BUILD_REVISION=$CANDIDATE npm run build:frontends
              && node scripts/verify-frontend-artifacts.mjs )
pause/drain (only if not already manually paused)
backup .env + data (existing rotating backup)
git merge --ff-only $CANDIDATE             # the ONLY live mutation
rsync staged public/* -> live public/*
npm ci --omit=dev; restart; verify
on failure after promotion: git reset --hard OLD_SHA + restore artifacts + restart
```

Rollback artifacts are kept in the same single-backup policy
(`/root/gmweb-backup`), one snapshot only.

### D2 — ACK state machine as a pure module (R6)
`src/ackStateMachine.js`: `decideAck({durable, outbox, reported, revoked, duplicate, liveWorker})`
→ `{outcome, successful, terminal, retryable, duplicate, newlyRecorded, counted,
    transition, audit, reason}`. Gateway routes and AndroidOutbox both consume it;
no ACK semantics live in either.

### D3 — Durable ACK replay (R7–R10)
`gatewayRoutes` order: outbox memory → outbox tombstone → `sendStore.byGatewayRequest()`.
The durable row plus the revocation stamp decides the canonical reply.

### D4 — Expression index (R12)
`CREATE INDEX idx_sends_terminal_window ON sends (status, COALESCE(finished_at, sent_at, updated_at))`
with the query expression copied verbatim. Additive; no destructive migration.

### D5 — Idle semantics (R11)
`idle = waiting+active+delayed+prioritized+paused === 0`, `executing = active > 0`.
Frontend renders `queue.idle` from the backend.

## Risks

- Building in a staging directory doubles disk usage transiently (~200 MB of
  node_modules per front-end). Mitigated by the disk policy already in place.
- The staging build needs the npm registry; a registry outage now blocks an
  update instead of silently promoting unvalidated artifacts (intended).
