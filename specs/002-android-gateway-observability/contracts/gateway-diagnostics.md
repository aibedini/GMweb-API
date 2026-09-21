# API Contract: Gateway Diagnostics

## Public reachability

- `GET /health`: existing public endpoint; adds `serverTime` and `uptimeSeconds`.

## Shared gateway-key dimension

- `GET /gateway/ping`: requires `X-API-Key`; 200 when pull mode is active, 401 for bad key, 409 when inactive. Read-only.
- `GET /gateway/status`: requires `X-API-Key`; returns detailed server-side bridge status. Read-only.

Neither endpoint updates pull timestamps, active polls, presence or queue ownership.

## AgentAuth dimension

- `POST /api/v1/agent/ping`: requires the existing AgentAuth gate; returns bound device ID, role and protocol version.
- Performs no durable application/sync mutation.

## Admin dimension

- `GET /admin/gateway-diagnostics`: existing dashboard/master authentication; returns safe transport, key configuration source, bridge, devices, queue and recent fields.
- Never returns full key, auth signature, phone number, SMS body or raw request ID.

## Compatibility

- Existing `/gateway/pull`, `/gateway/validate` and `/gateway/ack` response bodies retain their existing schemas and semantics.
- `X-Gateway-Device-Id` is optional and observability-only.
