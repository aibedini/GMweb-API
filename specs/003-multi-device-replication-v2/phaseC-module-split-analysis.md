# Phase C module-separation analysis

Feature ID: `multi-device-replication-v2`. Source-plan sections 121–122 explicitly
require the giant `web/src/lib/sync.ts` to be split by responsibility while
retaining the existing store/cursor logic. FR-003 and FR-006 require atomic
ciphertext/event-cursor progress independent of key and projection failures.

The existing feature spec and Phase C plan are coherent with that refactor, but
the original task ledger omitted the structural deliverable. T031–T035 restore
it. The work proceeds by extracting existing logic, not rewriting IndexedDB or
changing the `sync.ts` public API. T031 moves only runtime state and safe error
classification; its regression scope is sync, key outage, snapshot, projection,
diagnostics, the complete test suite and production frontend build. The 2026-09-25
T031 slice passed targeted Web tests, `npm run check`, `npm test`, the full frontend
build and `npm run verify:artifacts`. The first build exposed a leftover error
sanitizer reference; it was fixed before the successful rerun. Later tasks
must keep per-browser cursors and snapshot-commit ordering unchanged.

The `specify` and DSH CLIs are unavailable in this environment, so the repository
Spec Kit artifacts were updated and checked manually. This is not a claim that
the CLI integration health check or Phase C convergence has passed; T032–T035
remain open until implemented and verified.
