# Verification Quickstart

1. Run focused gateway presence, contract, health and control-plane tests.
2. Verify gateway ping/status with good and bad keys and unchanged `lastPullAt`.
3. Verify agent ping with signed AgentAuth and unchanged EventStore contents.
4. Exercise empty/task pull, validate and ACK telemetry.
5. Inspect admin diagnostics and copied JSON with canary key, phone and body strings; none may appear.
6. Run the final repository gate once: `npm test`, `npm run check`, `npm run build:frontends`, `npm run verify:artifacts`, `git diff --check`.

Physical Android, deployed proxy/TLS, real Redis/BullMQ process behavior and real SMS delivery remain NOT RUN.
