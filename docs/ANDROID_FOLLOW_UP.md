# Android follow-up: MMS and transport consolidation

This document records work outside `android-carrier-dlr-v5`. No MMS or
control-plane SMS capability is activated by the DLR change.

## MMS protocol

- Define a separate message kind and media manifest with bounded MIME types,
  byte sizes, hashes, expiry and ownership. Do not place media or full recipient
  data in the SMS event outbox.
- Assign one stable logical request ID and separate per-part transfer IDs.
  Retries must reuse IDs; conflicting bytes under the same ID must fail.
- Persist the intent, transfer state and acknowledgements before telling a
  client that an MMS was accepted. Model `accepted`, `device_submitted` and
  `carrier_delivered` as distinct evidence levels, with `unavailable` when the
  carrier has no receipt.
- Specify encryption, media storage retention, deletion and replay checks in
  the cross-repository contract before implementation. Test process death,
  partial attachment transfers and duplicate modem submission with an Android
  test device; do not use customer MMS as test material.

## LEGACY_PULL and CONTROL_PLANE_COMMANDS

The existing `/gateway/pull`, `/gateway/validate`, `/gateway/ack` and new
`/gateway/delivery-report` routes are the active Android SMS path. Command
plane lifecycle states do not assert modem or carrier outcomes. A future
consolidation should name one owner for the durable send/revocation ledger,
preserve stable request and event IDs, and specify a mixed-version rollout
that prevents both paths from submitting the same logical notification.
Keep the old pull path operational until the Android app and GMweb have passed
a physical-device release gate with revocation, restart, ACK-loss and DLR
ordering evidence. No switch is enabled by this document.
