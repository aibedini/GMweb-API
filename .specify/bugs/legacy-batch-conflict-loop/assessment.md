# Bug Assessment: Legacy batch conflict retry loop

## Evidence

Android Full Test reports more than 250,000 pending events and a growing dead-letter count. GMweb production logs show batches with 100 duplicates and zero accepted events. Android `EventUploader` uses the V1 batch route; `BatchAckParser` can act on per-item outcomes but V1 supplied only `accepted[]` plus an aggregate `duplicates` count. `EventStore` counts conflicting same-ID/different-byte events as duplicates while omitting them from `accepted[]`. Android therefore retries them indefinitely and can starve later valid events.

## Verdict

Valid, high severity. The exact distribution of conflicts in the phone's private outbox is not directly observable from GMweb logs, but a zero-accepted all-duplicate batch is consistent with this mechanism. No row may be falsely acknowledged or bulk removed.

## Remediation

Return additive `results[]` from V1 with the already computed stable per-item `ACCEPTED`, `DUPLICATE`, `CONFLICTING_DUPLICATE`, or `INVALID_*` status. Preserve `accepted[]` and `duplicates` for legacy callers. Advertise per-item results; update OpenAPI and integration docs. Android 3.4.15+ already parses these statuses, dead-letters only permanent conflicts, and advances the remaining queue.

## Verification

Unit/contract tests for byte-identical retry and conflicting retry, full GMweb suite, production batch aggregate trends after deployment, and a new Android Full Test. A dead letter is not proof that historical data is complete; retain it for review.
