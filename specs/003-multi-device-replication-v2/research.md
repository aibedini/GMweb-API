# Research decisions

## Existing state

Graphify source graph and direct source inspection identify `EventStore` (`src/eventStore.js`), HTTP routes (`src/controlPlaneRoutes.js`), browser sync (`web/src/lib/sync.ts`), command engine (`src/commandEngine.js`) and pairing/trust as the existing implementation. The baseline Node suite passed 395 tests before the first fix. Graphify semantic extraction over documentation was unavailable because no configured LLM backend existed; the source graph was queried and exact files checked.

## Snapshot consistency

**Decision**: A V2 snapshot must pin a baseline and immutable, bounded session state, with keyset pagination and an expiry. A page from mutable materialized state cannot be treated as the same snapshot after a concurrent update changes sort position or replaces a row.

**Alternative considered**: Continue reading the live `encrypted_conversation_state` table with a cursor. This can skip or duplicate a row when new events reorder it, so it is insufficient for a completeness guarantee.

## Progress and migration

**Decision**: Keep V1 endpoints while adding V2. Store snapshot token/cursor/completion separately from the event cursor in IndexedDB. Preserve browser identity across snapshot restart. Use additive local and server schema changes.

**Alternative considered**: Reset local storage on mismatch. This would erase identity and force re-pairing.

## Event sequencing

**Decision**: Retain the current per-account transaction-safe counter and unique event ID. Extend the ingest response to explicit per-item outcomes only when Android contract fixtures are ready. An accepted duplicate returns the original sequence.

## Crypto and projection

**Decision**: Commit validated ciphertext and event cursor together. Run key import and projection after that commit, with independent progress and phase-specific diagnostics. Never introduce plaintext server fallback.

## Commands

**Decision**: Retain durable `CommandEngine` and extend worker claim with a bounded lease and recovery semantics, preserving the existing V1 command interface during transition. Avoid claiming exactly-once physical SMS submission without Android-side dedupe evidence.

## Acceptance evidence

Synthetic 360k tests establish performance and correctness only for the test environment. Physical Android modem submission, proxy behavior, and production rollout are separate evidence gates.
