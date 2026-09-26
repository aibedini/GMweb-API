# Large snapshot observability — bug assessment

Status: diagnostic/UX correction implemented locally; production acceptance NOT VERIFIED.

The user-supplied browser diagnostic reports server high watermark 1,127,867, browser cursor 0, snapshot incomplete, 330,340 raw `MESSAGE_CREATED`, 6,638 raw message aggregates and zero conversation rows. This establishes that substantial encrypted data exists on that browser, but does not establish whether the snapshot continuation is advancing or stalled. `projectionLag = cursor - projectionCursor` reported zero while both cursors were zero, masking incomplete snapshot projection.

Root cause of misleading telemetry: `snapshot-sync.ts` intentionally defers cursor promotion until the final page and clears projection stores on the first page; `diagnostics.ts` previously knew only `snapshotComplete` and `snapshotBaseline`. The 100-row page cap and first-paint semantics remain separate performance/availability issues. Contact and key-grant numbers in the supplied diagnostic contradict the earlier claim that no contact events reached GMweb; neither contact UI failure nor key-import failure can be assigned a root cause from these aggregate numbers alone.

The local correction records snapshot position, committed page count, start time and last committed page timing in IndexedDB alongside each page transaction, displays progress in the Browser Sync card, and reports the aggregate/conversation deficit as projection backlog while snapshot is incomplete. The event cursor invariant is unchanged. Existing snapshots will show zero/unknown telemetry until another page commits. This instrumentation cannot by itself repair a stalled continuation loop or bring the inbox to a usable state.

`specify`/`dsh` CLI was unavailable in this environment. This manual record does not replace a converged Spec Kit fix/test report. Production-like browser reload, 72k/360k fixtures and deployment verification remain NOT RUN.
