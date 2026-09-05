# Message encryption v1

Implementation candidate for ADR-002 Crypto Review; no claim of an external
security audit, forward secrecy, post-compromise security, or Signal protocol.

## Standard primitives and wire contract

CKE grants use RFC 9180 HPKE base mode: DHKEM(P-256, HKDF-SHA256),
HKDF-SHA256, AES-256-GCM (suite IDs 0x0010, 0x0001, 0x0002).
Android uses Tink 1.18.0; the browser uses the locked @hpke/core dependency.
The HPKE wire bytes are the 65-byte encapsulated point followed by the 48-byte
encrypted 32-byte CKE (includes a 16-byte authentication tag). HPKE AAD is empty;
the grant's context is bound in HPKE info, matching Tink HybridEncrypt.

All binding strings use UTF-8: a domain label, then each field's standard padded
Base64 encoding on its own line, joined with LF, with no trailing LF. JSON key
order is irrelevant. No signature relies on JSON serialization.

- Grant info domain `GMweb-CKE-v1`: epochId, conversationId, deviceId, category,
  historyFloor (decimal integer).
- Grant signature domain `GMweb-CKE-signature-v1`: the same five fields followed
  by wrappedCke. Android signs with its PrimaryTrustRoot (ES256 DER). Browsers
  verify against the root persisted only after pairing-certificate verification.
- Message AAD domain `GMweb-message-v1`: epochId, eventId, type, conversationId.
- DEK-wrap AAD domain `GMweb-DEK-v1`: the same four fields.

Each message revision has a random 32-byte DEK. Message payload and DEK wrap use
AES-256-GCM, independent random 12-byte nonces and 16-byte tags. A message
envelope contains v=1, kind=message, the four bound fields, iv, ciphertext,
wrapIv and wrappedDek. All byte fields are standard Base64. The event wire
wraps this JSON as Base64 with encoding=envelope.v1, schemaVersion=1,
cryptoVersion=1. KEY_GRANT envelopes use kind=key-grant with the grant fields,
wrappedCke and rootSignature; no message body or address is outer metadata.

## Durability and grants

Room migration 8→9 adds conversation_key_epochs and its unique lookup index.
Its wrappedKey is AES-GCM under an Android Keystore AES key, with epochId AAD.
Loss of that key fails closed. Wrapped message DEKs remain in immutable outbox
event envelopes; per-device epoch envelopes are durable KEY_GRANT outbox rows.

Epoch selection includes the conversation, signed trust generation, message-time
partition and sensitive category. Changing device membership/capabilities advances
the generation, so future messages use new CKEs. Historical messages never reuse
a post-enrollment epoch merely because they were uploaded after enrollment.
Full-history grants re-wrap CKEs without rewriting message ciphertext. Grant jobs
page epochs in batches of 25 per device/trust revision; the existing sync_cursors
table checkpoints each page in the same transaction as its outbox grants.

Only active or pending-publication, unexpired, locally authorized devices with
READ_MESSAGES and the relevant sensitive capability receive a grant. Revoking
or revoked devices receive none. LOCAL_ONLY remains an earlier hard gate: no
event is built even if a linked device has the relevant sensitive capability.

The PWA preserves opaque raw events and its cursor in IndexedDB. It stores CKEs
as non-extractable CryptoKeys and decrypts into memory for projection, never into
GMweb. Missing keys are locked; invalid signatures, bindings and AEAD tags are
invalid/corrupt. Legacy v0 remains explicitly labeled plaintext.

## Upgrade and limitations

Old browser keys were created with deriveKey alone. HPKE requires deriveBits;
those non-extractable keys cannot be silently upgraded. Use the explicit Reset
browser identity and pair again action; the phone must confirm the new identity.
Legacy v0 server data and content already decrypted/downloaded cannot be made
secret or remotely erased by this upgrade. From-now-on is a v1 key restriction.

shared/message-crypto-v1.json contains throwaway test private-key material and a
Tink-generated encrypted message/grant, verified by browser-side WebCrypto tests.
It contains no real identity or user data. The physical release matrix still
must verify actual Android Keystore, biometric, restart and revocation behavior.
