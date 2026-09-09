# Full-history key v3 migration

For ordinary messages, v3 replaces historical per-conversation grants with one
Android-held History Master Key. Android wraps that key once for each
`FULL_HISTORY` browser and binds the grant to the signed pairing's device ID,
web origin, trust sequence, and browser encryption public key. GMweb only
relays ciphertext.

Each ordinary message has one encrypted payload and two DEK wraps:

- the history wrap is opened by the single History Master Key;
- the live wrap uses the rotating `READ_MESSAGES` account key for
  `FROM_NOW_ON` browsers.

Sensitive-message capability domains and contacts remain separate; the
history key cannot bypass those grants.

## Rollout

1. Stop GMweb and confirm Android outbox is empty.
2. Run `node scripts/migrate-history-v3.js` and review the dry-run counts.
3. With explicit operational approval, run
   `node scripts/migrate-history-v3.js --apply`.
4. Deploy the matching API/PWA and Android builds together.
5. Reset and pair the browser once, selecting `FULL_HISTORY`.
6. Keep the generated `control-plane.pre-history-v3.*.db` backup until PWA
   diagnostics show decrypted history and a healthy projection.

The apply step clears only encrypted `sync_events` and resets their sequence
counters. Trust statements, linked-device records, commands, sessions,
telemetry, and application settings are preserved. Android then replays its
phone source of truth with deterministic v3 event IDs.

## Rollback

Stop GMweb, restore the generated backup as `data/control-plane.db`, and
restore the matching pre-v3 Android and API/PWA builds together.
