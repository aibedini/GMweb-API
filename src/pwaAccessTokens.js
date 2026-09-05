"use strict";

const crypto = require("node:crypto");

const TOKEN_BYTES = 32;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest();
}

function safeHashEqual(actual, expected) {
  const a = Buffer.isBuffer(actual) ? actual : Buffer.from(actual || "");
  const b = Buffer.isBuffer(expected) ? expected : Buffer.from(expected || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class PwaAccessTokenStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS pwa_access_tokens (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        token_hash BLOB NOT NULL,
        token_preview TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER,
        revoked_at INTEGER,
        device_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pwa_access_tokens_active
        ON pwa_access_tokens(expires_at, consumed_at, revoked_at);
    `);
    this.insert = db.prepare(`
      INSERT INTO pwa_access_tokens
        (id, label, token_hash, token_preview, created_at, expires_at)
      VALUES (@id, @label, @tokenHash, @tokenPreview, @createdAt, @expiresAt)
    `);
    this.active = db.prepare(`
      SELECT * FROM pwa_access_tokens
      WHERE consumed_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
    `);
    this.consumeById = db.prepare(`
      UPDATE pwa_access_tokens SET consumed_at = ?, device_id = ?
      WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at >= ?
    `);
    this.listRows = db.prepare("SELECT * FROM pwa_access_tokens ORDER BY created_at DESC LIMIT 100");
    this.findById = db.prepare("SELECT * FROM pwa_access_tokens WHERE id = ?");
    this.revokeById = db.prepare("UPDATE pwa_access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL");
    this.consumeTransaction = db.transaction((token, deviceId, now) => {
      const incomingHash = hashToken(token);
      for (const row of this.active.all(now)) {
        if (!safeHashEqual(incomingHash, row.token_hash)) continue;
        const changed = this.consumeById.run(now, String(deviceId).slice(0, 128), row.id, now);
        if (changed.changes === 1) return this.publicView({ ...row, consumed_at: now, device_id: deviceId });
      }
      return null;
    });
  }

  create({ label = "Browser", ttlMs = DEFAULT_TTL_MS } = {}) {
    const now = Date.now();
    const safeTtl = Math.min(MAX_TTL_MS, Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS));
    const id = crypto.randomBytes(8).toString("hex");
    const token = `pwa_${crypto.randomBytes(TOKEN_BYTES).toString("base64url")}`;
    const row = {
      id,
      label: String(label || "Browser").trim().slice(0, 64) || "Browser",
      tokenHash: hashToken(token),
      tokenPreview: `${token.slice(0, 10)}...`,
      createdAt: now,
      expiresAt: now + safeTtl,
    };
    this.insert.run(row);
    return { ...this.publicView({
      id: row.id,
      label: row.label,
      token_preview: row.tokenPreview,
      created_at: row.createdAt,
      expires_at: row.expiresAt,
      consumed_at: null,
      revoked_at: null,
      device_id: null,
    }), token };
  }

  consume(token, deviceId) {
    if (!token || !deviceId) return null;
    return this.consumeTransaction(String(token), String(deviceId), Date.now());
  }

  revoke(id) {
    const row = this.findById.get(String(id));
    if (!row) return null;
    this.revokeById.run(Date.now(), String(id));
    return this.publicView({ ...row, revoked_at: Date.now() });
  }

  list() {
    return this.listRows.all().map((row) => this.publicView(row));
  }

  publicView(row) {
    const now = Date.now();
    let status = "READY";
    if (row.revoked_at) status = "REVOKED";
    else if (row.consumed_at) status = "USED";
    else if (row.expires_at < now) status = "EXPIRED";
    return {
      id: row.id,
      label: row.label,
      tokenPreview: row.token_preview,
      status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at || null,
      revokedAt: row.revoked_at || null,
      deviceId: row.device_id || null,
    };
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  PwaAccessTokenStore,
  hashToken,
  safeHashEqual,
};
