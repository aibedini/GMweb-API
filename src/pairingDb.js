"use strict";

// Production uses the existing control-plane connection. The private in-memory
// connection is only for isolated module tests that do not start server.js.
let database;
function configure(db) {
  database = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      id TEXT PRIMARY KEY, ip TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pairing_sessions_expiry ON pairing_sessions(expires_at);
    CREATE TABLE IF NOT EXISTS pairing_challenges (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS linked_sessions (
      token_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
      last_seen INTEGER NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS linked_sessions_device ON linked_sessions(device_id);
    CREATE TABLE IF NOT EXISTS primary_setup_claims (
      token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, api_origin TEXT NOT NULL
    );
  `);
}
function db() {
  if (!database) configure(new (require("better-sqlite3"))(":memory:"));
  return database;
}
module.exports = { configure, db };
