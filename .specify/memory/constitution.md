<!--
Sync Impact Report
==================
Version change: 1.0.0 (drafted against 7f0c405 / v0.19.2, never committed) -> 1.1.0
Modified principles:
  - I-XVI   re-anchored to 932f772 / v0.19.3; no invariant weakened or removed.
  - III     points at the new ACK-idempotency principle.
  - VIII    adds honest uncertainty and points at the new physical-truth principle.
  - XIII    records that promotion now builds and verifies artifacts before restart.
  - XIV     states the readiness SSOT rule explicitly, with route evidence.
  - XVI     records 63 test files / 360 assertions, the new guards, and the
            matrix / restart / ordering / query-plan evidence requirements.
Added principles:
  - XVII   Physical Truth Wins
  - XVIII  ACK Idempotency
  - XIX    Atomic Release Promotion
  - XX     Rollback Consistency
  - XXI    Update Concurrency
  - XXII   Database Performance
  - XXIII  Production Evidence
Added sections: none
Removed sections: none
Follow-up TODOs: none. No placeholder token remains.
Rationale: 0.19.3 made the release path and the ACK path first-class correctness
surfaces. The 1.0.0 draft governed the send lifecycle but said nothing about
promotion atomicity, rollback consistency, updater concurrency, readiness SSOT,
query-plan evidence or production evidence - the very guarantees 0.19.3 added
were therefore unenforceable by review.
-->

# GMweb Constitution

**Symbols are the durable anchor, not line numbers.** Citations are written as
`path:line` at the revision that recorded them, together with a symbol name.
When a line number and a symbol disagree, the symbol wins. Principles I-XVI were
anchored at **`7f0c405` (v0.19.2)** and their line numbers are a historical
navigation hint; principles **XVII-XXIII were added at `932f772` (v0.19.3)** and
are deliberately symbol-anchored, because 0.19.3 moved essentially every line in
`src/server.js`.

Canonical references (inputs to the specification process, never disposable):

- `docs/INTEGRATION.md` §2c — the normative revocation contract for consumers.
- `docs/API.md` — endpoint reference, `/send/invalidate` semantics and counters.
- `docs/DEPLOYMENT.md` — release integrity, deploy order, static cache table, transport health, queue-now vs delivery-outcomes.
- `docs/OPERATIONS.md` — the runbook.
- `docs/adr/ADR-004-repository-and-product-boundaries.md` — the three planes.
- `docs/EVE_SEND_PRIORITY.md` — the EVE <-> GMweb contract (priority lanes, idempotency key, announcement cap).
- `docs/REMEDIATION-RFP-MATRIX.md` — clause-by-clause DONE / PARTIAL / **NOT RUN**.
- `docs/MESSAGES-WEB-PHYSICAL-GATE.md`, `docs/PAIRING-E2E.md` — physical gates, currently **NOT RUN**.
- `docs/openapi.json` — the generated contract, CI-enforced against `src/server.js`.

## Core Principles

### I. Durable Ledger Is Truth

BullMQ is execution infrastructure, not authoritative business truth. A message
state that must survive restart, retry or device redelivery MUST be represented
durably.

- The ledger is SQLite (`better-sqlite3`) at `data/sends.db`, opened in WAL with
  `synchronous=NORMAL` (`src/sendStore.js:40-41`), wired at `src/server.js:351`.
- Tables (`src/sendStore.js:42-96`): `sends` (43-64), `service_generations`
  (68-74), `invalidation_events` (75-81), `send_counters` (85-89),
  `send_job_refs` (90-95).
- `sends.status` vocabulary:
  `queued | active | sent | unverified | failed | suppressed | cancelled | superseded`.
  The terminal set is `sent | unverified | failed | suppressed | cancelled |
  superseded` (`src/notificationMeta.js:216-218`). **`superseded` is terminal,
  not successful, not billable and not retryable.**
- `send_job_refs(job_id PRIMARY KEY, send_id)` exists so the ledger identity
  survives a BullMQ job being replaced on defer or promote
  (`src/queue.js:362-381`, `src/sendStore.js:311-316, 612-615`).
- **Known gap to close**: `sends` has **no UNIQUE constraint** on `dedupe_key`
  or `idempotency_key` (`src/sendStore.js:43-64`; every index at `:65-67` and
  `:140-146` is non-unique). Duplicate suppression relies on a SQLite
  transaction (`_claimTxn`, `:320-336`) plus a Redis `SET NX` reservation, and
  is safe today only because the API runs as a single process. The command engine
  already does this correctly with `UNIQUE (account_id, idempotency_key)`
  (`src/commandEngine.js:53`). New duplicate-suppression logic MUST use a
  database uniqueness constraint rather than check-then-act, and MUST NOT widen
  the reliance on single-process execution.

### II. Stable Send Identity

One logical send MUST retain a stable request identity across queue retries,
process restart and Android redelivery. **A retry MUST NOT become a new physical
SMS task.**

- Identity is `send_<ledgerId>`: `sendStore.requestId(id)`
  (`src/sendStore.js:679-681`); `byReference()` accepts `send_<n>` or a raw
  jobId (`:686-690`).
- The identity is resolved once per job (`requestIdForJob`,
  `src/server.js:1390-1393`) and passed into the transport exactly once
  (`src/server.js:1747`, call at `1749-1766`). The fallback mint at
  `src/androidOutbox.js:625` MUST NOT become the normal path.
- The wire task's `meta` is **always a present object** even when empty
  (`EMPTY_TASK_META`, `src/androidOutbox.js:26-33`, used at `:322-330`).
- Retry/redelivery idempotency is `AndroidOutbox.offer()`
  (`src/androidOutbox.js:126-226`): pending attaches a waiter; inflight returns
  to pending **with the same id**; settled replays the tombstone.
- Regression guard: `test/duplicateSms.test.js`.

**Rationale (recorded production incident)**: one renewal reminder was physically
delivered **three times**, once per BullMQ attempt. Two defects in series —
`/gateway/pull` returned `meta: null` for every send without consumer
notification identity, and `startSendWorker()` never passed a `requestId`, so
AndroidOutbox minted a fresh `pull_<random>` per attempt while Android deduped
on that id. Three minted ids produced three SMS.

### III. Idempotency

Client and API retries MUST converge on one logical operation where the contract
declares idempotency. Duplicate ACK, pull or retry behaviour MUST NOT cause
duplicate modem submissions.

- Explicit `Idempotency-Key`: Redis `SET NX` on `idem:<key>` with TTL 86400 and
  value `<jobId>:<bodyHash>` (`src/queue.js:145-148`). Reuse with different
  content MUST fail with `409 idempotency_key_reused`
  (`src/server.js:3841-3843`, wiring `3827-3870`).
- Content dedupe without a key: Redis `dd:<hash>` `SET NX`
  (`src/queue.js:175-178`) over the `SEND_DEDUPE_MS` window
  (`src/server.js:1104`), with the ledger claim at `src/server.js:3899-3918`.
- The command engine's `UNIQUE (account_id, idempotency_key)`
  (`src/commandEngine.js:53`) is the reference implementation of this principle.
- `MAX_GENERATION = 2147483647` (`src/notificationMeta.js:53`, bounds `:64-70`).
- The **ACK path** is a separate, non-negotiable idempotency surface: see
  Principle XVIII. A duplicate ACK is a response replay
  (`src/ackStateMachine.js`), never a repeated mutation.

### IV. Consumer Notification Metadata

Lifecycle-sensitive notifications MUST carry validated canonical metadata:
`source`, `serviceKey`, `notificationKind`, `generation`, correlation identity
as applicable, and `requiresValidation` semantics. Partial metadata that would
create an unrevocable lifecycle-sensitive message MUST fail closed.

- `src/notificationMeta.js` is the single, dependency-free source of truth.
  Kinds: `near_expiry | low_volume | expired | volume_ended | created | renew`
  (`:23-30`); depletion kinds `:34-36`; transactional kinds `created | renew`
  (`:40`).
- `validateNotificationMeta()` (`:108-127`) MUST fail closed with
  `400 invalid_meta` on a non-object, or a missing `source` / `serviceKey`
  (minimum 3 characters) / `notificationKind`, an unknown kind, or a missing
  `generation`. An omitted `meta` keeps legacy behaviour unchanged; a
  **partial** `meta` MUST NOT.
- `requiresValidation` is derived **server-side and never trusted from the
  client**: `requiresValidationForKind()` (`:77-80`) is true for every
  non-transactional kind, and an **unknown kind fails closed as validated**.
  It is persisted to `sends.requires_validation` (`src/sendStore.js:115`,
  written `:212-219` and `:348-360`) and surfaced by
  `sendStore.hasValidationRequired` (`:556-558`).
- The metadata tag MUST be written in the **same transaction as the ledger
  claim**, so there is no untagged window (`src/sendStore.js:320-336`).
- Text limits MUST hold (`:42-49`): source 32, serviceKey 200, kind 48,
  correlationId 64, reason 64, eventId 200; control characters are stripped
  (`:55-62`).

### V. Semantic Revocation

Renewal invalidation is **not merely queue removal**.
`POST /send/invalidate` MUST persist a lifecycle/generation barrier before
relying on any best-effort queue cleanup. Pending, active and device-inflight
work MUST all respect the semantic revocation state.

- Route: `src/server.js:4362-4464`; shared state machine
  `createSendRevocation` (`src/sendRevocation.js:50-443`), wired
  `src/server.js:1147-1168`; `/send/cancel` reuses the same machine
  (`src/server.js:4271-4273`).
- **Persisted barrier**: `service_generations(source, service_key, generation,
  kinds)`. `sendStore.advanceGeneration` (`src/sendStore.js:409-430`) applies
  `ON CONFLICT ... SET generation = MAX(generation, excluded.generation)`
  (`:226-231`) so the watermark is **monotonic**, and `kinds` is a **UNION**,
  never a replacement (`:417-428`). Read back through `revocationBarrier()`
  (`:385-391`).
- **Ordering contract** (`src/sendRevocation.js:293-302`):
  **replay -> watermark -> ADVANCE -> revoke -> count** (replay `:325-331`,
  staleness `:335-347`, advance `:350-352`, selection `:354`, loop
  `:357-370`, counters `:390-392`). A crash mid-loop MUST still leave the
  barrier in place.
- How each state honours it:
  - **pending** — the outbox settles it `superseded`; the phone never sees it
    (`src/sendRevocation.js:158-169`, `src/androidOutbox.js:373-392`).
  - **active** — cooperative: a tombstone is written, the status stays active,
    and the worker guard re-reads the ledger before touching a transport
    (`guardForJob` `src/sendRevocation.js:72-81`; `src/server.js:1703-1714`,
    `1756-1760`).
  - **inflight** — flagged with a bounded lease
    (`src/sendRevocation.js:136-156`, `src/androidOutbox.js:395-405`, lease
    120 s at `:56`).
- **Queue removal is an optimisation, never the guarantee.** `cancelPendingJob`
  (`src/queue.js:457-467`) can only remove `waiting | paused | delayed |
  prioritized` jobs; an **active BullMQ job is unrecoverable by design** and
  returns `{cancelled:false, reason:"active"}`. Removal failure MUST be reported
  honestly as `queueRemovalFailed:true` with the
  `sms_queue_removal_failures_total` counter
  (`src/sendRevocation.js:234-248`) — never silently swallowed.
- Durable counters (`src/sendRevocation.js:37-46`): `sms_invalidations_total`,
  `sms_jobs_superseded_total`, `sms_inflight_revoked_total`,
  `sms_sent_after_revocation_total`, `sms_validation_requests_total`,
  `sms_validation_invalid_total`, `sms_stale_generation_rejections_total`,
  `sms_queue_removal_failures_total`.
- `invalidation_events(event_id PRIMARY KEY)` makes an invalidation replay
  idempotent and an older request refusable with
  `409 stale_generation` (`src/sendRevocation.js:333-347`).

### VI. Generation Watermark

A newer generation **permanently invalidates** depletion notifications from older
generations. Delayed or retried queue work MUST NOT resurrect a stale generation.

- The comparison is **strictly less-than** (`src/notificationMeta.js:205`):
  `if (!(Number(generation) < Number(watermark))) return false;`
  → `generation < watermark` is stale; `generation >= watermark` stays
  deliverable. An **equal** generation is valid — a message at the current
  generation MUST NOT be treated as stale.
- Kind scoping follows immediately (`:206-210`): a renewal that revoked only
  `volume_ended` MUST NOT block `expired`.
- Row-level rule `isSupersededNotification()` (`:191-212`): superseded if
  `status == superseded`, OR `revoked_at` is set, OR the row has a
  `service_key` and `generation < watermark` **and** the kind is in the barrier
  kinds.
- Request-side staleness runs the other way: `requestedGeneration < recorded`
  is refused with `409 stale_generation`; equal is accepted
  (`src/sendRevocation.js:335-347`).
- Migration of this state MUST be additive only (`src/sendStore.js:97-138`).

### VII. Final Device Gate

Lifecycle-sensitive Android gateway tasks MUST support a final durable validation
immediately before modem submission. Revoked work MUST resolve as **superseded**,
not as a retryable failure.

- Route `POST /gateway/validate`: `src/gatewayRoutes.js:110-165`; verdict
  `validateTask()` (`:174-198`); device-key auth `:139`; rate limit 600/60 s
  `:140-147`; `Cache-Control: no-store` `:163`.
- Verdict order (`:174-198`): in-memory outbox overlay `outbox.revocationFor`
  (`:175-178`) → durable ledger `sendStore.byGatewayRequest` (`:179`) →
  unknown id returns `{valid:true, status:"valid", known:false}` (`:181-185`)
  → `isSuperseded` returns `{valid:false, status:"superseded"}` (`:186-188`)
  → cancelled → superseded (`:189-192`) → `sent|unverified|failed|suppressed`
  returns `{valid:false, status:"terminal", reason:status}` (`:193-196`) →
  valid.
- **Deliberate scope limit**: an unknown id is answered `valid:true` so
  pre-upgrade devices are not stranded (`:181-185`). This MUST remain a
  documented, intentional decision and MUST NOT be widened without a
  device-compatibility analysis.
- `superseded` is `valid:false, status:"superseded", terminal`: do not send, and
  it is `counted:false` and never consumes the announcement or success budget
  (`src/gatewayRoutes.js:301-302`). Validate has **no retryable-failure verdict
  at all**; retryability is expressed on the ACK path, where
  `ok:false` / `outcome:"failed"` rejects the worker promise
  (`src/androidOutbox.js:549-555`) and BullMQ retries.
- Validate MUST leak nothing: it "deliberately returns no task, phone number,
  service key or message data" (`src/gatewayRoutes.js:172`).

### VIII. Honest Outcomes

Never report a message as cancelled if the physical SMS was actually submitted.
If submission wins a race against revocation, record the truthful
sent-after-revocation outcome and metric.

- The **durable row decides the anomaly, never the phone's claim alone**:
  `revoked_at`, `status == cancelled` or `isSuperseded`
  (`src/gatewayRoutes.js:275-283`).
- First-write-wins through the nullable `sent_after_revocation_at` column, so a
  retried ACK is a no-op rather than a second anomaly
  (`src/sendStore.js:273-282, 520-529`).
- The audit is suppressed when a live worker settlement owns the outcome
  (`liveSettlement`, `src/gatewayRoutes.js:256`).
- The counter is bumped only when the durable write actually changed a row
  (`src/sendRevocation.js:407-433`, bump at `:409-410`).
- The response is explicit:
  `{ok:true, outcome:"sent_after_revocation", terminal:true, successful:true,
  counted:true}` (`src/gatewayRoutes.js:288-290`).
- A late **real** send is reported `sent` / `sent_after_revocation` and MUST NOT
  be downgraded to a cancellation (`src/androidOutbox.js:486-547`,
  `src/sendRevocation.js:398-433`).
- There is **no carrier DLR**: terminal success is `sent`, never "delivered"
  (`docs/EVE_DELIVERY_ANSWERS.md`). That document is otherwise **stale** — it
  predates `Idempotency-Key` support and MUST be cited for the honesty rule only,
  not for current capability.
- **Honest uncertainty.** `unverified` is a first-class terminal state meaning
  "the server does not know whether the modem took it". It MUST be represented
  explicitly and MUST NOT be collapsed into `failed` (which invites a resend) or
  into `sent` (which fabricates a delivery fact). A message that may already have
  been physically submitted MUST NOT be retried automatically
  (`android_ack_missing`, Principle XII).
- When later evidence *does* prove submission, the false state MUST be corrected
  rather than preserved: Principle XVII.

### IX. Consumer Isolation

Service revocation MUST use canonical service identity, **not the phone number**.
Two services sharing one recipient MUST remain independent.

- Revocation selects rows by `service_key` and generation
  (`selectInvalidatableSends`, `src/notificationMeta.js:137-148`;
  `src/sendRevocation.js:317-318`).
- Untagged rows MUST never be matched by a revocation.
- Transactional kinds are filtered out even when explicitly listed — a renewal
  MUST NOT invalidate its own confirmation
  (`src/notificationMeta.js:137-148`, `src/sendRevocation.js:317-318`).

### X. API Authorization

Project scopes are explicit security boundaries. Missing scopes MUST NOT be
silently bypassed, and a missing required scope MUST be observable and testable.

- `src/projectKeyScopes.js`: `PROJECT_KEY_SCOPES` `:3-13` (9 scopes including
  `sms.invalidate`); `DEFAULT_PROJECT_KEY_SCOPES` `:17-28`;
  `requiredProjectKeyScope(method, url)` `:35-52` maps `/send/invalidate` to
  `sms.invalidate` (`:41`) and an unmapped path to `null` (`:51`).
- Enforcement is a single global preHandler (`src/server.js:932-936`) and is
  **fail-closed**: `if (!requiredScope || !apiKeyStore.hasScope(key,
  requiredScope))` replies `403 {error:"project_scope_denied", requiredScope}`
  (a `null` required scope denies rather than allows). Admin paths are gated
  earlier by `isAdminOnlyPath` (`:924`, defined `:676`).
- Observable and testable: `test/eveContract.test.js:104-118` asserts the 403
  through a real Fastify app; `test/sendInvalidate.test.js:32-39` pins the
  contract mapping.
- **Known gaps to close**:
  1. On denial, `request._projectKey` is never set (it is assigned at
     `src/server.js:937`, *after* the check), so `activityActor()`
     (`:958-966`) falls through to `bearerToken(request)` and records the
     denial as `{type:"master", name:"Master API token"}`. Scope denials are
     misattributed and nothing asserts the actor.
  2. `normalizeProjectKeyScopes` falls back to the legacy default scope set for
     a key whose `scopes` array is absent or mangled
     (`src/projectKeyScopes.js:30-33`, used by `apiKeyStore.hasScope`
     `src/apiKeys.js:147-149`) — a fail-OPEN path sitting next to the fail-closed
     check. It MUST NOT be extended.

### XI. Backward Compatibility

Protocol changes MUST define behaviour for older consumers. Additive API and
schema changes MUST be preferred. Staggered EVE / GMweb / Android deployments
MUST have a tested compatibility plan.

- Ledger migrations are additive-only `ALTER TABLE` in `try/catch`
  (`src/sendStore.js:98-138`: `revoked_at` `:120`, `revocation_reason` /
  `revocation_json` `:121-122`, `sent_after_revocation_at` `:127`,
  `gateway_request_id` `:131`, `service_generations.kinds` `:135`).
- The unknown-task `valid:true` verdict exists specifically so a pre-upgrade
  device is not stranded (Principle VII).
- Two cross-repository fixtures are byte-compared in CI and MUST NOT drift
  independently:
  - `shared/pairing-protocol-v1.json` ↔ `Messages/protocol/pairing-protocol-v1.json`
    (the `pairing-contract-drift` job in `.github/workflows/ci.yml`).
  - The EVE send contract, verified by `node scripts/check-eve-contract.js`
    (the `eve-contract-drift` job).
- A breaking change to a shipped contract requires a documented compatibility
  adapter or version, not an implicit assumption.

### XII. Queue Failure Semantics

Retries MUST be bounded and classified. Terminal semantic states MUST NOT
re-enter retry loops.

- Queue `gmweb-send` (`src/queue.js:4`); job options (`:24-33`):
  `attempts: 3`, exponential backoff `delay: 5000`,
  `removeOnComplete {age:86400, count:1000}`,
  `removeOnFail {age:604800, count:1000}`. The worker is in-process with
  concurrency 1 (`:483-494`).
- Terminal states avoid retry by **resolving, not throwing**:
  - the processor's first act is `sendRevocation.guardForJob(job.id)`
    (`src/server.js:1703-1714`); superseded returns `{superseded:true}`,
    cancelled returns `{cancelled:true}` — both complete the job;
  - `#settleSuperseded` resolves waiters for superseded and rejects only for a
    consumer cancel (`src/androidOutbox.js:407-439`);
    `src/server.js:1773-1781` converts `SEND_CANCELLED` to
    `{cancelled:true}`;
  - the last attempt on Android without an ACK becomes
    `unverified / android_ack_missing`, **never** `failed`, because `failed`
    would invite a resend (`src/server.js:1848-1861`).
- **Known structural risk to guard**: there is **no `UnrecoverableError`
  anywhere in `src/`**. The guarantee depends on the processor returning rather
  than throwing. A future change that throws for a superseded task would hand the
  job back to BullMQ for three attempts. Any such change MUST add an explicit
  unrecoverable classification instead of relying on the current convention.
- An Android `send_timeout` is **not** a browser wedge; restarting Chrome and the
  API wipes the in-memory outbox and causes a redelivery storm
  (`src/server.js:1790-1797`).

### XIII. Frontend / Artifact Release Integrity

Generated frontend artifacts MUST correspond to the release source and version.
A backend deployment MUST NOT silently serve stale PWA or dashboard artifacts.

- Build: `npm run build:frontends` → `scripts/build-frontends.mjs`
  (`APPS` `:22-25`: `dashboard-next` → `public/dashboard-next` served at `/app`;
  `web` → `public/web-app` served at `/web`).
- Verify: `scripts/verify-frontend-artifacts.mjs` (`APP_TARGETS` `:25-28`:
  **PWA `requiresVersion:true`, Dashboard `requiresVersion:false`**): the entry
  point exists and every same-origin asset is present (`:60-65`);
  `version.json.version === package.json.version` (`:79-84`); optional
  `build-info.json` provenance (`:89-101`). CLI: `npm run verify:artifacts`.
- Served through `src/staticCachePolicy.js`: content-hashed assets immutable for
  one year (`:13, 17, 64-67`); shell, `version.json`, `build-info.json`,
  `sw.js`, `manifest.webmanifest` and extension-less SPA routes revalidate
  (`:20-26, 34-39, 68-72`); everything else one hour (`:73`).
- CI rebuilds both SPAs and **fails if `public/{dashboard-next,web-app}` is
  dirty** (`.github/workflows/ci.yml`).
- **Known gaps to close**:
  1. `webAppDeploymentInfo()` (states `current | version_mismatch |
     pwa_assets_missing | pwa_not_built | pwa_manifest_invalid`; returns
     `state | reason | version | revision | matchesApi | missingAssets`)
     **reports but does not enforce** — the server still serves a mismatched
     build. 0.19.3 closed the *causal* half of this gap: promotion now builds and
     verifies the artifacts before restart (Principle XIX), so a mismatch can no
     longer be deployed silently. The server remains a reporter, not a gate.
  2. It inspects only `public/web-app`. There is **no version check at all** for
     `public/dashboard-next` (`requiresVersion:false` above; the directory has
     no `version.json` and its `package.json` pins `"version":"0.0.0"`).
- **Rationale (recorded production incident)**: production served API
  **0.19.1** with a PWA built at **0.18.0**. The version source logic was already
  correct; nothing ever rebuilt the artifact and nothing ever compared the two,
  because neither `deploy-gmweb.sh` nor the manager update path built `web/` or
  `dashboard-next/`. Verify **before** restart, always.

### XIV. Observability

Live queue health MUST be separated from historical delivery outcomes.
Historical failures MUST NOT be displayed as a current queue failure. Transport
and device health MUST have **one** authoritative server-side interpretation.

- `GET /health` (`src/server.js:2493-2514`) is process liveness only;
  `GET /ready` (`:3337-3362`) returns 200/503 from transport-specific readiness.
- `GET /admin/overview` (`src/server.js:2622-2776`) is ONE snapshot: transport
  from `transportHealth.snapshot()` (`:2696`), queue/idle/ledger from
  `buildQueueReport` (`:2719-2723`), web app (`:2711`), counters (`:2767`),
  revocation `{superseded, revokedInflight, tombstones}` (`:2768-2772`).
  Master token only.
- `src/transportHealth.js` is the single model: states
  `connected | stale | unconfigured | push_unreachable | not_paired | unknown`
  (`:17-24`), reasons (`:28-36`), pull liveness 90 s (`:38-43`). **A configured
  device that went quiet is STALE, never UNCONFIGURED** (`:1-15`).
- **Readiness SSOT.** `GET /ready` (`app.get("/ready")` in `src/server.js`),
  `GET /send/capacity`, `GET /admin/transport`, `GET /admin/queue` and
  `GET /admin/overview` MUST all consume `transportHealth.snapshot()` /
  `transportHealth.android()` and MUST NOT re-derive transport health.
  `/ready` returns 200/503 from that single verdict and reports transitions
  through `transportHealth.reportTransition()` (one report per 60 s).
  **No alternate transport may make the configured active transport appear
  healthy**: a paired Chrome session MUST NOT mask a stale Android bridge, and a
  configured-but-quiet device MUST NOT be reported as `unconfigured`. If
  `/ready`, `/admin/transport` and `/admin/overview` disagree, that is a defect
  in the disagreeing route, not a difference of opinion.
- **Queue semantics SSOT.** `idle` is **defined by the backend**, and is true
  only when there is no outstanding live work:
  `waiting + active + delayed + prioritized + paused === 0`
  (`buildQueueReport`, `src/queueSnapshot.js`). UI clients MUST consume the
  server's `idle` / `outstanding` / `executing` fields and MUST NOT recompute
  queue state from a subset of counters — the narrower `waiting + active === 0`
  rule let a queue holding 40 delayed retries and 3 prioritized jobs render as
  idle.
- `src/queueSnapshot.js`: `queue` is live BullMQ (`:43-51`);
  `ledger.{allTime,last24h}` is the durable outcome history (`:53`); `idle` is
  derived **only** from live state, `waiting + active === 0` (`:78-80`). Legacy
  counts are kept as a documented deprecated shape (`:55-72`).
- **Rationale (recorded production incidents)**: `/admin/overview` showed
  "Delivery: Phone ready" beside "Device bridge: No device" at the same instant,
  because two different clients and a third copy of the rules in
  `/admin/transport` each answered the same question. And "Send queue: Failed
  683" was the **all-time ledger total** shown beside live waiting/active counts,
  so an idle queue looked currently broken.
- **Privacy**: `/admin/overview` exposes counters only
  (`src/server.js:2764-2766`) and `/gateway/validate` returns a verdict only.
  Recipient numbers and message text MUST NOT be added to metrics, health
  endpoints or logs. Note the existing master-token-only surfaces
  `/admin/sends` (`:4730-4821`, full `to` and text at `:4796, 4805`) and
  `/admin/queue/jobs` (`src/queue.js:273-274`, `to` plus an 80-character
  preview) — these MUST NOT be widened, and SSE is per-project-key scoped by
  `emitSse` (`src/server.js:1036-1049`) with redaction via
  `safeActivityFields` (`:976-984`).
- A window metric MUST be an index range scan in SQLite, not a full-table read
  into JS (`idx_sends_terminal_time`, `src/sendStore.js:143-146`;
  `statsSince` `:717-726`).

### XV. Privacy

Recipient and message content MUST NOT be exposed unnecessarily in metrics,
health endpoints or logs.

- Operational counters MUST be content-free (Principle XIV).
- Activity-log records MUST pass through `safeActivityFields`
  (`src/server.js:976-984`).
- GMweb MUST NOT persist plaintext message data for the encrypted replication
  plane (`docs/adr/ADR-005-single-e2ee-inbox.md`,
  `docs/SECURITY-REMEDIATION-REPORT.md`).
- `docs/HISTORY_KEY_V3_MIGRATION.md` governs the Full-History v3 key rollout and
  rollback; sensitive domains MUST stay separate.

### XVI. Testing

Protocol and state-machine changes require contract tests. Retry changes require
duplicate-delivery tests. Revocation requires pending / active / inflight /
restart / race tests. API changes require OpenAPI contract verification where
applicable.

- Framework: the Node built-in test runner — `npm test` =
  `node --test test/*.test.js` (`package.json:23`); **63 test files / 360
  assertions** at 0.19.3, with shared harnesses `test/pairingFixture.js` and
  `test/revocationHarness.js`.
- Named guards that MUST keep passing for the invariants above:
  `test/duplicateSms.test.js`, `test/staleSmsRace.test.js`,
  `test/sendInvalidate.test.js`, `test/gatewayContract.test.js`,
  `test/transportHealth.test.js`, `test/overviewSemantics.test.js`,
  `test/frontendArtifacts.test.js`, `test/eveContract.test.js`,
  `test/packageManifest.test.js`, `test/staticCachePolicy.test.js`,
  `test/ackStateMachine.test.js` (ACK decision matrix),
  `test/queueIdle.test.js` (queue semantics),
  `test/adminSchema.test.js` (Fastify strips undeclared response fields),
  `test/scopeReadiness.test.js` (scope diagnostics),
  `test/updateAtomicity.test.js` (release ordering).
- **Change-shaped evidence.** Required evidence follows the kind of change, not
  the size of the diff:
  - state-machine changes (ACK, revocation, supersession) → **matrix tests**
    covering every reachable combination of durable status × outbox memory ×
    reported outcome, not only the happy path;
  - retry logic → **duplicate and replay** tests proving a repeated input mutates
    nothing;
  - restart-sensitive logic → **cold-restart** tests that rebuild process state
    from durable state alone;
  - release updater changes → **ordering and failure-atomicity** tests asserting
    the gate order and that a failed gate cannot leave the live checkout moved;
  - an index that backs a performance guarantee → **query-plan evidence**
    (Principle XXII).
- A green suite is evidence about the code, not about the running system.
  Principle XXIII governs what may be called proven.
- `npm run check` (`package.json:22`) is a chain of 30 `node --check` syntax
  checks. It is **syntax only** — no lint, no types, and it never reads docs. It
  MUST NOT be presented as behavioural evidence.
- `npm run generate:openapi` (`package.json:16` →
  `scripts/generate-openapi.js`) regenerates `docs/openapi.json` offline; CI
  fails when the regenerated file differs from the committed one
  (`.github/workflows/ci.yml:36-44`). Any route, schema or auth change MUST
  regenerate it in the same change.
- There is **no root `npm run lint`**; `oxlint` exists only under
  `dashboard-next/`.
- Claims that depend on a physical device, a deployed proxy/TLS/canary, or real
  360k-message performance are currently **NOT RUN** and MUST be reported as such
  (`docs/MESSAGES-WEB-PHYSICAL-GATE.md`, `docs/PAIRING-E2E.md`,
  `docs/REMEDIATION-RFP-MATRIX.md`, `docs/PERFORMANCE-REMEDIATION-REPORT.md`).
  "Synthetic results must not be presented as real-device performance."

### XVII. Physical Truth Wins

If durable evidence later proves that the modem submitted an SMS, the system MUST
record the truthful physical outcome. A false `cancelled`, `failed` or
`superseded` state MUST NOT be preserved when a valid, authenticated late ACK
proves physical submission.

- The submission is irreversible; the record is not. Reconciling the record to
  the physical fact is therefore always the correct direction of repair, and
  leaving a false negative in place is a correctness defect, not caution.
- Reconciliation is explicit and audited, never silent. `sendStore.reconcileLateSent(id,
  {reason, sentAt})` is a compare-and-set: it returns `{changed:false, row}`
  without writing when the row is already `sent` or `suppressed`, so the second
  and every later late ACK is `newlyRecorded:false` / `counted:false`.
- The device timestamp is trusted only when the device reported one; otherwise
  the server receipt time is recorded. `result_json.lateAck` preserves the
  `fromStatus` and both timestamps so an operator can reconstruct the sequence.
- `sent_after_revocation` means **exactly one thing**: the row was durably
  revoked (`revoked_at`) or consumer-cancelled *before* submission. It MUST NOT
  be used as a generic "late ACK" label. The reconciliation reasons exist so the
  two are distinguishable: `late_ack_confirmed_unverified`,
  `late_ack_confirmed_failed`, `late_ack_confirmed_cancelled`,
  `late_ack_confirmed_unsettled` (`AUDIT`, `src/ackStateMachine.js`).
- A proven submission MUST NOT be overwritten by a later `superseded` or
  `cancelled` report, and MUST NOT be downgraded to a cancellation.
- **Rationale (recorded production incident)**: the replay branch collapsed every
  late successful ACK into `sent_after_revocation`, manufacturing revocation
  races that never happened and inflating `sms_sent_after_revocation_total` —
  the one counter an operator uses to decide whether invalidation is working.

### XVIII. ACK Idempotency

A duplicate ACK MUST be a **response replay, not a repeated mutation**.
Exactly-once side effects apply to durable state, counters, audit events and sent
timestamps. A normal duplicate `sent` ACK MUST NEVER be labelled
`sent_after_revocation`.

- `decideAck()` (`src/ackStateMachine.js`) is the **one** decision point:
  durable row + outbox memory + reported outcome in, canonical decision out. Both
  `AndroidOutbox.acknowledge()` and the `/gateway/ack` route consume it, so a
  process restart cannot change ACK meaning. ACK semantics MUST NOT be re-derived
  at a call site.
- `replay()` returns the previously settled outcome with `duplicate:true`,
  `newlyRecorded:false`, `counted:false`, `transition:null`, `audit:null` and
  `retryable:false`. A settled task is never retried, whatever it settled as.
- An unknown `gatewayRequestId` MUST NOT fabricate a delivery fact: the answer is
  `{handled:false, reason:"unknown_gateway_request_id"}` and nothing is written.
- `terminal` describes **the task outcome**; `retryable` describes **whether
  another attempt may still happen**. They are independent and neither may be
  inferred from the other: a `failed` ACK on a retryable attempt is
  `terminal:false, retryable:true`, while a `failed` ACK with no attempts left
  is `terminal:true, retryable:false`.
- The response MUST be explicit and machine-checkable:
  `ok, outcome, terminal, successful, retryable, duplicate, newlyRecorded,
  counted, ackState`.
- Counters MUST bump only when the durable write actually changed a row.
- A revoked task MUST NOT be retried even when the device reports a failure
  (`revoked_task_failed` → `superseded`).
- Regression guards: `test/ackStateMachine.test.js` (the matrix),
  `test/duplicateSms.test.js`, `test/gatewayContract.test.js`.

### XIX. Atomic Release Promotion

The live checkout MUST NOT move to a candidate revision until **that exact
revision** has passed every gate. The candidate SHA MUST be pinned once and MUST
NOT be re-resolved later in the same update.

- Order (`update_app`, `scripts/gmweb-menu.sh`), asserted by
  `test/updateAtomicity.test.js`:
  acquire the update lock → fetch and **pin `git rev-parse FETCH_HEAD`** →
  `git archive` that pinned revision into a stage outside the live checkout →
  gates **in the stage** (`npm ci --include=dev`, `npm run check`,
  `npm test`, `npm run build:frontends`,
  `node scripts/verify-frontend-artifacts.mjs`, `bash -n`) →
  `pause_and_drain_queue` → backup → `git merge --ff-only <pinned>` →
  install built artifacts → `npm ci --omit=dev` → restart → version-drift check.
- The stage MUST be handed to the app user (`chmod 755` and
  `chown -R "$APP_USER:$APP_USER"`) **before** the gates run: a `mktemp -d` stage
  is 0700 and root-owned, so every gate would otherwise fail with a silent
  `Permission denied` and the candidate would be rejected for the wrong reason.
- The queue is paused only **after** the candidate is proven. A failing gate MUST
  leave the live checkout untouched, the service running and the queue serving.
- The manager MUST NOT `git pull` inside the promotion path. Fetching again can
  promote a different revision than the one that was validated; the validated SHA
  is the only revision that may be promoted.
- `adopt_git_checkout()` runs the same gate set before it swaps anything.

### XX. Rollback Consistency

A rollback MUST restore source **and** versioned frontend artifacts from the same
previous revision. "New source + old frontend" and "old source + new frontend"
are both release-integrity failures, not partial successes.

- `update_app` records `old_sha` before promotion and, on failure, restores it
  with `git reset --hard "$old_sha"`, reinstalls production dependencies and
  restarts — so the checkout and `public/{dashboard-next,web-app}` always come
  from one revision.
- Artifacts MUST be verified **before** restart, always. Restarting first and
  checking afterwards is not a verification, it is a rollback.
- Database rollback MUST NOT be implicitly destructive. The pre-promotion backup
  is a hot `better-sqlite3` snapshot (`.env`, `data/`, state dir) written by
  `scripts/gmweb-backup.sh`. A failed backup MUST log and continue rather than
  block, because an update never mutates the ledger destructively; restoring a
  backup is an explicit operator action and MUST NEVER be an automatic step of a
  failed update.
- Historical ledger rows MUST NOT be deleted or reset to make a failed release
  look clean (see Principle XXII).

### XXI. Update Concurrency

Production update operations MUST use cross-process / cross-operator locking. A
second updater MUST fail or coalesce **explicitly** and MUST NEVER race the first.

- `update_app` takes `flock -n 9 /run/lock/gmweb-update.lock` (falling back to a
  lock inside the data directory) as its first action, and reports
  `update_already_running` without touching the checkout when the lock is held.
- The lock MUST be **non-blocking** (`flock -n`). A blocking wait would silently
  queue unknown numbers of updaters behind an interactive session.
- A process-local mutex or a PID file is **not** sufficient: the manager is run
  from interactive operator shells and from automation, in the same repository,
  as different users.

### XXII. Database Performance

Hot periodic paths MUST be served by an appropriate index and MUST NOT degrade
into a full scan as history grows.

- The last-24h outcome query MUST use the covering expression index
  `idx_sends_terminal_window ON sends (status, COALESCE(finished_at, sent_at,
  updated_at))`. The expression matches `statsSince`'s ordering key exactly; the
  index DDL and the query MUST stay in lockstep, and changing one without the
  other is a defect.
- A window metric MUST be an index range scan inside SQLite, not a full-table
  read into JavaScript and reduction there.
- A new polled endpoint MUST carry **query-plan evidence**
  (`EXPLAIN QUERY PLAN` showing index usage rather than `SCAN sends`) before its
  performance may be called safe. A performance guarantee asserted without plan
  evidence is a hypothesis.
- Indexes are added additively. Historical rows MUST NOT be rewritten, reset or
  deleted to make a plan or a dashboard look better — the 683 historical
  `failed` rows are the audit trail of a real incident.
- **Rationale (recorded production incident)**: an idle queue was rendered as
  "Send queue: Failed 683" because an all-time ledger total was computed beside
  live waiting/active counts (Principle XIV). The same class of mistake at the
  SQL layer turns frequent health polling into a full-table scan.

### XXIII. Production Evidence

A safety guarantee MUST NOT be reported as proven by unit tests alone when it
depends on systemd or process behaviour, live Redis/BullMQ, SQLite durability,
Android device behaviour, or the deployment scripts.

- Claims such as "exactly once", "never duplicated", "cannot happen", "atomic",
  "durable", "race safe", "secure", "zero downtime" or "backward compatible" each
  require an explicit mechanism **and** an explicit test/evidence mapping. A
  mechanism without evidence, or evidence without a mechanism, is incomplete.
- Production-like acceptance for a release means at minimum: the pinned revision
  is live; `GET /health` matches `package.json` and
  `public/web-app/version.json`; the checkout is clean; every asset referenced by
  the built shell returns 200 with the intended cache policy; `/ready`,
  `/admin/transport` and `/admin/overview` agree; and the queue/ledger snapshot
  is reproduced rather than assumed.
- Anything that was **not** verified MUST be reported as NOT VERIFIED, or
  **NOT RUN**. Claims that depend on a physical device, a deployed proxy/TLS/
  canary, or real 360k-message performance are currently NOT RUN and MUST be
  reported as such.
- A controlled, non-routable test message is acceptable evidence for a send-path
  claim. A real customer SMS is NEVER test material.
- "Synthetic results must not be presented as real-device performance."

## Cross-Repository Contract: EVE -> GMweb -> Messages

GMweb decides whether a logical notification is currently deliverable and owns
the durable delivery/revocation state plus the gateway contract. EVE owns *why*
a notification should exist (service identity, lifecycle generation, business
state). Messages Android performs the irreversible physical SMS submission and
owns final local dedupe, final validation and the modem boundary.

The system invariant for SMS lifecycle work is:

A notification from lifecycle generation N MUST NOT be physically submitted
after the service has durably advanced to generation N+1, unless physical
submission irreversibly completed before the invalidation barrier won the race.

GMweb's implementation of that invariant is `service_generations` + the
strictly-less-than watermark (Principle VI) + the `/gateway/validate` gate
(Principle VII) + the honest-outcome record (Principle VIII). Any change to one of
those MUST re-verify the whole chain, not just its own step.

For a change touching more than one repository:

1. assign one shared feature ID (for example `stale-sms-revocation-v4`);
2. use the same identifier in specs, plans, ADR references and acceptance reports;
3. define the system invariant before modifying any participant;
4. define or update the provider contract first;
5. define the compatibility matrix;
6. implement the provider, then the consumers;
7. converge each repository individually;
8. run cross-repository contract tests; and
9. run system-level acceptance before declaring the work complete.

EVE MUST NOT call a field or state that GMweb does not implement, and Android
MUST NOT assume a third vocabulary. Any mismatch requires a documented
compatibility adapter or version, not an implicit assumption.

## Development Workflow & Quality Gates

Spec Kit is the default engineering workflow for this repository.

- Trivial changes (spelling, comments, formatting, labels, version bumps) do not
  require the full workflow; every rule in this constitution still applies.
- Non-trivial bugs: `/speckit-bug-assess` then `/speckit-bug-fix` then
  `/speckit-bug-test`. Reproduce or establish root cause before patching; a
  green unit test is not proof that the production symptom is fixed.
- Features, refactors, schema, protocol, security and send-lifecycle changes:
  `/speckit-specify` then `/speckit-clarify` when ambiguous, then
  `/speckit-plan`, `/speckit-tasks`, `/speckit-analyze`, `/speckit-implement`
  and `/speckit-converge`. Do not implement before analyze reports the artifacts
  are coherent.
- Uncertain ideas: `/speckit-assess-intake` through `/speckit-assess-decide`.
  Only a GO decision becomes a specification.

**Version discipline.** `package.json` `version` is the single source of truth
(`0.19.3` at this amendment). Any API surface change MUST bump it, regenerate
`docs/openapi.json`, and update `docs/INTEGRATION.md` when consumer behaviour
changes — `scripts/hooks/pre-commit` enforces the spec refresh, and
`.github/workflows/ci.yml` fails on drift.

**Evidence commands.**

- Syntax: `npm run check` (cheap, but syntax-only — see Principle XVI)
- Unit and contract tests: `npm test`
- OpenAPI stays in sync: `npm run generate:openapi` then
  `git diff --quiet -- docs/openapi.json`
- Frontend artifact integrity: `npm run verify:artifacts`
- Operational health: `npm run doctor`, `npm run smoke`

**Documentation discipline.** Existing ADRs and remediation reports are inputs to
the specification process, not disposable legacy text. When a document
contradicts the code, the code and this constitution win, and the stale document
MUST be corrected or marked stale in the same change —
`docs/EVE_DELIVERY_ANSWERS.md` is currently stale in exactly this way.

## Governance

This constitution supersedes other development practices in this repository. A
repository `AGENTS.md` rule that conflicts with a MUST in this document is a
defect in that file, not a licence to bypass the principle.

- **Amendments** require a written rationale, the affected principle, a migration
  note when behavior changes, and an update to this document's version and
  amendment date. Amendment is done through `/speckit-constitution`.
- **Versioning** is semantic: MAJOR for a backward-incompatible governance change
  or principle removal/redefinition; MINOR for a new principle or materially
  expanded guidance; PATCH for clarifications and wording.
- **Compliance review** expects every non-trivial change to state which principles
  it touches and how it satisfies them, and to record any principle it knowingly
  violates as a known gap rather than silently.
- **Known violations** recorded above are pre-existing defects. They MUST be
  closed deliberately or explicitly re-ratified; they MUST NOT be used as
  precedent for new work.

**Version**: 1.1.0 | **Ratified**: 2026-09-15 | **Last Amended**: 2026-09-15
