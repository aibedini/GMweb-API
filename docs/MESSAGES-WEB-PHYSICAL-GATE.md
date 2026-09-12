# Messages-for-Web physical release gate

Current status: **NOT RUN — PHYSICAL DEVICE REQUIRED** (`adb devices` returned no connected device on 2026-09-12).

Record sanitized evidence for: fresh FULL_HISTORY pairing; old incoming/outgoing decrypt; recent-first browsing during backfill; live incoming; phone-sent outgoing; Web-sent reconciliation; delivery/failure update; process death and phone reboot resume; API restart resume; browser refresh/offline cache; revoke while open/offline/reconnecting; tamper rejection; production plaintext canary; 360k completion without crash/OOM/ANR.

Also record phone model, Android version, network, history count/bytes, messages/sec, p95 batch latency, peak memory, battery delta, duration and retry count. Never include SMS plaintext.

## Required evidence checklist

- [ ] Phone model, Android version and network type.
- [ ] 360,000+ provider rows including sensitive messages and one 30k thread.
- [ ] FULL_HISTORY + sensitive pairing on browser A.
- [ ] FULL_HISTORY without sensitive capabilities on browser B.
- [ ] Old incoming/outgoing and explicitly authorized sensitive history visible.
- [ ] New incoming, Android outgoing and Web outgoing reconcile exactly once during backfill.
- [ ] Status, read and delete mutations do not duplicate or resurrect messages.
- [ ] Process kill and phone reboot resume from the contiguous ACK watermark.
- [ ] A dead letter blocks history completion and remains recoverable.
- [ ] GMweb restart and browser refresh preserve correctness.
- [ ] Active browser survives compaction; stale browser receives `snapshot_required` and recovers.
- [ ] Revoked browser loses sync, command and future key-grant access.
- [ ] Production SQLite/WAL, app/proxy logs, API payloads and browser storage contain zero canary representations.
- [ ] TLS-termination capture contains ciphertext/opaque metadata only.
- [ ] Throughput, p95/p99 latency, memory, ANR/OOM and battery delta recorded.
