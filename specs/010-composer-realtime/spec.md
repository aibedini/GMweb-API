# Composer and correlated live sends

Feature ID: composer-realtime-v1. Scope: GMweb-API only.

Both conversation composers and SendPage preserve exact whitespace/newlines, support plain Enter, modified Enter, IME-safe shortcuts, capped auto-growth and mixed direction text. Segment counts use GSM-7 extension septets and UTF-16 units without splitting surrogate pairs. Android telemetry supplies SIM labels and selection; an unknown capability must remain unknown. Explicit SIM choice and clientMessageId survive HTTP validation, durable storage, queue recovery and gateway serialization. Live states require Android/carrier evidence; command completion alone is not SMS delivery. Existing encrypted cursor/SSE read synchronization and reader-device audit remain authoritative.

No customer SMS is test material. Real-device acceptance is separate from synthetic tests. The legacy Chrome DOM archive cannot infer Android message IDs or mark a phone thread read without the linked browser's encrypted command authority.

Acceptance: exact multiline payload; extension/UCS-2 boundaries; both modifier shortcuts and IME; two telemetry SIMs; explicit unavailable SIM failure; replay with same identity; changed SIM idempotency conflict; restart recovery; HTTP pull/push field preservation; reconnect catch-up; no duplicate optimistic row in encrypted inbox; delivery is shown only with carrier evidence.
