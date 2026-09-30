# Bug assessment: linked-sms-realtime-v1

Source: user screenshots and attached 2026-09-30 report. Severity: high; stale previews and wrong-SIM risk affect message truth and user intent.

Reproduction: sidebar can show an older preview while an opened thread shows a newer decrypted message. `TelephonySyncCoordinator.stableRevision` hashes an event description to a non-monotonic positive long, while `EventStore.upsertConversationStateStmt` and browser cache previously accepted only numerically increasing revisions. `boundedKeyWork` applied one two-second deadline to key fetch, decryption, projection, and contact repair. The composer counted JS string length, and the browser did not expose the Android SIM choice. SSE retried after five seconds and handled each frame as a separate sync request.

Preferred remediation: order conversation heads by message timestamp and server sequence, reconcile the selected thread locally, decouple key maintenance, calculate SMS units using 3GPP alphabets, expose signed privacy-safe SIM telemetry, and refuse unverifiable explicit SIM sends. Acceptance requires regression and physical evidence; unit tests alone do not prove a phone-to-browser latency target.
