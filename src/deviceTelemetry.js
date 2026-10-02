"use strict";

/**
 * Device telemetry history.
 *
 * LATENT BUG FIXED HERE: the "latest telemetry" queries used to order by
 * `observed_at DESC`, which is the PHONE-SUPPLIED wall clock. A phone whose
 * clock was ever temporarily ahead wrote a row with a future `observed_at`,
 * and that row then permanently shadowed every newer report until the phone
 * clock caught up — making a live phone look days out of date.
 *
 * Freshness is now decided by `received_at`, the SERVER receipt time, which no
 * phone can influence. `observed_at` is retained purely as device-reported
 * diagnostic information (see `clockSkewMs`).
 */
class DeviceTelemetryStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS device_telemetry_history (
      device_id TEXT NOT NULL, observed_at INTEGER NOT NULL, role TEXT,
      payload_json TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, observed_at)
    );
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_received
      ON device_telemetry_history(received_at);
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_device_received
      ON device_telemetry_history(device_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_device_telemetry_role_received
      ON device_telemetry_history(role, received_at DESC);`);
    this.upsertStatement = db.prepare(`INSERT OR REPLACE INTO device_telemetry_history
      (device_id, observed_at, role, payload_json, received_at)
      VALUES (@deviceId, @timestamp, @role, @payload, @receivedAt)`);
    // Server receipt time decides "latest" — never the phone clock.
    //
    // `observed_at` is only a TIEBREAKER for reports that landed within the
    // same millisecond, which keeps the choice deterministic. It cannot
    // reintroduce the shadowing bug because `received_at` dominates: a
    // future-dated `observed_at` from days ago loses to any newer receipt.
    this.getStatement = db.prepare(`SELECT payload_json, role, received_at
      FROM device_telemetry_history WHERE device_id = ?
      ORDER BY received_at DESC, observed_at DESC LIMIT 1`);
    this.allStatement = db.prepare(`SELECT device_id, payload_json, role, received_at FROM (
        SELECT device_id, payload_json, role, received_at,
          ROW_NUMBER() OVER (PARTITION BY device_id
            ORDER BY received_at DESC, observed_at DESC) AS rn
        FROM device_telemetry_history
      ) WHERE rn = 1 ORDER BY received_at DESC`);
    this.primaryStatement = db.prepare(`SELECT device_id, payload_json, role, received_at
      FROM device_telemetry_history WHERE role='PRIMARY_TRUST_AGENT'
      ORDER BY received_at DESC, observed_at DESC LIMIT 1`);
    this.cleanupStatement = db.prepare("DELETE FROM device_telemetry_history WHERE received_at < ?");
    this.hasNewerStatement = db.prepare(`SELECT 1 FROM device_telemetry_history
      WHERE device_id = ? AND received_at > ? LIMIT 1`);
  }

  upsert(telemetry, role) {
    this.cleanup();
    const receivedAt = Date.now();
    this.upsertStatement.run({ deviceId: telemetry.deviceId, timestamp: telemetry.timestamp,
      role, payload: JSON.stringify(telemetry), receivedAt });
    return receivedAt;
  }

  decode(row) {
    if (!row) return null;
    const payload = JSON.parse(row.payload_json);
    // Clock skew is diagnostic only; it never influences presence or freshness.
    const clockSkewMs = Number.isFinite(payload.timestamp) ? payload.timestamp - row.received_at : null;
    return { ...payload, role: row.role, receivedAt: row.received_at, clockSkewMs };
  }

  get(deviceId) { return this.decode(this.getStatement.get(deviceId)); }
  getAll() { return this.allStatement.all().map(row => ({ deviceId: row.device_id, ...this.decode(row) })); }
  getPrimary() { return this.decode(this.primaryStatement.get()); }
  cleanup(now = Date.now()) { return this.cleanupStatement.run(now - 30 * 86400000).changes; }

  /** True when telemetry newer than `since` exists — used to prove a refresh. */
  hasNewerThan(deviceId, since) { return Boolean(this.hasNewerStatement.get(deviceId, since)); }
}

module.exports = { DeviceTelemetryStore };
