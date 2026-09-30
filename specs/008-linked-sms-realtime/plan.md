# Plan: linked-sms-realtime-v1

Android includes its durable outbox insertion ID as `sourceOrder` in each event. GMweb changes the encrypted current-state winner to higher source order, with the previous sort/revision rules for old agents, and the PWA uses the same comparison. The opened thread supplies a temporary local reconciliation for its sidebar row. No plaintext enters server tables or SSE.

PWA sync commits the bounded visible page first, then starts a single key-maintenance task. Key HTTP requests time out independently; grant pages are limited to 100 and cursors advance after safe processing. SSE reconnect begins at 250 ms and always pulls durable state. SMS segmentation is a pure browser module.

Android reuses its existing explicit `subscriptionId` command path and SIM binding policy. It adds a privacy-safe active-SIM list to signed device telemetry. The linked telemetry endpoint already requires a linked session, so no new public endpoint is needed. Explicit selections fail closed when the requested SIM is absent or manager binding cannot be verified.

Release order: GMweb first (old Android sends default SIM), then signed Android build. Physical acceptance checks follow Android installation. Rollback restores prior code but cannot retract an SMS, so send guards must be tested before release.
