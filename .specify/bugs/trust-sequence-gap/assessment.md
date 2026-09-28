# Bug Assessment: Trust statements falsely acknowledged across a sequence gap

- **Slug:** trust-sequence-gap
- **Status:** confirmed
- **Cross-repository feature ID:** android-web-recovery-v1

## Symptom

The active linked browser session claims trust sequence 48, but the GMweb signed registry stops at 43 and has no statement for that browser. The Android Full Test shows `Trust outbox PASS 0 pending`, while web decryption reports the primary trust root unavailable.

## Root cause

GMweb responds HTTP 200 with `{ok:true, applied:false, reason:"sequence_gap"}` when a signed statement arrives out of order. `Messages` Android `TrustStatementPublisher` treats every 2xx response as a durable acceptance and marks the row `PUBLISHED`. A single gap can therefore silently acknowledge all later local statements even though GMweb has stored none of them.

## Remediation

GMweb should return HTTP 409 for a sequence gap, expose an authenticated primary-agent trust position, and retain 200 only for applied or identical redelivery. Android should inspect the response body, reconcile its durable signed outbox with the server position, and replay the missing ordered rows. No private key or grant is generated on the server.

## Safety

Server-side repair must not synthesize signed statements or mark encrypted grants successful. Android recovery must preserve the original signed bytes and stop if any local sequence is absent.
