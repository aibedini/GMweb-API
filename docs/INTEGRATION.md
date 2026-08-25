# GMweb — Integration Guide (for a consuming project)

This document is the stable hand-off for **another project** that wants to send and
read messages through this GMweb server. Hand this file plus
[`openapi.json`](./openapi.json) to the other project (or its AI agent) and it has
everything needed to integrate — without reading any of GMweb's internal source.

- **Machine-readable contract:** [`openapi.json`](./openapi.json) — full request/response
  schemas, generated from the live code so it always matches reality.
- **Human + agent guide:** this file — auth, the endpoints that matter, and the
  **sync mechanism** so the consumer stays up to date when GMweb is updated.

---

## 1. Connecting

| | |
|---|---|
| **Base URL** | `https://YOUR_HOST` (set to your deployed host; locally it is `http://127.0.0.1:3030`) |
| **Auth** | `Authorization: Bearer <token>` on every request except `GET /health` |
| **Token type** | Use a **Project API key** (`gmw_...`), *not* the master token |

### Getting a Project API key
A project key can call messaging + conversation endpoints but **cannot** touch admin
routes (`/admin/*`, `/browser/*`, `/session/*`) — those return 401. This is the safe
credential to give the consuming project.

Create one from the GMweb dashboard, or with the master token:

```bash
curl -X POST https://YOUR_HOST/admin/api-keys \
  -H "Authorization: Bearer <MASTER_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "project-two",
        "allowedIps": ["<PROJECT_TWO_SERVER_IP>"],
        "rateLimit": { "minute": 10, "hour": 100 }
      }'
```

The full `gmw_...` token is returned **only once** in that response — store it in the
consuming project's secrets (env var), never in code.

> Because the consumer connects over the internet, set `allowedIps` to its server IP
> and serve GMweb over **HTTPS** (terminate TLS at a reverse proxy). Repeated bad-auth
> attempts from an IP are auto-blocked for 30 minutes.

---

## 2. The endpoints that matter to a consumer

Full schemas are in [`openapi.json`](./openapi.json). The relevant subset:

| Method & path | Purpose |
|---|---|
| `GET /health` | Public. Returns `{ ok, service, version }`. Used for **sync detection** (see §4). |
| `GET /ready` | `200` when Google Messages is paired and ready; `503` otherwise. Check before sending. |
| `POST /send` | Queue a message. Returns `202 { requestId, jobId }`. Pass `"wait": true` to block for the result. |
| `GET /send/capacity` | Pending counts for all four lanes and remaining announcement capacity. |
| `GET /send/status/:requestId` | Poll a send request: `queued` / `active` / `sent` / `failed` / `cancelled`. `jobId` is also accepted. |
| `POST /send/cancel/:requestId` | Cancel a queued send before it starts. Project keys can cancel only their own sends. |
| `GET /conversations?limit=20` | List recent conversations (title, snippet, unread, stable `href`). |
| `POST /conversations/open` | Open a conversation by `href` / `id` / `title` / `index`. |
| `GET /messages/active?limit=50` | Read messages from the currently open conversation. |
| `POST /conversations/messages` | Open a conversation **and** return its messages in one call. |
| `GET /events` | SSE stream. A project key receives only its own sends' events (`send_queued` / `send_processing` / `send_completed` / `send_failed` / `send_cancelled`). The master token and dashboard sessions receive the full stream, including `conversation_changed` and browser recovery events. |

> **Send power (kill switch):** an operator can power off sending from the GMweb
> dashboard (Controls → **Power Off**). While powered off, `POST /send` returns
> `503 { "error": "powered_off" }` and **no message is sent under any
> circumstances** — queued messages are held, not dropped. Sending resumes only
> after **Power On** is pressed. Consumers should treat `503 powered_off` as
> "retry later", never as a code or credential error.

If `WEBHOOK_URL` is configured, browser recovery events are delivered to that
receiver as well as the live SSE stream. `browser_recovering` includes the
recovery `action` and `outcome`; `browser_hard_restart` means the Chrome and API
service restart has been scheduled. Consumers should log these events but must
not resubmit the SMS: the original BullMQ job remains responsible for retrying.

### Send a message
```bash
curl -X POST https://YOUR_HOST/send \
  -H "Authorization: Bearer gmw_..." \
  -H "Content-Type: application/json" \
  -d '{ "to": "+989121234567", "text": "Hello" }'
# -> 202 { "ok": true, "requestId": "send_123", "statusUrl": "/send/status/send_123", "jobId": "...", "status": "queued" }
```
Phone numbers must include the country code. Sends are async by default; either poll
`GET /send/status/:requestId` or listen on `GET /events`. A successful status
includes `requestedTo`, `sentTo`, `recipientEvidence`, and `conversationUrl`.
Treat `sentTo` as the recipient that GMweb verified in the Google Messages UI
before pressing Enter; `requestedTo` is the original API input. New sends fail
closed with `recipient_unverified` rather than sending when this proof cannot be
established. `jobId` is still
accepted for backwards compatibility, but consumers should store `requestId`
because it remains stable even if the internal queue job changes. For simple
callers, add `"wait": true` to get `200 { status: "completed" }` directly
(up to 90s).

After Enter is pressed, GMweb never submits that message a second time. It first
checks for the outgoing bubble, then performs delayed DOM-only verification
checks. Poll responses expose `submittedOnce`, `submittedAt`,
`verificationStatus`, and `verificationAttempts`. A message confirmed during a
later check is still `status: "sent"` with
`verificationStatus: "confirmed_after_recheck"`. If every check is exhausted,
the terminal status is `unverified`, the stage is
`unverified_manual_review`, and consumers must not resend automatically because
the phone may already have sent it.

### Priority lanes and announcement feeder

`POST /send` accepts four canonical lanes: `critical` (level 1: purchase and
renewal), `expired` (3: time/volume exhausted), `expiring` (6: nearing expiry,
also the default), and `announcement` (10: bulk/lowest). Lower levels run first,
FIFO is preserved within every lane, and the currently active browser send is
never interrupted. Legacy `high` maps to `critical`; legacy `normal` maps to
`expiring`.

Announcements have a pending cap controlled by `ANNOUNCEMENT_PENDING_LIMIT`
(default 200). The consumer must retain the full campaign in its own database,
call `GET /send/capacity`, and enqueue no more than
`announcement.available`. A race at the limit returns
`429 announcement_queue_full` plus `Retry-After: 60`. See
[`EVE_SEND_PRIORITY.md`](./EVE_SEND_PRIORITY.md) for the complete Eve feeder,
idempotency, status-machine, and migration contract.

### Cancel before send starts

```bash
curl -X POST https://YOUR_HOST/send/cancel/send_123 \
  -H "Authorization: Bearer gmw_..."
# -> 200 { "ok": true, "requestId": "send_123", "status": "cancelled", "terminal": true }
```

Cancel only works before the worker starts sending the message. If the send is
already active or already terminal, GMweb returns `409 { "error": "not_cancellable" }`.
Project API keys can cancel only send requests created by that same key.

### Read incoming SMS
```bash
# 1) list conversations, grab a href
curl -H "Authorization: Bearer gmw_..." "https://YOUR_HOST/conversations?limit=20"
# 2) read one conversation
curl -X POST https://YOUR_HOST/conversations/messages \
  -H "Authorization: Bearer gmw_..." -H "Content-Type: application/json" \
  -d '{ "href": "/web/conversations/123", "limit": 50 }'
```

---

## 3. Source of truth & versioning

`openapi.json` is **generated from the route schemas** in GMweb's code, so it never
drifts from the real behavior. Its `info.version` mirrors `package.json` `version`,
and `GET /health` returns that same `version`. That single number is the sync signal.

When GMweb changes:
1. Maintainer bumps `version` in `package.json`.
2. Maintainer runs `npm run export:openapi` → refreshes the committed `openapi.json`.
3. Consumers notice the new `version` from `/health` and re-fetch the spec (see §4).

---

## 4. Hybrid sync (static file + auto re-fetch)

The consuming project keeps a **local committed copy** of `openapi.json`, and at runtime
**checks `/health`** to detect a new version and pull a fresh spec automatically. Best of
both: works offline from the committed file, self-heals when GMweb is updated.

Drop this into the consuming project:

```js
// gmweb-sync.js — keep the local OpenAPI spec in sync with the GMweb server.
import fs from "node:fs/promises";

const BASE = process.env.GMWEB_BASE_URL;     // e.g. https://your-host
const TOKEN = process.env.GMWEB_API_KEY;     // gmw_... project key
const SPEC_PATH = new URL("./gmweb.openapi.json", import.meta.url);

async function localVersion() {
  try {
    const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));
    return spec?.info?.version ?? null;
  } catch {
    return null;            // no local copy yet
  }
}

// Returns the spec, re-fetching only when the server's version differs.
export async function ensureSpec() {
  const health = await fetch(`${BASE}/health`).then((r) => r.json());
  const remote = health.version;
  const local = await localVersion();

  if (local === remote) {
    return JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));   // up to date
  }

  // Version changed (or first run) -> pull the fresh contract.
  const res = await fetch(`${BASE}/docs/json`, {
    headers: { authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
  const spec = await res.json();
  await fs.writeFile(SPEC_PATH, JSON.stringify(spec, null, 2));
  console.log(`GMweb spec synced: ${local ?? "none"} -> ${remote}`);
  return spec;
}
```

Call `ensureSpec()` on startup (and optionally on an interval). `/health` is public and
cheap, so the version check costs almost nothing; the full `/docs/json` fetch (which
needs the project key) happens **only** when the version actually changed.

> Note: a `version` bump signals "something changed." Whether it's a breaking change is
> up to GMweb's versioning discipline — treat a **major** bump as potentially breaking and
> review the diff of `openapi.json` before relying on new behavior.

---

## 5. Delivery transports (Chrome browser or Android gateway)

GMweb has two interchangeable delivery transports behind the same API:

| | `chrome` (default) | `android` |
|---|---|---|
| Delivery path | Playwright drives Google Messages for Web | Relays to the [Messages](https://github.com/aibedini/Messages) Android app over its EVE Custom HTTP contract (`POST /send`, polls `/send/status/:id` until terminal) |
| Readiness | paired browser session | phone reachable (`GET /ready` on the device) |
| Selection | default | dashboard → Controls → **Delivery transport**, or `POST /admin/transport {"transport":"android"}` (master token); persisted in `data/transport.json`, survives restarts |

Both transports run side by side; exactly one is active. Everything a consumer
depends on — auth, `POST /send`, priority lanes, idempotency, status polling,
cancel, capacity, SSE/webhooks — behaves identically regardless of the active
transport. While `android` is active, `POST /send` returns
`503 android_gateway_unreachable` if no device is connected (treat as "retry
later").

### Android pull mode (default)

The Messages app dials OUT to GMweb (`GET /gateway/pull`, `POST /gateway/ack`)
authenticated with the dashboard-managed device key (`X-API-Key`; manage it via
`GET/POST /admin/device-key*`). No tunnel or inbound port is required.

Transport-scoped endpoints while `android` is active:

- `GET /ready`, `GET /admin/overview`, `GET /session/status` report pull-bridge
  liveness (a device long-polling within the last 90s) instead of browser state.
- `GET /conversations` returns a conversation list derived from the durable
  send ledger (`source: "ledger"`) — outbound history per number.
- `POST /conversations/messages` resolves the thread by phone number from the
  ledger (`source: "ledger"`).
- Browser-only endpoints (`GET /session/screenshot`,
  `GET /messages/active`, `POST /conversations/open`, `/debug/*`,
  admin actions `browser-start`/`browser-restart`) return **501
  `chrome_only_endpoint`** instead of a generic error — switch transport to use
  them.
