# Physical pairing release gate

Status for this change: **NOT RUN on a physical phone**. No physical-device
success report is included. A connected phone, biometric interaction and an
isolated HTTPS test deployment are required.

Run automated checks first:

```text
npm run check
npm test
npm --prefix web run build
npm --prefix dashboard-next run build
npm run generate:openapi
Messages/gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
Messages/gradlew :app:connectedDebugAndroidTest
```

Use a test phone/profile whose app data may be removed; preserve real SMS
and the user's normal installation. Install the exact APK being tested on
that fresh profile. Record its SHA-256. Do not substitute an emulator result
for the physical gate. Compare the Android and server protocol fixture files
byte-for-byte before testing.

Use a clean browser profile with no prior service worker, cookies or keys.
The HTTPS test deployment must use the exact release files. Disable or leave
Google Messages Web unpaired throughout the matrix.

| Evidence step | Required observation |
| --- | --- |
| fresh_apk | Fresh application profile, exact APK hash, phone model and Android version |
| primary_enrollment | Dashboard setup QR scanned using Enroll this phone as Primary; server reports primary role |
| clean_browser | Browser version and fresh profile with no prior PWA state |
| qr_scan | Ordinary `/web` QR scanned using Link new device, without any key copying |
| android_metadata | Signed metadata succeeds; displayed web origin matches |
| biometric_approval | Real biometric confirmation succeeds on the phone |
| web_certificate_verification | Browser reaches CERTIFICATE_VERIFIED |
| challenge_signature | Browser proof succeeds for that session and its local key |
| linked_cookie | Secure/HttpOnly cookie exists; `/api/v1/linked-session` authenticates |
| sync | `/api/v1/sync` succeeds against Android event storage while Chrome is unpaired |
| encrypted_history | Real historical messages arrive as v1 ciphertext and decrypt into readable thread bubbles |
| full_history_grant | Newly approved Full history browser decrypts earlier epochs using only new KEY_GRANT records |
| from_now_on_denied | A separate clean From now on browser cannot decrypt pre-approval v1 history, including later backfilled rows |
| browser_reload | Refresh remains linked and opens Inbox |
| server_restart | Restart only the API process while preserving control-plane SQLite |
| still_linked | Same browser cookie authenticates and sync succeeds after restart |
| phone_revoke | Unlink on the phone; signed revocation reaches the API |
| browser_unauthorized | Existing browser returns to pairing; old cookie cannot sync, and open SSE closes |
| revoked_no_new_epochs | Subsequent messages rotate epochs; no grant targets the revoked device |
| ciphertext_only_server | Database and API contain only encrypted body/address bytes for v1 events |

Also exercise a reinstalled phone replacing a previous primary, replayed/
expired setup QRs, expired ordinary QRs, and separate API/web origins through
the web domain's API proxy. Record failures as failures; never mark a step
passed based only on unit tests or a simulated client.

Run `node scripts/check-pairing-release.js --fingerprint` after builds are
final. Create an external JSON report containing `kind` set to
`physical-phone-pairing-e2e`, `physicalDevice: true`, `tester`, `deviceModel`,
`androidVersion`, `browserVersion`, `serverSha256`, `apkSha256`,
`fixtureSha256`, and `steps`. Each step key from the table must have
`passed: true`, an ISO timestamp `at`, and `evidence` identifying the sanitized
log, screenshot or observation. Timestamps must follow the table order.
Never record QR claims, poll secrets, cookie values, private keys or SMS text.

Validate with:

```text
node scripts/check-pairing-release.js <report.json> <tested.apk>
```

The supported deploy script verifies the incoming revision in an isolated
staging directory before replacing any live API/PWA files, then tests and
promotes exactly that revision. Put
the reviewed evidence and exact tested APK at
`/opt/gmweb-release-evidence/pairing-e2e.json` and
`/opt/gmweb-release-evidence/messages.apk` on the deployment host. Rebuilds
change the fingerprint and require new evidence. Retain the report outside
the release source tree. A successful automated build alone is not release
approval.
