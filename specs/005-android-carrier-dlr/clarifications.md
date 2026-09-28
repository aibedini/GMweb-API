# Clarifications resolved from the handoff

- `eventId`: `dlr_` followed by 1–192 ASCII letters, digits, `_` or `-`; maximum 196 characters. This allows a stable opaque Android ID and rejects whitespace/control characters.
- `requestId`: 1–120 ASCII letters, digits, `_` or `-`, matching the existing gateway identity bound. The canonical lookup is `byGatewayRequest`.
- `occurredAt`: integer epoch milliseconds from 2020-01-01 through 24 hours in the future. The future allowance tolerates device clock skew; reports older than 2020 or farther ahead are rejected.
- A duplicate means the same event ID, gateway request ID, status and occurredAt. Device ID is a diagnostic claim, not the event's semantic identity.
- Distinct event IDs are preserved as distinct reports, even if they share send/status. Current carrier status prioritizes any delivered report, then failed, then pending/unavailable.
- Android's optional `X-Gateway-Device-Id` is bounded and recorded for diagnostics. Since the gateway key is shared, that header is not an independent authorization boundary.
- Callback `trace_id` follows existing GMweb practice (`send_<ledger-id>`), which is safe and correlates with `/send` without exposing an arbitrary consumer correlation string. An optional Eve notification ID is accepted only as an opaque bounded identifier.
- A carrier report can arrive before the gateway ACK or after an uncertain/failed ledger status. Its authenticated definitive evidence is recorded without deleting the earlier status history.
