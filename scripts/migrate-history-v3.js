"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

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

if (!apply) {
  console.log(JSON.stringify({ mode: "dry-run", database: dbPath, accounts, currentState }, null, 2));
  console.log("No data changed. Stop GMweb, then rerun with --apply to back up and reset only encrypted sync events.");
  db.close();
  return;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.join(root, "data", `control-plane.pre-history-v3.${stamp}.db`);

(async () => {
  try {
    await db.backup(backupPath);
    db.transaction(() => {
    db.prepare("DELETE FROM sync_events").run();
    if (tableCount("encrypted_message_state")) db.prepare("DELETE FROM encrypted_message_state").run();
    if (tableCount("encrypted_conversation_state")) db.prepare("DELETE FROM encrypted_conversation_state").run();
      db.prepare("UPDATE event_counters SET next_sequence = 1").run();
    })();
    console.log(JSON.stringify({
      mode: "applied",
      backup: backupPath,
      clearedAccounts: accounts,
      next: [
        "Deploy History v3 API/PWA and Android together.",
        "Reset and pair the browser once so its IndexedDB cursor starts at zero.",
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
