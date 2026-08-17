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

Returns service health.

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

### GET /events

Server-sent events stream for send lifecycle, conversation changes, and browser
recovery (`browser_recovering` / `browser_hard_restart`) events.

### POST /admin/queue/jobs/bulk

Dashboard/master-token endpoint for selected pending jobs. Supported actions are
`cancel`, `complete`, and `priority`. Priority changes require one of
`critical`, `expired`, `expiring`, or `announcement`. The response reports
`processed`, `skipped`, and a per-job `results` array; active/terminal/missing
jobs are skipped, and bulk changes to announcement respect its pending cap.
