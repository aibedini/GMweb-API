# Linked browser presence

Feature ID: `linked-browser-presence-v1`. Date: 2026-09-29.

## User needs

- A linked browser can see how many linked browser sessions were observed recently.
- Opening the eye control shows each session's IP, browser identity, last request, last content request, and last durable sync acknowledgement.
- Presence does not claim a human saw a message; durable sync does not imply decryption.
- Session tokens, message bodies, and phone numbers never appear in this endpoint.
- An anonymous or capability-limited caller cannot read other browsers' presence.

## Contract

`GET /api/v1/linked-device/sessions` requires a linked cookie with `READ_MESSAGES`. Response `sessions[]` contains `deviceId`, `ip`, `userAgent`, `lastSeenAt`, `lastDataAt`, `lastSyncAt`, `onlineNow`. `onlineNow` means a request occurred within 90 seconds. An absent sync acknowledgement is `null`.
