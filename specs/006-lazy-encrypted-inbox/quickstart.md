# Quickstart

1. Link a browser with the Android QR flow and open the PWA.
2. Confirm network activity shows one bounded bootstrap and no snapshot or thread page until a thread is selected.
3. Open a thread; confirm `limit=10`, scroll upward; confirm `limit=20`.
4. Open Contacts; confirm contacts bootstrap is requested then locally decrypted.
5. Add a phone message, disconnect/reconnect SSE, and confirm bounded refresh catches up.
6. Check diagnostics label lazy mode and distinguish observed high watermark from a full replica ACK.
