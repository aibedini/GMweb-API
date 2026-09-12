"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");
const policy = require("../shared/event-crypto-policy-v1.json");

const root = path.resolve(__dirname, "..");
const dbPath = path.join(root, "data", "control-plane.db");
const apply = process.argv.includes("--apply");

if (!fs.existsSync(dbPath)) {
  console.error(`Control-plane database not found: ${dbPath}`);
  process.exitCode = 1;
  return;
}

const db = new Database(dbPath, apply ? {} : { readonly: true });
const accounts = db.prepare(
  "SELECT account_id accountId, COUNT(*) eventCount, COALESCE(MAX(sequence), 0) maxSequence FROM sync_events GROUP BY account_id"
).all();
const tableCount = (table) => db.prepare(
  "SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name=?").get(table).count
  ? db.prepare(`SELECT COUNT(*) count FROM ${table}`).get().count : 0;
const currentState = {
  messages: tableCount("encrypted_message_state"),
  conversations: tableCount("encrypted_conversation_state"),
};
const contentTypes = Object.keys(policy.contentBearing);
const contentPlaceholders = contentTypes.map(() => "?").join(",");
const legacyContentCount = db.prepare(
  `SELECT COUNT(*) count FROM sync_events WHERE event_type IN (${contentPlaceholders})`
).get(...contentTypes).count;

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", database: dbPath, accounts, currentState, legacyContentCount }, null, 2));
  console.log("No data changed. Stop GMweb, then rerun with --apply to back up and purge data-plane replica content.");
  db.close();
  return;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(root, "data", `control-plane.pre-history-v3.${stamp}.db`);

(async () => {
  try {
    await db.backup(backupPath);
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS replica_metadata (
        account_id TEXT PRIMARY KEY,
        replica_generation TEXT NOT NULL,
        snapshot_version INTEGER NOT NULL,
        minimum_available_sequence INTEGER NOT NULL,
        migration_version INTEGER NOT NULL,
        migration_completed_at INTEGER NOT NULL
      )`);
      db.prepare(`DELETE FROM sync_events WHERE event_type IN (${contentPlaceholders})`).run(...contentTypes);
      if (tableCount("encrypted_message_state")) db.prepare("DELETE FROM encrypted_message_state").run();
      if (tableCount("encrypted_conversation_state")) db.prepare("DELETE FROM encrypted_conversation_state").run();
      const metadata = db.prepare(`INSERT INTO replica_metadata
        (account_id, replica_generation, snapshot_version, minimum_available_sequence,
         migration_version, migration_completed_at)
        VALUES (?, ?, 1, ?, 2, ?)
        ON CONFLICT(account_id) DO UPDATE SET
          replica_generation=excluded.replica_generation,
          snapshot_version=excluded.snapshot_version,
          minimum_available_sequence=excluded.minimum_available_sequence,
          migration_version=excluded.migration_version,
          migration_completed_at=excluded.migration_completed_at`);
      const now = Date.now();
      for (const account of accounts) {
        metadata.run(account.accountId, crypto.randomUUID(), account.maxSequence + 1, now);
      }
    })();
    console.log(JSON.stringify({
      mode: "applied",
      backup: backupPath,
      clearedAccounts: accounts,
      next: [
        "Deploy History v3 API/PWA and Android together.",
        "Start GMweb; browsers detect the new replica generation and securely rebootstrap.",
        "Request encrypted Android history/contact replay; sequence counters remain monotonic.",
        "Keep the backup until server, Android, and PWA diagnostics pass.",
      ],
    }, null, 2));
  } finally {
    db.close();
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
