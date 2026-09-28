# Bug Assessment: Android full test times out on GMweb

- **Slug:** android-diagnostics-timeout
- **Status:** confirmed
- **Severity:** high for diagnostics; does not by itself explain missing decryption grants
- **Cross-repository feature ID:** android-web-recovery-v1

## Symptom and reproduction

Android Full Test reports `GMweb API FAIL SocketTimeoutException` despite the API serving the web PWA. The phone uses a 15-second read timeout for `POST /api/v1/agent/diagnostics`.

## Evidence and root cause

`EventStore.diagnosticStats()` issues twelve separate aggregate queries across `sync_events`. Production has about 1.13 million events and no covering diagnostic index. Read-only timing on the production database showed a single filtered count at 1.75 seconds, one crypto grouping at 2.10 seconds, and a source count at 1.73 seconds. The combined route exceeds the phone's 15-second read timeout under load. A single grouped scan covering both account and source counts completed in 3.46 seconds on that same database.

## Remediation

Compute account and source totals, event-type counts, maximum sequence, and crypto-version distribution in one grouped scan. Preserve the response contract and empty-account behavior. Add correctness and query-plan evidence, then remeasure on a production-like database.

## Separate findings

The server trust registry stops at sequence 43 while the active linked browser session claims sequence 48. The active browser is absent from the server's signed statements. Android also reports one dead-lettered `HISTORY_KEY_GRANT` and a large event outbox backlog. Those are distinct blockers and require Android outbox evidence before any destructive replay or key-state mutation.
