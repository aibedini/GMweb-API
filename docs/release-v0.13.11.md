# GMweb API v0.13.11

This release removes the QR-only dead end from `/web` and makes pairing failures observable.

## What changed

- Added a secure **GMweb admin token** alternative on the `/web` linking screen.
  The token is exchanged once for a restricted HttpOnly session and is never
  stored in local/session storage.
- Kept `GET /api/v1/pairing/session/:id` and
  `POST /api/v1/pairing/approve` signature-only. The new recovery session cannot
  authorize either trust-sensitive route.
- Added persistent, sanitized pairing stage/reason diagnostics to
  `data/activity.jsonl`, Dashboard → Logs, and the `/web` Debug tab.
- Added explicit state labels from browser key preparation through Android
  approval, certificate verification, cookie creation and completion.
- `/web` now displays the live API version, embedded PWA version, and exact
  `index-*.js` asset filename. API/PWA mismatches block pairing with a clear
  deployment warning.
- Dashboard Overview now reports the deployed `/web` artifact version, exact
  script filename, build time, and whether it matches the running API.
- Fixed React StrictMode creating duplicate pairing sessions and replaced the
  expired-QR dead screen with an explicit fresh-QR action.

## Secure recovery flow

1. On the GMweb server, run `gmweb token` (manager option 9).
2. Open `/web` and choose **Can't scan? Use GMweb admin token**.
3. Paste the active token and select **Open Messages securely**.
4. GMweb validates it with constant-time comparison and rate limiting, then
   issues a 7-day `HttpOnly; Secure; SameSite=Strict` restricted cookie.

The recovery cookie can read/sync messages, submit message commands, and read
sanitized pairing diagnostics. It cannot register an Android identity or
approve pairing.
