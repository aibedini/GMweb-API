# GMweb API v0.13.12

This release replaces master-token PWA recovery with dedicated one-time access
tokens and turns `/web` from a protocol-debug view into a usable Messages inbox.

## PWA access security

- Added Dashboard → **PWA Access** to create, list, and revoke browser tokens.
- Tokens use 256 bits of randomness, expire after a configurable short window,
  and can be consumed only once.
- GMweb stores only a SHA-256 hash; the usable `pwa_...` value is shown once.
- A successful exchange creates a read-only, capability-scoped, 7-day
  `HttpOnly; Secure; SameSite=Strict` session.
- Revoking a consumed token immediately revokes the browser session it created.
- `/api/v1/pwa/token-login` no longer accepts the master API token or project
  API keys.

## Messages PWA

- Rebuilt the signed-in experience with the bundled HeroUI v3 design system.
- Added a responsive conversation list, search, readable message bubbles,
  connection health, build version, security state, and isolated debug view.
- Removed UUID/event-type/ciphertext noise from the main Inbox.
- Decodes the existing Android `cryptoVersion=0` envelope locally, so readable
  message events no longer show “decryption in Phase 7”.
- Labels version-zero payloads **Legacy v0** instead of falsely claiming E2EE.
- Keeps unknown `cryptoVersion>=1` payloads fail-closed.

## Compatibility

Messages v2.6.40 adds the normalized address inside the payload envelope so new
conversation rows can show a useful sender/number instead of an opaque ID.

**Full Changelog**: https://github.com/aibedini/GMweb-API/compare/v0.13.11...v0.13.12
