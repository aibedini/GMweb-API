# Messages-for-Web v3 replication migration

## Dry run

1. Back up the GMweb SQLite file and restrict the backup as potentially legacy-sensitive.
2. Run `node scripts/migrate-history-v3.js --dry-run` and record legacy `cryptoVersion=0`, v2/v3 and message counts.
3. Confirm Android is the complete source of truth and install the matching Android build.
4. Confirm a FULL_HISTORY browser has been approved for the exact production origin.

## Apply

1. Stop GMweb and Android upload workers.
2. Apply the existing v3 history migration; never transform server plaintext into the new source of truth.
3. Deploy GMweb first. `EventStore` creates encrypted current-state tables and adds nullable/metadata delta columns without rebuilding `sync_events`.
4. Deploy Android. Room migration 9→10 adds only opaque replication metadata and priority columns.
5. Start GMweb, then Android. Android publishes encrypted conversation snapshots and bounded newest-first message history automatically.
6. Open `/web`; PWA schema v6 bootstraps encrypted state and starts delta sync at `highWatermark`.
7. Run the physical-device matrix and plaintext canary before release promotion.

## Rollback

Stop Android upload first, then roll back PWA/API and Android together. The added SQLite/Room columns and tables are additive and may remain unused. Restore the pre-migration GMweb backup only if server sequences/state must also be rolled back; doing so requires replay from Android. Do not merge an old plaintext backup into the active encrypted store.
