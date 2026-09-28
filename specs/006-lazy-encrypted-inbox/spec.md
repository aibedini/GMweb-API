# Feature Specification: Lazy Encrypted Inbox

**Feature ID:** lazy-encrypted-inbox-v1
**Status:** Ready for implementation
**Date:** 2026-09-29

## User scenarios

1. A newly linked browser shows the newest 100 conversation summaries without downloading all message history.
2. Opening one conversation requests only its newest 10 encrypted message states and decrypts them locally.
3. Moving upward requests older messages for that conversation in bounded pages. The list of conversations also pages when requested.
4. New phone activity refreshes visible conversation summaries and the selected thread, including after a missed SSE notification or page reload.
5. A browser without the primary trust root still sees locked ciphertext and never receives plaintext from GMweb.

## Functional requirements

- **FR-1**: Initial web bootstrap transfers at most 100 conversation states and no message states. Contacts remain available through a separate on-demand bootstrap.
- **FR-2**: The first thread request transfers at most 10 message states. Older pages are keyset paginated, limited to 20 states per request.
- **FR-3**: Server-current pages supersede cached pages while online; cached ciphertext is an offline fallback.
- **FR-4**: The browser records the server high watermark as an observation, not as an ACK of unseen message bodies. SSE and periodic polling repair missed invalidations.
- **FR-5**: An initial base query captures a high watermark before returning rows. Subsequent refreshes use current-state queries and revision-aware cache writes so concurrent updates are neither lost nor overwritten by older responses.
- **FR-6**: Browser key bootstrap and trust validation remain required before local decryption. GMweb never returns plaintext or new key material beyond existing device-targeted grants.
- **FR-7**: Existing full snapshot and delta APIs remain available for old clients. The new lazy bootstrap is opt-in on the additive API field.
- **FR-8**: Diagnostics distinguish lazy current-state observation from full historical replication and do not claim historical messages were downloaded.

## Acceptance criteria

- A cold browser first paint requests zero `/web/snapshot-v2` pages and zero `/web/conversations/:id/messages` pages until a thread is opened.
- Opening a thread requests 10 states; one older-page action requests no more than 20.
- Browser storage after cold bootstrap contains no historical message states and no plaintext message content.
- Updating or deleting a message during pagination does not resurrect stale ciphertext in the local cache.
- A missed SSE is recovered by bounded polling without full archive replay.
- Auth, revocation, key grants and contact decryption retain existing security behavior.

## Out of scope

- Full offline archive download and full-text search across unloaded encrypted history.
- Changes to Android phone ingestion or EVE SMS delivery.

## Open questions resolved

- First list size: 100 conversations as requested.
- First thread size: 10 messages; older page size: 20 messages.
- Contacts: fetched on the Contacts tab, because the encrypted conversation projection already contains its own title/preview.
