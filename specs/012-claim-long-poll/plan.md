# Plan — claim-long-poll-v1

1. `src/claimWaiters.js`: per-agent waiter map, 500 cap, 2000 ms re-check,
   abort/shutdown cleanup, and the exported `clampWaitMs` helper.
2. `src/controlPlaneRoutes.js`: `waitMs` querystring schema + tolerant
   pre-validation, one immediate claim, waiter await, and `notify()` after a
   fresh `createCommand`; `app.onClose` shuts all waiters down.
3. Tests in `test/claimLongPoll.test.js` with a real `Fastify` + in-memory
   SQLite harness and short real timers.
4. Version 0.20.0, `npm run generate:openapi`, and `docs/INTEGRATION.md`.
5. `npm run check`, full `npm test`, then commit on `feat/claim-long-poll`.
