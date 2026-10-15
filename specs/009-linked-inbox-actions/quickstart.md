# Acceptance steps

Use a dedicated synthetic account and test phone. Start API/Redis and build PWA. Pair with READ_MESSAGES, CONTACTS_READ, MARK_READ and SEND_MESSAGES. Verify inbox names before visiting Contacts. Select a ready unread synthetic thread: web badge clears after durable request acceptance, phone confirmation remains pending then Android emits THREAD_READ and provider/shadow unread clears. Query operator activity and command record to identify the reader and executor. Inject a newer arrival during the old read and verify it remains unread until its own read.

Switch rapidly between threads and hide the browser: no just-selected unloaded or hidden thread should be marked read. Force disconnected/failed/expired commands: status remains honest and Retry read stays available. On a separate linked browser, self unlink; replay old cookies and ensure denial while a different browser still works. On two-SIM test phone verify refreshed subscription labels, selection, encrypted payload and actual modem evidence. Never use customer SMS.

Production acceptance requires deploying API/PWA 0.19.30 together and current Messages >=3.4.18. Verify actual enrolled phone role, Phone permission, fresh telemetry, and controlPlaneSendsEnabled before any synthetic send. No auto-enabling of a second execution owner.
