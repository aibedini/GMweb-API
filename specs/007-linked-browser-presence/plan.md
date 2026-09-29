# Plan and analysis

Use a separate `linked_session_presence` table keyed by the existing session-token hash so the five-column `linked_sessions` contract and existing rows stay intact. Observe only already authenticated linked requests. Join to `linked_client_sync_state` by account and device for durable sync time. Keep authorization in both the server allowlist and route handler. Add a privacy-focused Fastify test and document the route/OpenAPI together with version 0.19.25.

Analysis: the new table is additive and does not alter trust approval or revocation semantics. Revocation removes presence for the revoked device. Existing sessions acquire IP and user agent on their next allowed request. The IP is the server's trusted `request.ip`; proxy configuration determines whether it is the browser or an upstream proxy. The browser treats missing fields as unknown.
