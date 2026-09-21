# Data Model: Android Gateway Observability

## GatewayBridgeTelemetry

Singleton process-local aggregate:

- pull timestamps: started, successful, empty, task
- validation timestamp/result/token
- ACK timestamp/outcome/duplicate/newly-recorded/token
- last pull HTTP status, last failure kind/time, consecutive failures
- active long-poll count
- recent gateway auth-failure timestamps

All timestamps are ISO strings. Request tokens are irreversible eight-hex SHA-256 prefixes.

## GatewayDevicePresence

Bounded records keyed by sanitized explicit `X-Gateway-Device-Id`:

- deviceId (printable, maximum 128 characters)
- firstSeenAt
- lastPullStartedAt
- lastSuccessfulPullAt
- lastAckAt
- activePolls
- lastFailure

Records expire after 24 hours by default. Missing IDs are represented only as the compatibility label `legacy-shared-device` in logs/aggregate activity and are never counted as distinct known devices.

## TransportHealthProjection

Existing health snapshot gains:

- activePolls
- distinctDevices (`null` until an explicit ID has been observed)
- lastSuccessfulPullAt, lastEmptyPullAt, lastTaskPulledAt
- lastValidateAt/result, lastAckAt/outcome
- authFailuresRecent
- stable operational warning/reason

No field is an authorization input or durable delivery fact.
