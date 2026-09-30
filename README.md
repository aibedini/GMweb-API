<div align="center">

# 📲 GMweb API

**A messaging control plane for Android, the web, and business automation.**

Connect your phone. Manage conversations. Track sends with evidence you can inspect.

[API reference](docs/API.md) · [Integration guide](docs/INTEGRATION.md) · [Deployment](docs/DEPLOYMENT.md) · [Operations](docs/OPERATIONS.md)

</div>

## ✨ What GMweb does

GMweb connects the **Messages Android agent**, a linked **web/PWA inbox**, and service clients such as **EVE**. It owns authentication, pairing, command coordination, sync, and the durable send ledger. Android owns device data and modem submission; EVE owns business decisions and notification workflows.

The Chrome/Playwright adapter for Google Messages for Web remains available for legacy integrations. It is browser automation, not an official Google API. Transport selection and device readiness are separate from delivery confirmation.

| Capability | What you can expect |
| --- | --- |
| 💬 Web inbox | Conversations, contacts, bounded history loading, visible errors, and Retry controls |
| 📱 Android connection | Primary-device enrollment, signed identity, linked-browser approval, and device telemetry |
| 📤 Web sending | Encrypted commands carrying the selected active SIM's `subscriptionId`; visible prerequisite and command states |
| 🧾 Send tracking | SQLite ledger, queued execution, status polling, idempotency, cancellation, and revocation contracts |
| 🔔 EVE integration | Signed SMS lifecycle callbacks, notification correlation, carrier-report search, and bounded dead-letter recovery |
| 🔎 Diagnostics | Transport health, sync state, API/PWA versions, loaded versus served JavaScript, and recorded build revision |
| 🔑 Access control | Operator credentials, scoped project keys, signed agents, and capability-based linked sessions |

## 🧭 Choose the right interface

| Path | Audience | Purpose |
| --- | --- | --- |
| `/web` | Linked browser users | PWA inbox, contacts, sending, connection, security, and diagnostics |
| `/app` | Operators | React management console for queues, keys, controls, and operational status |
| `/dashboard` | Operators | Classic management dashboard |
| `/docs` | Integrators | Live OpenAPI reference |

The PWA lives in `web/`. The operator console lives in `dashboard-next/`; they are separate applications with separate build outputs.

## 🚀 Run locally

Use **Node.js 22.13.0 or newer** and a running Redis instance. Start with the supplied configuration, then replace the example credentials before exposing the service.

```bash
cp .env.example .env
npm ci
npm run token
npm start
```

On PowerShell, use `Copy-Item .env.example .env` for the first step. Copy the generated token into `API_TOKEN`. Review host binding, dashboard credentials, transport settings, and public origins in `.env`.

For the legacy Chrome transport, configure Chrome or install Playwright's browser, then pair Google Messages:

```bash
npx playwright install chromium
npm run login
```

For Android enrollment and linked-browser pairing, follow [the integration guide](docs/INTEGRATION.md) and [pairing protocol](docs/PAIRING-PROTOCOL-V1.md). Configure `PUBLIC_API_ORIGIN` and `PUBLIC_WEB_ORIGIN` explicitly for production. A normal browser pairing QR cannot enroll a Primary phone.

### Build the interfaces

```bash
npm run build:frontends
npm run verify:artifacts
```

For PWA development:

```bash
npm --prefix web ci
npm --prefix web run dev
```

For the operator console:

```bash
npm --prefix dashboard-next ci
npm --prefix dashboard-next run dev
```

### Ubuntu installation

The Ubuntu 22.04 installer provisions the API, Chrome, Redis, operator interfaces, and supporting services. Review the script and [VPS guide](docs/VPS.md) before running it with administrator privileges.

```bash
curl -fsSL https://raw.githubusercontent.com/aibedini/GMweb-API/main/install/ubuntu22.sh | sudo bash
```

Re-running the installer may rotate credentials and restart services. For release promotion, backups, and rollback, use [the deployment runbook](docs/DEPLOYMENT.md).

## 🔌 Integrate a service

Use a scoped **project key** (`gmw_...`) for service clients. Keep the master `API_TOKEN` for operator actions. Grant only the scopes the consumer needs; deliberately restricted keys are not automatically widened.

```bash
curl -X POST http://127.0.0.1:3030/send \
  -H "Authorization: Bearer $GMWEB_PROJECT_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: example-request-001" \
  -d '{"to":"<recipient-in-international-format>","text":"Your requested update is ready."}'
```

Replace the recipient placeholder before running the example. Acceptance into the queue is not proof of modem submission or carrier delivery. Retain the returned request ID and poll its status URL.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Public version and basic health |
| `GET /ready` | Readiness of the active delivery transport |
| `POST /send` | Submit a send request |
| `GET /send/status/:id` | Read the authoritative send outcome and separate carrier status |
| `GET /events` | Service event stream |
| `GET /eve/v1/transport-health` | Scoped, content-free delivery-transport diagnostics |
| `GET /eve/v1/sms-delivery-events` | Project-scoped carrier evidence, including `eveNotificationId` filtering |
| `POST /admin/eve-callbacks/requeue` | Operator-only recovery of bounded callback dead letters |

This is a navigation aid, not the complete contract. See [OpenAPI](docs/openapi.json) and [INTEGRATION.md](docs/INTEGRATION.md) for schemas, scopes, rate limits, and error handling. Gateway and linked-browser endpoints use their own documented authentication protocols.

## 📡 Understand send outcomes

- **Queued / accepted:** GMweb has accepted work; physical submission has not been established.
- **`send.sent`:** recorded submission evidence; this does not establish carrier delivery.
- **`sms.delivered`:** an authenticated Android carrier report supplies delivery evidence.
- **No carrier report:** delivery remains unconfirmed. Chrome does not provide Android carrier receipts.

EVE callbacks require `EVE_SMS_EVENTS_URL` and a shared `EVE_SMS_EVENTS_SECRET` of at least 32 characters. Partial or invalid configuration fails startup. With both absent, the integration is disabled.

Eligible `send.*` callbacks carry the safe `eve_notification_id` supplied by EVE. Existing queued callback bodies are not rewritten. After correcting the receiver or secret, operators can requeue dead letters while retaining their original body, event ID, delivery ID, and attempt history. See [the callback contract](docs/INTEGRATION.md#7-eve-signed-sms-callbacks-android-carrier-dlr-v5).

## 🔐 Security and data boundaries

Protect GMweb as you would the connected phone: authorized users may read or send messages. Use HTTPS, strong credentials, limited network exposure, and least-privilege project keys. Keep debug routes disabled in production and protect database backups, browser profiles, and device credentials.

Pairing protocol v1 authenticates participants; it does not itself encrypt message content. Legacy `cryptoVersion=0` envelopes contain Base64-wrapped plaintext. Eligible newer events use the [CKE/DEK v1 format](docs/MESSAGE-CRYPTO-V1.md); unsupported encrypted versions remain locked. Do not infer end-to-end encryption for historical legacy data.

## 🏗️ Project structure

| Location | Responsibility |
| --- | --- |
| `src/server.js` | API routes, authentication integration, and service orchestration |
| `src/sendStore.js` | Durable send ledger, carrier evidence, and callback outbox |
| `src/eveSmsEvents.js` | Signed callback delivery, retries, recovery, and health |
| `src/queue.js` | Redis/BullMQ execution infrastructure |
| `src/googleMessagesClient.js` | Legacy Chrome adapter |
| `web/` → `public/web-app/` | Linked-browser PWA source and built artifacts |
| `dashboard-next/` | React operator console |
| `shared/` | Versioned integration contracts |
| `test/` | Automated behavioral and contract checks |
| `specs/`, `.specify/` | Engineering specifications, constitution, and verification artifacts |

See [ADR-004](docs/adr/ADR-004-repository-and-product-boundaries.md) for the GMweb / Messages / EVE ownership model.

## 🧪 Verification and release status

The current change set targets **0.19.29**: history retry and cursor-progress checks, visible send prerequisites, active SIM selection, EVE notification correlation, callback recovery, and build diagnostics.

Run the repository checks before handing off changes:

```bash
npm run check
npm test
npm run generate:openapi
npm run verify:artifacts
```

`npm run check` checks syntax. Automated tests cover local behavior and contracts; they do not establish physical-device or production acceptance.

**Production acceptance remains NOT VERIFIED for this change set:** interactive browser acceptance, two-SIM telemetry and execution on a real device, modem submission, carrier reporting, and actual callback receipt in EVE still require evidence. No Messages Android changes are included here. Use synthetic test messages, never customer SMS.

Debug reports compare the loaded and served JavaScript files and show the recorded build revision. That revision identifies HEAD at build time; it does not identify uncommitted changes or prove which release production serves.

Non-trivial changes follow the repository's Spec Kit workflow and [constitution](.specify/memory/constitution.md). The inherited implementation was produced without available Spec Kit and graph MCP tools; that process gap remains disclosed rather than treated as completed verification.

## 📚 Continue from here

- [Integration guide](docs/INTEGRATION.md): connect a consumer and interpret outcomes.
- [API reference](docs/API.md): endpoint behavior and permissions.
- [Deployment](docs/DEPLOYMENT.md): promote artifacts and plan rollback.
- [Operations](docs/OPERATIONS.md): diagnose and recover the service.
- [Physical pairing gate](docs/PAIRING-E2E.md): collect device acceptance evidence.
- [Messages web physical gate](docs/MESSAGES-WEB-PHYSICAL-GATE.md): verify the complete device/browser path.
