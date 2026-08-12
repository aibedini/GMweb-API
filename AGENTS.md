# Project agent instructions

## Codebase Memory is mandatory

This repository uses the current `codebase-memory-mcp` knowledge graph as the
primary code-discovery and reasoning layer. Every coding agent and model must
use it before broad file reads, grep, globbing, or repository-wide searches.

At the start of a session (and after context compaction):

1. Call `list_projects` or `index_status` and select the project whose root is
   this repository.
2. Use Verify (Tier 2) by default: `search_graph` for symbols, `trace_path` for
   callers/callees/data flow, and `get_code_snippet` for exact source.
3. After candidate files are known, call `check_index_coverage` with every file
   used as evidence. Read or grep only reported missed ranges and deliberately
   excluded/non-code files.
4. Use `detect_changes` after implementation to inspect blast radius.
5. Keep `auto_index=true` and `auto_watch=true`. After substantial external or
   generated changes, force a fresh `index_repository` run with persistence so
   `.codebase-memory/graph.db.zst` stays shareable and current.

Fallback text search is allowed only for literals, configuration, scripts,
documentation, generated files, or graph coverage gaps. Do not make negative
or exhaustive claims from a quick graph lookup; paginate all relevant results.

## API contract

Whenever an API route, request/response schema, or authentication behavior in
`src/server.js` changes:

1. Bump `version` in `package.json`.
2. Run `npm run generate:openapi`.
3. Update `docs/INTEGRATION.md` when consumer behavior changes.
4. Keep the code, package version, and `docs/openapi.json` in the same change.

Run `npm run check` and `npm test` before handing off code changes.
