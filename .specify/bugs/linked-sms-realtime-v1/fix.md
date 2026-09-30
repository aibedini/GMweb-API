# Fix report: linked-sms-realtime-v1

GMweb now records Android's durable outbox insertion order (`sourceOrder`) in
event and encrypted current-state rows. Newer device state wins independent of
upload priority or server arrival order. This permits a deletion to move a
conversation preview backward to its newest surviving message. Linked SSE
frames contain only bounded opaque conversation IDs; browser pulls target only
those current-state envelopes, and reconnect uses the durable bootstrap.
The selected thread reconciles its decrypted latest message with the sidebar.

Browser key maintenance runs separately from visible conversation refresh.
Key requests use a per-request timeout and grant cursors advance after bounded
pages. The composer counts GSM default/extension and UTF-16 Unicode segments.
Android publishes bounded active SIM metadata in signed telemetry and rejects
an unavailable explicit SIM selection before modem submission.

Mixed-version behavior: old Android events without `sourceOrder` retain the
legacy sort/revision comparison until a new ordered event for that row arrives.
New PWA with old Android telemetry preserves the historical default-SIM command
only when the browser has no saved explicit SIM choice.
