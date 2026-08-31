"use strict";

/**
 * web-01 (§45/§89) — Web Push (VAPID) for the control plane.
 *
 * Push is a WAKE-UP SIGNAL ONLY (§5/§30): payloads carry zero message
 * content — just {type:"sync.available", newEvents}. The client opens the
 * PWA and cursor-syncs. Content-less by default = the §30 privacy default;
 * preview opt-in is a later product decision, not an accident.
 *
 * VAPID keys: generated once, persisted to data/webpush-vapid.json (same
 * pattern as device-key.json; never committed — gitignored data dir).
 * Subscriptions: durable rows in the control DB, keyed by a SHA-256 hash of
 * the endpoint URL (the raw URL can contain capability tokens; we never need
 * it beyond delivery + dedupe).
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let webpush = null;
function loadWebPush() {
  if (!webpush) webpush = require("web-push");
  return webpush;
}

class WebPushService {
  /**
   * @param {import("better-sqlite3").Database} db
   * @param {object} opts { vapidKeyPath, subject }
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.vapidKeyPath = opts.vapidKeyPath || path.join(process.cwd(), "data", "webpush-vapid.json");
    this.subject = opts.subject || "mailto:gmweb-operator@localhost";
    this.keys = null; // { publicKey, privateKey } — loaded lazily

    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint_hash TEXT PRIMARY KEY,
        endpoint      TEXT NOT NULL,
        p256dh        TEXT NOT NULL,
        auth          TEXT NOT NULL,
        user_agent    TEXT,
        created_at    INTEGER NOT NULL,
        last_success  INTEGER
      );
    `);
    this.upsertStmt = db.prepare(
      `INSERT INTO push_subscriptions (endpoint_hash, endpoint, p256dh, auth, user_agent, created_at)
       VALUES (@endpoint_hash, @endpoint, @p256dh, @auth, @user_agent, @created_at)
       ON CONFLICT(endpoint_hash) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent`
    );
    this.allStmt = db.prepare(`SELECT * FROM push_subscriptions`);
    this.markSuccessStmt = db.prepare(
      `UPDATE push_subscriptions SET last_success = ? WHERE endpoint_hash = ?`
    );
    this.deleteStmt = db.prepare(`DELETE FROM push_subscriptions WHERE endpoint_hash = ?`);
    this.countStmt = db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`);
  }

  endpointHash(endpoint) {
    return crypto.createHash("sha256").update(String(endpoint)).digest("hex");
  }

  /** Load or generate the VAPID keypair (idempotent; file is chmod 600-ish). */
  ensureKeys() {
    if (this.keys) return this.keys;
    try {
      const raw = fs.readFileSync(this.vapidKeyPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.publicKey && parsed.privateKey) {
        this.keys = parsed;
        return this.keys;
      }
    } catch { /* generate below */ }
    const keys = loadWebPush().generateVAPIDKeys();
    this.keys = { publicKey: keys.publicKey, privateKey: keys.privateKey };
    fs.mkdirSync(path.dirname(this.vapidKeyPath), { recursive: true });
    fs.writeFileSync(this.vapidKeyPath, JSON.stringify(this.keys, null, 2), { mode: 0o600 });
    return this.keys;
  }

  publicKey() {
    return this.ensureKeys().publicKey;
  }

  upsertSubscription({ endpoint, keys, userAgent }) {
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new Error("endpoint and keys.p256dh/keys.auth are required");
    }
    this.upsertStmt.run({
      endpoint_hash: this.endpointHash(endpoint),
      endpoint: String(endpoint),
      p256dh: String(keys.p256dh),
      auth: String(keys.auth),
      user_agent: userAgent ? String(userAgent).slice(0, 200) : null,
      created_at: Date.now(),
    });
    return { ok: true };
  }

  removeSubscription(endpoint) {
    const info = this.deleteStmt.run(this.endpointHash(String(endpoint || "")));
    return info.changes > 0;
  }

  listSubscriptions() {
    return this.allStmt.all().map((r) => ({
      endpointHash: r.endpoint_hash.slice(0, 12) + "…",
      endpoint: r.endpoint.slice(0, 48) + "…",
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSuccess: r.last_success,
    }));
  }

  count() {
    return this.countStmt.get()?.n || 0;
  }

  /**
   * Content-less wake-up push to every subscription (§30). Gone endpoints
   * (404/410) are pruned. Failures are logged, never thrown (best-effort by
   * design — durability lives in the event store / cursor sync).
   */
  async notifySyncAvailable(newEvents) {
    let wp;
    try { wp = loadWebPush(); } catch (e) {
      return { sent: 0, pruned: 0, error: "web-push module unavailable" };
    }
    if (this.count() === 0) return { sent: 0, pruned: 0 };
    const keys = this.ensureKeys();
    const vapidDetails = { subject: this.subject, publicKey: keys.publicKey, privateKey: keys.privateKey };
    const payload = JSON.stringify({ type: "sync.available", newEvents: newEvents || 0 });
    let sent = 0;
    let pruned = 0;
    for (const row of this.allStmt.all()) {
      try {
        await wp.sendNotification(
          { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
          payload,
          { vapidDetails }
        );
        this.markSuccessStmt.run(Date.now(), row.endpoint_hash);
        sent++;
      } catch (error) {
        const status = error?.statusCode;
        if (status === 404 || status === 410) {
          this.deleteStmt.run(row.endpoint_hash);
          pruned++;
        }
        // anything else: keep the subscription; the next sync may succeed
      }
    }
    return { sent, pruned };
  }
}

module.exports = { WebPushService };
