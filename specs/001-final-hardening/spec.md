# Feature: Android ACK truth + atomic release promotion (final hardening)

Feature ID: `final-hardening-v1`
Branch: `fix/final-hardening-ack-update`
Baseline: main `7f0c405`, version `0.19.2`

## Why

Two classes of defect remain after 0.19.2:

1. **Release integrity.** `gmweb update` (the production path) moves the LIVE
   checkout to the new revision and only then builds/validates it. A failed
   front-end build leaves a live checkout that no build ever validated and that
   the next restart will boot.
2. **ACK truth.** The AndroidOutbox replay path labels *any* late/repeated
   successful ACK `sent_after_revocation`, even for a send that was never
   revoked; ACK replay is memory-only, so a process restart makes GMweb answer
   `ok:false, outcome:null` for a task it durably knows about; and the gateway
   response reports `terminal=false` for a successful `sent`.

## Requirements

- **R1 Atomic update.** The live checkout is never mutated until a pinned
  candidate has been staged, built, tested and verified outside it. Order:
  pin SHA → stage → npm ci → check → test → build:frontends → verify:artifacts
  → pause/drain → promote exact SHA + exact artifacts → prod deps → restart →
  post-deploy verify → restore prior queue-pause state.
- **R2 Adoption parity.** `adopt_git_checkout()` runs the same gates before
  replacing an archive install.
- **R3 Operator lock.** Concurrent updates are prevented with an OS lock;
  the second exits with `update_already_running` and does not wait forever.
- **R4 Rollback.** `OLD_SHA`/`CANDIDATE_SHA` recorded; failure after
  promotion restores the previous source AND artifacts and restarts it, keeping
  the database. Never leave new source with old artifacts or vice versa.
- **R5 Short downtime.** No queue pause during minutes-long builds; never
  auto-resume a queue that was manually paused before the update.
- **R6 ACK matrix.** One pure state machine decides canonical outcome,
  successful, terminal, retryable, duplicate, newlyRecorded, counted, and
  whether a ledger transition / audit / counter is required.
- **R7 Durable ACK replay.** A known `gatewayRequestId` is answered from
  `SendStore` even when the outbox memory and tombstones are gone.
- **R8 Exactly-once side effects.** One physical SMS = one durable fact. Replays
  may repeat responses, never counters/audits/sentAt overwrites.
- **R9 Late ACK reconciliation.** `unverified/android_ack_missing` + an
  authenticated `sent` ACK for the same id → `sent`, once, audited as
  `late_ack_confirmed_unverified`.
- **R10 Contradictions.** `sent` then `failed` stays `sent`; revoked then
  `sent` is `sent_after_revocation` exactly once; `failed` then `sent`
  follows a documented deterministic policy.
- **R11 Queue idle.** `idle` means no outstanding live work
  (waiting+active+delayed+prioritized+paused == 0); `executing = active > 0`.
  Frontend consumes the backend field and never recomputes it.
- **R12 Indexable telemetry.** The last-24h aggregation is served by an
  expression index matching the query exactly, proven with `EXPLAIN QUERY PLAN`.
- **R13 Scope diagnostics.** A missing `sms.invalidate` scope returns 403 with
  an observable `requiredScope`, and an operator diagnostic lists SMS consumer
  keys that cannot invalidate. No automatic privilege broadening.
- **R14 Readiness audit.** `/ready` and `/send/capacity` consume the single
  transport-health model; a stale pull phone is never reported ready, and the
  direct-push client never makes pull mode ready.
- **R15 Honest stale.** A silent phone stays `stale/no_recent_device_pull`;
  transitions are logged with rate limiting, never masked.

## Acceptance invariants

- **A** An unvalidated candidate can never become the live checkout.
- **B** One physical SMS is never recorded twice because its ACK was retried.
- **C** A normal duplicate ACK is never mislabeled `sent_after_revocation`.
- **D** A restarted GMweb replays ACK truth from durable state.
- **E** `sent_after_revocation` exists only when durable evidence says the task
  was actually revoked before physical submission.
- **F** Queue `idle` means no outstanding queue work, not merely `active=0`.
- **G** last-24h telemetry is index-supported.
- **H** All readiness endpoints agree on one Android pull liveness truth.

## Non-goals

Rewriting the 0.19.2 features (version integrity, transport snapshot, cache
policy, stable gateway ids, revocation/generation, sms.invalidate scope).
Touching the `Messages` (Android) or `EVE` repositories.
