# linked-sms-realtime-v1

## Scope

The linked Messages browser and Primary Android phone must agree on the newest conversation head, send using a chosen active SIM, show accurate SMS segment cost, and refresh visible content promptly without waiting for key maintenance. GMweb stores opaque encrypted content and sends content-free SSE invalidations.

## Requirements

1. Android's durable outbox insertion ID (`sourceOrder`) orders encrypted current state despite upload reordering. It permits a conversation head to move backward after deletion and rejects a delayed historical event. Agents without this field retain the legacy sort/revision fallback. Browser cache applies the same ordering rule.
2. The selected thread's decrypted newest message reconciles sidebar preview, timestamp, and order while a conversation upsert is in transit. The server remains the source of durable encrypted state.
3. Every accepted event is committed before SSE invalidation. Browser coalesces frames and catches up on every reconnect; polling remains a recovery safety net.
4. Composer displays GSM-7 or Unicode, units, segments, and remaining capacity. GSM extensions cost two septets; UTF-16 surrogate pairs remain whole.
5. Primary Android publishes only active subscription ID, slot, bounded labels, and default status to authenticated linked browsers. An encrypted SEND_SMS command carries the chosen ID. Android refuses an unavailable or unverified requested SIM before modem submission.
6. Visible inbox sync reports independently of key maintenance. Key HTTP requests have their own timeout, and grant progress is persisted in bounded batches.

## Acceptance

Synthetic regression tests must cover stale revision, out-of-order event, thread/sidebar reconciliation, SSE burst and reconnect, SMS boundaries, exact/removed SIM, stalled key request, and existing E2EE restrictions. Real phone latency and dual-SIM physical send require explicit device evidence; absent it, report NOT VERIFIED.
