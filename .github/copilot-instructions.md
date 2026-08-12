# Repository instructions for coding agents

Use `codebase-memory-mcp` as the primary code-discovery tool for every coding
task in this repository. Start with `list_projects`/`index_status`, then prefer
`search_graph`, `trace_path`, and `get_code_snippet` over broad grep or file
reads. Call `check_index_coverage` for every evidence file and inspect reported
missed ranges directly. Use text search only for literals, config, docs, scripts,
generated files, or an explicit graph coverage gap. Run `detect_changes` after
implementation and keep the persisted graph current after substantial changes.

For any API contract change in `src/server.js`, bump `package.json`, regenerate
`docs/openapi.json` with `npm run generate:openapi`, and update integration docs
when consumer behavior changes. Run `npm run check` and `npm test` before handoff.
