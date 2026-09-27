# Plan: Eve signed SMS events

## Technical context

- Node 22, Fastify 5, `better-sqlite3` send ledger at `data/sends.db`.
- Existing `SendStore` status mutations are the canonical transition boundary. SQLite triggers can append an immutable Eve event in the same transaction as each relevant row transition, including late ACK reconciliation.
- A dedicated worker reads the ledger's Eve outbox and sends over HTTPS. The generic `WEBHOOK_URL` remains separate.

## Constitution check

- Durable ledger, stable identity, physical truth, ACK idempotency and revocation are preserved by observing committed `sends` status changes in the same SQLite database. No callback is sent from request acceptance or BullMQ state alone.
- No cross-repository code change is made. Staging/Eve ingestion evidence remains NOT VERIFIED.
- Additive schema migration; preexisting rows are not modified or replayed.

## Design

1. Add `eve_sms_outbox` with immutable body and unique event identity, attempt state, retry time and bounded diagnostics.
2. Add insert/update triggers scoped to `source='eve'` and relevant durable statuses. Build JSON only from allowlisted ledger fields; omit `to_number`, `text`, service key, errors and provider results.
3. Create a single process callback worker with stale-claim recovery and persisted scheduling. Sign one stored UTF-8 body buffer and transmit that buffer.
4. Start and stop the worker with the API process only when URL and secret pass validation.
5. Document configuration and operator checks, then run targeted and full verification.

## Data model

`eve_sms_outbox`: `id`, `event_id`, `delivery_id`, `event_type`, `send_id`, `body`, `state`, `attempt_count`, `next_attempt_at`, `last_attempt_at`, `last_http_status`, `last_error`, `delivered_at`, `created_at`. `body` is immutable after insertion. `id` is the row sequence used to derive stable IDs. `send_id` refers to a ledger row. States: `pending`, `delivering`, `retry_wait`, `delivered`, `dead_letter`.

## Contract

POST the stored body to `EVE_SMS_EVENTS_URL` with `Content-Type: application/json`, `X-GMweb-Timestamp`, `X-GMweb-Delivery-Id`, `X-GMweb-Signature`. The body is a bounded object containing `event_id`, `trace_id`, `message_id`, `type`, `occurred_at` and optional bounded `attempt`/`stage`. No carrier delivery event without DLR.

## Validation guide

Use a local mock HTTPS receiver and synthetic ledger entries. Confirm queued/sent/failure/cancellation timeline, signature bytes and retry persistence. Run `npm run check`, `npm test`, `npm run generate:openapi` only if the API schema changes. Staging and device checks require deployment credentials and must not send customer SMS.
