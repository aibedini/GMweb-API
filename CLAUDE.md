# GMweb — project guide for Claude

GMweb is a Fastify REST API that controls **Google Messages for Web** through a
Playwright-driven Chrome session, so other apps can send/read SMS over HTTP.

## Architecture (key files)
- [src/server.js](src/server.js) — Fastify app: all routes, auth, OpenAPI (`@fastify/swagger`).
  Routes are registered inside `app.after()` so they appear in the generated spec.
- [src/googleMessagesClient.js](src/googleMessagesClient.js) — Playwright automation of Google Messages Web.
- [src/queue.js](src/queue.js) — BullMQ send queue (needs Redis). One in-process worker, concurrency 1, shares the single browser.
- [src/apiKeys.js](src/apiKeys.js) — project API keys (`gmw_...`), hashed on disk, per-key rate limits + IP allowlist.
- [src/config.js](src/config.js) — env config. Server boots only when run directly (`require.main === module`).
- [public/dashboard/](public/dashboard/) — built-in dashboard at `/dashboard`.

## Auth model
- **Master token** (`API_TOKEN` env) — full access incl. `/admin/*`, `/browser/*`, `/session/*`.
- **Project key** (`gmw_...`) — messaging + conversations only; admin paths return 401. This is what external consumers get.

## Consumer integration & sync
Another project consumes this API. It is kept in sync via:
- [docs/openapi.json](docs/openapi.json) — machine-readable contract (generated from code).
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — hand-off guide + hybrid-sync client code.
The consumer compares its local spec `version` against `GET /health` and re-fetches `GET /docs/json` when it changes.

## ALWAYS: keep the API contract in sync (do this automatically, no need to be asked)
Whenever an API surface changes — any route, request/response schema, or auth
behavior in `src/server.js` — before committing:
1. Bump `version` in [package.json](package.json) (semver; major = breaking).
2. Run `npm run generate:openapi` to refresh [docs/openapi.json](docs/openapi.json) (works offline, no server needed).
3. If endpoints/auth changed meaningfully, update [docs/INTEGRATION.md](docs/INTEGRATION.md) to match.
4. Commit `package.json` + `docs/openapi.json` (+ INTEGRATION.md) together with the code change.

Two generators exist:
- `npm run generate:openapi` — offline, builds the spec from code (preferred during dev).
- `npm run export:openapi` — pulls the spec from a running/remote server (needs `API_TOKEN`).

A **pre-commit hook** enforces this: [scripts/hooks/pre-commit](scripts/hooks/pre-commit)
regenerates the spec whenever `src/server.js` is staged and blocks the commit if
`docs/openapi.json` is stale. Enable it once per clone with
`git config core.hooksPath scripts/hooks`. Bypass deliberately with `git commit --no-verify`.

## ALWAYS: use Codebase Memory MCP first
The repository uses the current `codebase-memory-mcp` knowledge graph. At the
start of every session, call `list_projects` or `index_status`. Use
`search_graph`, `trace_path`, and `get_code_snippet` before broad grep/glob/file
reads, then call `check_index_coverage` for every evidence path. Fall back to
direct reads only for literals, configs, scripts, docs, generated files, and
reported coverage gaps. Run `detect_changes` after implementation and refresh
the persisted index after substantial changes. See [AGENTS.md](AGENTS.md) for
the complete workflow; it applies to every model working in this repository.

## Run notes
- Needs **Redis** (BullMQ) and **Chromium**. After a fresh `npm install`, run `npx playwright install chromium` before starting the server.
- Start: `npm start`. First run requires pairing Google Messages (scan QR / use `/session/screenshot`).
- `npm run check` — syntax-checks all source files.
