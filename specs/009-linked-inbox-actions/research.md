# Research — linked-inbox-actions-v1

Bounded source evidence: App.tsx only called refreshContacts on the Contacts tab; contactNames did not overlay conversationPage. command-key rejected MARK_READ-only sessions; global linked-session introspection exemption applied to every verb. Read deduplication was permanent per aggregate and completion was ignored.

Existing Android b960be1 / 3.4.18 publishes subscription IDs through DeviceTelemetry and consumes MARK_THREAD_READ through SecureCommandPoller, SmsRepository.markThreadAsRead and TelephonySyncCoordinator.markThreadReadAndPublish. SEND_SMS requires controlPlaneSendsEnabled; legacy pull is the execution owner when disabled. No Android patch is justified by the screenshot alone.

Live Chrome evidence on 2026-09-30: GMweb/PWA 0.19.29 loaded index-BWE9VAtl.js; Connection shows phone 3.4.17 with a stale 10:10 report; current local Android source is 3.4.18. PWA Debug reports 4982 reconstructed contacts. Direct JSON telemetry navigation was blocked by Chrome; no network bypass attempted. No customer SMS sent and no production unlink executed. Read-side checks do not establish modem/carrier acceptance.
