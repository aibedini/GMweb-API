# Data model and state transitions

## Event

Per-account `sequence` and unique `eventId` identify an opaque event. The server allocates sequence in the same transaction as the insert. Replays resolve to the stored sequence. Invalid entries produce a per-item rejection without inserting or consuming a sequence. Existing V1 rows remain readable.

## Snapshot session

`token`, `accountId`, `replicaGeneration`, `baselineSequence`, `createdAt`, `expiresAt`, and immutable page rows. Each page position is a keyset cursor containing stable sort key and unique ID. The session transitions `ACTIVE → COMPLETE` or `ACTIVE → EXPIRED`. Expired sessions require a new snapshot, preserving browser identity.

## Browser progress

`snapshotToken`, `snapshotCursor`, `snapshotBaselineSequence`, `snapshotComplete`, `eventCursor`, `keyCursor`, and `projectionCursor` are separate metadata. The event cursor means last server sequence durably committed locally. A transaction writing an event page also writes its next event cursor. A snapshot page writes its own progress; event catch-up starts at the baseline after the complete snapshot is committed.

## Locked event

An event with ciphertext but without usable decryption carries one of `LOCKED_KEY_MISSING`, `LOCKED_UNSUPPORTED_CRYPTO_VERSION`, or `LOCKED_DECRYPT_FAILED`. A new valid grant causes a targeted retry for its key reference. No locked state rewinds event progress.

## Command

`commandId`, `accountId`, `idempotencyKey`, `clientMessageId`, opaque payload, state, target agent, lease owner and expiry, and final result. State moves from queued to leased, then accepted/executing and a truthful terminal state. An expired lease may be reclaimed with the same command identity; Android must dedupe modem submission by that identity.

## Device authorization

The existing signed trust registry controls active/revoked browser status. A revoked device loses new event, key, and command access. Another device has independent authorization and cursors.
