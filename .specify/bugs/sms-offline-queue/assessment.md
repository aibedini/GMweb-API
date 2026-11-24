# SMS waits for an offline phone

The report is valid. With Android active and phone readiness false, `POST /send` returned `503 android_gateway_unreachable` before the durable ledger and BullMQ queue were reached. EVE also treated device readiness as a precondition for enqueueing. A high retry count could show as “Need Attention” even after a request reached the gateway.

Keep device health separate from queue acceptance. Accept valid sends while Android is offline and delay the existing BullMQ job before submission without consuming a send attempt. Preserve revocation, authorization, deduplication, and the manual review path for a task already picked up by the phone. Verify offline admission, reconnect, queue identity, and the EVE operator status using synthetic sends.
