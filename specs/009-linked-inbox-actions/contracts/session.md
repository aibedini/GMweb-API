# Self unlink contract

DELETE /api/v1/linked-session; linked-cookie authentication; response 200 {ok:true}, no-store, expired cookie. No target device parameter. Missing/expired/replayed session denied. Master/project credentials alone cannot act as the linked identity. Other identities remain authorized. This is server-session unlink, not an Android-signed trust-registry revocation.

GET /api/v1/linked-device/command-key permits MARK_READ or SEND_MESSAGES; command creation continues to enforce the permission of the requested command type. Existing MARK_THREAD_READ opaque envelope protocol is unchanged. Operator logs correlate readerDeviceId, targetAgentId and commandId without plaintext or recipient.
