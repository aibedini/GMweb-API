# Validation guide

1. Run `npm run check` and `npm test` on the exact candidate revision.
2. Run `npm --prefix web run build` and `npm run verify:artifacts` when web code changes.
3. Regenerate `docs/openapi.json` with `npm run generate:openapi` after any route, schema or authentication change; bump `package.json` version and check `docs/INTEGRATION.md`.
4. Run targeted tests for multi-page snapshot, concurrent event during snapshot, browser restart, key outage and late grant, duplicate ingest, lost command response, lease recovery, device revocation, and missed SSE.
5. Run a synthetic 360k-message load profile and record machine, duration, peak memory, query plans and page counts. Label this synthetic.
6. Complete `docs/MESSAGES-WEB-PHYSICAL-GATE.md` on a controlled Android device and multiple browsers before claiming physical acceptance. Never use customer SMS as test material.
