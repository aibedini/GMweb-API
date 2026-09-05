# Pairing Protocol v1 — GMweb 0.14.0 / Messages 2.7.0

This is a coordinated upgrade of the API, dashboard, PWA and Android app.
Old JSON-signed certificates and browser QRs without `protocol: GMweb-Pairing-v1`
are rejected. Existing process-memory sessions cannot be migrated; browsers
must pair once after upgrading. Subsequent linked sessions survive restarts.

## Phone enrollment

1. Sign into the dashboard and open PWA access → Primary phone setup.
2. Create a phone setup QR. `POST /admin/primary-setup` requires dashboard
   authority and the existing dashboard CSRF checks. Only the newest claim is
   valid. It expires after five minutes and is stored only as a SHA-256 hash.
3. In Messages → Linked devices → Enroll this phone as Primary, scan the
   setup QR and confirm. This flow is separate from Link new device.
4. Android signs the enrollment bytes with both its operational key and its
   trust root. `POST /api/v1/primary-enrollment` validates both proofs, the
   claim and API origin, then consumes the claim and assigns the primary role
   in one SQLite transaction.

Replacing the primary signs out existing browsers and discards pending
pairings/challenges. A changed trust root starts a new trust registry sequence.
Ordinary `/agent/identity` registration creates a legacy agent; it cannot
promote itself or overwrite an existing trust/signing key. A lost enrollment
response can be recovered by issuing a new setup QR.

## Browser pairing

The browser creates and persists non-extractable operational keys locally.
Its ordinary pairing QR contains public transcript fields only, never a phone
setup claim, API key, poll secret or private key. Android goes directly from
scan to signed metadata fetch, confirmation and biometric approval.

The server pins the approval to `agent_identities.trust_root_public_key` of
the authenticated primary. It checks account, device type/id, session id,
public keys, transcript hash, both origins, capability names, history grant,
trust sequence, issuance/expiry and the ECDSA root signature before approval.
The browser independently hashes its original transcript and verifies the
certificate and root signature. It then signs the session-bound challenge
and exchanges it for an HttpOnly, Secure, SameSite=Strict cookie.

Approval consumption, challenge consumption/session issuance, and trust
revocation/session invalidation are transactional. State lives in
`pairing_sessions`, `pairing_challenges`, `linked_sessions` and
`primary_setup_claims` in the existing `data/control-plane.db`.
Cookie sessions last at most seven days and never exceed certificate expiry.
Revocation also removes unredeemed approvals, preventing late completion.
HTTP access is denied on the next request after server receipt of revocation;
an open SSE is closed and the PWA returns to pairing within approximately one
second while connected. An offline phone cannot deliver revocation until it
reconnects.

## Exact signed bytes

`shared/pairingProtocol.mjs` is the one Node/TypeScript encoder. Android uses
`PairingProtocol.kt`. JSON is only the transport container, never the signed
serialization. Each signed record is UTF-8:

`GMweb-Pairing-v1:<kind>\n` followed by concatenated netstrings
`<decimal UTF-8 byte length>:<value>,`.

Strings are not normalized; unpaired UTF-16 surrogates are rejected. Numbers
must be nonnegative safe integers (maximum 9007199254740991), rendered in
decimal without leading zeros. Capabilities are sorted by UTF-16 code units;
duplicates are rejected. `rootSignature` is excluded from signed fields.
Public root keys use P-256 SPKI Base64. Root signatures are DER ECDSA/SHA-256;
browser proof signatures use WebCrypto P1363 and are accepted by the API.

| Kind | Field order |
| --- | --- |
| transcript | pairingSessionId, webDeviceId, webSigningPublicKey, webEncryptionPublicKey, ephemeralPublicKey, nonce, apiOrigin, webOrigin, expiresAt |
| certificate | accountId, deviceId, deviceType, signingPublicKey, encryptionPublicKey, capability count, each sorted capability, historyGrant, trustSequence, issuedAt, expiresAt, pairingTranscriptHash, pairingSessionId, apiOrigin, webOrigin |
| enrollment | claim, deviceId, publicKeys.signing, publicKeys.encryption, publicKeys.trustRoot, apiOrigin |
| challenge | pairingSessionId, deviceId, challenge, apiOrigin, webOrigin, issuedAt |

`shared/pairing-protocol-v1.json` contains fixed input fields, expected bytes
as Base64, SHA-256 digests, public verification key and signatures. Its exact
copy is `Messages/protocol/pairing-protocol-v1.json`. Kotlin JVM tests, Android
instrumentation tests and Node/TypeScript tests read those files. There are
no private keys in the fixtures. Android instrumentation tests exercise the
platform JSON implementation rather than the JVM substitute.

## Origins and transport

Production requires explicit `PUBLIC_API_ORIGIN` and `PUBLIC_WEB_ORIGIN`,
both HTTPS origins without a path or trailing slash. They can be equal.
Android compares the QR's API origin with its configured backend; the
browser compares the web origin with `window.location.origin`.
For a separate web domain, proxy `/api/v1/*` from that web domain to the API,
including cookies and SSE. The PWA intentionally uses same-origin requests;
this preserves its Strict cookie without third-party-cookie dependencies.

The companion reads Android event storage through `/api/v1/sync` and writes
Android commands through `/api/v1/commands`. Google Messages/Chrome remains
an optional legacy delivery transport. Pairing, trust and companion sessions
do not depend on a Google Messages Web session.

## Physical release gate

Automated tests do not certify physical QR scanning, Keystore or biometrics.
Follow [PAIRING-E2E.md](PAIRING-E2E.md). Deployment is blocked unless the
physical test report matches the exact server/PWA/dashboard files and APK.
