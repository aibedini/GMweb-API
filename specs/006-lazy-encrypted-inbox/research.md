# Research

- Production evidence on 2026-09-28: 373,642 snapshot rows made a full browser bootstrap exceed an hour.
- `EventStore.bootstrap()` already captures `highWatermark` and the first conversation page in a SQLite transaction.
- `EventStore.conversations()` and `.messages()` use keyset pagination on indexed current-state tables.
- Browser currently invokes `syncStep()` then `syncUntilCaughtUp()` at startup, which fetches the full snapshot before serving on-demand pages.
- Current contacts bootstrap returns 85 encrypted events (about 1.8 MB), so it should be deferred until Contacts is opened.
