# SMS offline queue fix

GMweb reports `status.queueAccepting` separately from device readiness. Android availability is checked by the send worker. An unavailable phone delays the existing BullMQ job by 30 seconds, preserving its job ID, priority and ledger request ID. The worker only withdraws a timed-out bridge entry when no phone has pulled it. The ledger records `waiting_device` only while the message is still queued or active and can still be delivered.

EVE accepts the new readiness flag and leaves accepted gateway requests in the waiting-device category. Its legacy-gateway fallback defers explicit offline refusals without spending a delivery attempt.
