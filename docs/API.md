# GMweb API

Base URL:

```text
http://127.0.0.1:3030
```

Auth header, except public `/health` when `PUBLIC_HEALTH=true`:

```text
Authorization: Bearer <API_TOKEN>
```

## Endpoints

### GET /health

Returns basic process reachability: `{ok,service,version,serverTime,uptimeSeconds}`.
It does not assert that an Android phone is connected or that delivery is ready.

### GET /ready

Starts/checks the browser session and returns `503` when Google Messages is not paired.

### POST /browser/start

Starts the controlled Chrome session and opens Google Messages.

### POST /browser/stop

Stops the browser session.

### POST /browser/restart

Stops and starts the browser session. Useful after a stuck Google Messages page.

### GET /session/status

Returns pairing/readiness state.

### GET /session/screenshot

Returns a PNG screenshot. Useful for first pairing on a headless VPS.

### GET /conversations?limit=20

Returns structured conversation rows:

```json
{
  "conversations": [
    {
      "id": "/web/conversations/...",
      "href": "/web/conversations/...",
      "title": "Contact name",
      "snippet": "Last message",
      "timestamp": "12:51 PM",
      "text": "Raw row text"
    }
  ]
}
```

### GET /messages/active?limit=50

Returns messages from the currently open conversation.

### POST /conversations/open

Opens a conversation by one of `id`, `href`, `title`, or `index`.

```json
{
  "title": "Contact name"
}
```

### POST /conversations/messages

Opens a conversation and returns messages from it.

```json
{
  "href": "/web/conversations/...",
  "limit": 50
}
```

### POST /send

```json
{
  "to": "+989195292411",
  "text": "test",
  "priority": "critical"
}
```

Returns `requestId`, `statusUrl`, and `jobId`. Store `requestId` as the stable
shared id for polling/cancel; `jobId` is the current queue job id.
Canonical priorities are `critical` (1), `expired` (3), `expiring` (6, default),
and `announcement` (10). Lower levels run first and every lane is FIFO.

Optional consumer notification metadata. Omit it and the request behaves exactly
as before; supply it and the reminder can be revoked later by a renewal:

```json
{
  "to": "+989195292411",
  "text": "Your volume has ended",
  "priority": "expired",
  "meta": {
    "source": "eve",
    "serviceKey": "eve:12:2f1c-uuid",
    "notificationKind": "volume_ended",
    "generation": 17,
    "correlationId": "8f2c-uuid",
    "requiresValidation": true
  }
}
```

`notificationKind` is one of `near_expiry`, `low_volume`, `expired`,
`volume_ended`, `created`, `renew`. `requiresValidation` is DERIVED server-side
(true for the first four, false for `created`/`renew`); a client cannot opt a
depletion claim out of validation. A partial or unknown `meta` is rejected with
`400 invalid_meta` rather than stored unrevocable.

### GET /send/capacity

Returns pending counts per priority and `announcement.{limit,pending,available,
recommendedBatchSize}`. Bulk producers must feed only the available number of
announcements; `POST /send` returns `429 announcement_queue_full` at the cap.

### GET /send/status/:reference

Poll send status using `requestId` such as `send_123` or a current `jobId`.
For completed sends, compare `requestedTo` with `sentTo`. The response also
contains `recipientEvidence` and `conversationUrl` so recipient selection can be
audited. GMweb refuses to press Enter if the active recipient cannot be verified.

### POST /send/cancel/:reference

Cancels a queued send before it starts. Project API keys can cancel only their
own sends. Returns `409 not_cancellable` when the send is already active/sent.

### POST /send/invalidate

Semantically invalidates every outstanding reminder of ONE service after a
renewal — including one the queue already marked active. Requires the
`sms.invalidate` scope (part of the default project-key scopes).

```json
{
  "source": "eve",
  "serviceKey": "eve:12:2f1c-uuid",
  "currentGeneration": 18,
  "invalidateKinds": ["near_expiry", "low_volume", "expired", "volume_ended"],
  "reason": "renewed",
  "correlationId": "8f2c-uuid",
  "eventId": "renewal-2026-09-13-0001"
}
```

```json
{
  "ok": true,
  "serviceKey": "eve:12:2f1c-uuid",
  "currentGeneration": 18,
  "cancelledPending": 2,
  "revokedActive": 1,
  "revokedInflight": 1,
  "alreadyTerminal": 0
}
```

* `serviceKey` identifies one service, never a phone number: the same customer
  can own several services on one MSISDN and renewing one must not silence the
  others.
* `currentGeneration` is a monotonic per-service watermark. A request carrying a
  generation below one already recorded is refused with `409 stale_generation`;
  every reminder below the watermark is invalid forever, so a delayed retry
  cannot resurrect it.
* Idempotent on `eventId`: repeating it replays the original answer
  (`replayed: true`) and changes nothing.
* A project key may only invalidate a service it has actually sent to; anything
  else is `404 not_found`.

### Android device bridge (`X-API-Key: <device key>`)

Used by the Messages Android app when the transport is `android` in pull mode.

* `GET /gateway/ping` — cheap credential and reachability probe using the exact
  same shared device key as pull. It never opens a poll or refreshes liveness.
* `GET /gateway/status` — detailed read-only server-side pull-bridge status.
  It never claims or mutates a task.
  Diagnostic probes are rate-limited and return `429 rate_limited` with
  `Retry-After` when their allowance is exceeded.

* `GET /gateway/pull?waitMs=25000` — long-poll for the next task. Tasks whose
  lifecycle was invalidated are terminalized as superseded and never handed out.
  Returns `{task:{requestId,to,text,priority,meta}}` or `{task:null}`. `meta` is
  `null` for sends that carried none, so older builds are unaffected.
* `POST /gateway/validate` — `{requestId}` → `{valid,status,reason}`. The final
  gate before the modem: it answers `valid:false, status:"superseded"` the
  instant the service generation is invalidated, including while the task is
  already in flight. It returns no task, customer or message metadata.
* `POST /gateway/ack` — `{requestId, ok, outcome?, reason?}`.
  `outcome` is `sent` | `failed` | `superseded`; when omitted it is derived from
  `ok`, so legacy `{requestId, ok}` bodies keep working. `superseded` is
  terminal, not successful, not billable and not retryable. A real submission
  that arrives after its own revocation is recorded as
  `send_sent_after_revocation` and counted in `sms_sent_after_revocation_total`
  instead of being reported as a cancellation.

The optional `X-Gateway-Device-Id` header is a bounded observability label only;
it never grants access. Existing clients without it remain supported.

### POST /api/v1/agent/ping

Verifies the independently signed AgentAuth/control-plane identity and returns
the authenticated device ID and role. It performs no durable application/sync
mutation. A successful agent ping says nothing about `/gateway/*` Device Key
health, and a successful gateway ping says nothing about AgentAuth.
The probe is rate-limited independently from event ingestion.

### GET /admin/gateway-diagnostics

Master/dashboard-authenticated privacy-safe pull telemetry. Returns bridge,
device-presence and queue aggregates without API keys, signatures, recipients,
message bodies or raw request IDs.

### GET /events

Server-sent events stream for send lifecycle, conversation changes, and browser
recovery (`browser_recovering` / `browser_hard_restart`) events.

### POST /admin/queue/jobs/bulk

Dashboard/master-token endpoint for selected pending jobs. Supported actions are
`cancel`, `complete`, and `priority`. Priority changes require one of
`critical`, `expired`, `expiring`, or `announcement`. The response reports
`processed`, `skipped`, and a per-job `results` array; active/terminal/missing
jobs are skipped, and bulk changes to announcement respect its pending cap.
