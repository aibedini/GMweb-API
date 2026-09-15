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

<!-- BEGIN MANAGED: SPEC_KIT_REPOSITORY_POLICY -->

## Spec-Driven Development (Spec Kit) is mandatory

This repository is initialized with GitHub Spec Kit **1.0.6** through the `dsh`
integration. The binding engineering constitution is
`.specify/memory/constitution.md` (**v1.1.0**, 23 principles); it encodes the
durable-delivery-ledger, stable-identity, physical-truth, idempotency,
revocation, honest-outcome, release-atomicity and evidence invariants that
previous production incidents violated. Where convenience and the constitution
disagree, the constitution wins.

For any **non-trivial change** — a bug that is not cosmetic, or any feature,
refactor, schema, protocol, security, persistence, send-lifecycle or release
change — the Spec Kit workflow is **mandatory**, not advisory. Skipping it
requires a stated reason in the change description.

- Skills live in `.dsh/skills/speckit-*/` and are invoked in DSH as
  `/speckit-specify`, `/speckit-plan`, `/speckit-bug-assess`, and so on.
- Health: `specify integration status --json` (expect `"status": "ok"`).
- Artifacts: features in `specs/<NNN-slug>/`, bug reports in
  `.specify/bugs/<slug>/`, idea assessments in `.specify/assessments/<slug>/`.
- `specs/001-final-hardening/` is **valid existing Spec Kit history**. It is a
  canonical input to new work and MUST NOT be regenerated merely to match a newer
  template.
- After an approved Spec Kit upgrade: `specify integration upgrade dsh` and
  review the generated diff before continuing application work.

### Change classification

| Request | Workflow |
| --- | --- |
| Typo, comment, label, colour, version bump | No Spec Kit ceremony. Every rule below still applies. |
| Non-trivial bug | `/speckit-bug-assess` then `/speckit-bug-fix` then `/speckit-bug-test` |
| Feature, refactor, schema, protocol, security, persistence, or send-lifecycle change | `/speckit-specify` then `/speckit-clarify` (when ambiguous) then `/speckit-plan` then `/speckit-tasks` then `/speckit-analyze` then `/speckit-implement` then `/speckit-converge` |
| Uncertain architecture idea | `/speckit-assess-intake` then `/speckit-assess-research` then `/speckit-assess-define` then `/speckit-assess-shape` then `/speckit-assess-decide` |

**Bugs go assess → fix → test.** Reproduce or establish the root cause before
patching; never jump from a symptom to a patch. The fix step records what changed
and the test step produces a **verification report** — a green unit test is not
proof that the original production symptom is gone.

**Features go specify → clarify → plan → tasks → analyze → implement → converge.**
Do not begin `/speckit-implement` before `/speckit-analyze` reports the
artifacts are coherent enough to proceed. Repeat implement/converge until the
result is CONVERGED.

### Definition of done

**A task MUST NOT be declared complete merely because unit tests pass.**

Completion requires the smallest appropriate combination of: unit tests,
integration tests, contract tests, concurrency/race tests, migration tests,
restart/process-death tests, security negative tests, performance/query-plan
evidence, deployment validation, and production or production-like acceptance
evidence.

Any claim of "exactly once", "never duplicated", "cannot happen", "atomic",
"durable", "race safe", "secure", "zero downtime" or "backward compatible" MUST
name the explicit mechanism **and** the test or evidence that demonstrates it.

Anything not verified MUST be reported as NOT VERIFIED or NOT RUN. Never present
synthetic results as real-device or production evidence, and never use a real
customer SMS as test material.

### Cross-repository work

GMweb decides whether a logical notification is currently deliverable and owns
the durable delivery/revocation state plus the gateway contract. EVE decides
*why* a notification should exist; Messages Android performs the irreversible
modem submission. A change touching more than one of those repositories must
carry one shared feature ID (for example `stale-sms-revocation-v4`) through its
spec, plan, ADR references and acceptance report, and must follow the
Cross-Repository Contract section of the constitution.

Two cross-repository fixtures are byte-compared in CI and must never drift
independently:

- `shared/pairing-protocol-v1.json` is byte-identical to
  `Messages/protocol/pairing-protocol-v1.json`.
- The EVE send contract is verified by `node scripts/check-eve-contract.js <eve-checkout>`.

### Evidence commands

- Syntax check: `npm run check` (syntax only — never behavioural evidence)
- Unit and contract tests: `npm test`
- OpenAPI contract stays in sync with `src/server.js`:
  `npm run generate:openapi` (CI fails when `docs/openapi.json` differs)
- Frontend artifact release integrity: `npm run verify:artifacts`
- Operational health: `npm run doctor`, `npm run smoke`

Send-lifecycle, revocation, queue, ACK and protocol work additionally requires the
contract, duplicate-delivery, restart, race and ordering evidence described in
the constitution. Green CI alone is not acceptance.

<!-- END MANAGED: SPEC_KIT_REPOSITORY_POLICY -->
