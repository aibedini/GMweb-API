# Assessment: linked web composer and contact layout

Date: 2026-09-29. Verdict: valid. Severity: medium.

The user screenshot shows tall, centered contact cards with no visible SMS action. Selecting a contact without a matching conversation puts the 58px composer inside the centered empty state. The inbox also lacks a Compose entry point. Source confirms these paths in `web/src/app/App.tsx` and `.security-row` / `.empty-conversation` in `web/src/index.css`.

The browser also requests dashboard-only `/api/v1/push/subscriptions` on every linked startup; its 403 is correct authorization behavior but unnecessary PWA traffic. The key banner equates every `KEY_SYNC` failure with an unpublished phone grant, while the same screenshot shows decrypted messages. `boundedKeyWork` allowed only two seconds for network, crypto, and local projection work.

Fix the contact rows and composer placement, add a recipient picker, remove the unauthorized dashboard request, and report the actual key error. Keep send capability enforcement and encrypted command submission intact. Verify build, scoped route tests, and production behavior separately.
