"use strict";

class DeviceTelemetryStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS device_telemetry_history (
      device_id TEXT NOT NULL, observed_at INTEGER NOT NULL, role TEXT,
      payload_json TEXT NOT NULL, received_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, observed_at)
    ); CREATE INDEX IF NOT EXISTS idx_device_telemetry_received
      ON device_telemetry_history(received_at);`);
    this.upsertStatement = db.prepare(`INSERT OR REPLACE INTO device_telemetry_history
      (device_id, observed_at, role, payload_json, received_at)
      VALUES (@deviceId, @timestamp, @role, @payload, @receivedAt)`);
    this.getStatement = db.prepare(`SELECT payload_json, role, received_at
      FROM device_telemetry_history WHERE device_id = ? ORDER BY observed_at DESC LIMIT 1`);
    this.allStatement = db.prepare(`SELECT t.device_id, t.payload_json, t.role, t.received_at
      FROM device_telemetry_history t JOIN (
        SELECT device_id, MAX(observed_at) observed_at FROM device_telemetry_history GROUP BY device_id
      ) latest ON latest.device_id=t.device_id AND latest.observed_at=t.observed_at
      ORDER BY t.received_at DESC`);
    this.primaryStatement = db.prepare(`SELECT device_id, payload_json, role, received_at
      FROM device_telemetry_history WHERE role='PRIMARY_TRUST_AGENT'
      ORDER BY observed_at DESC LIMIT 1`);
    this.cleanupStatement = db.prepare("DELETE FROM device_telemetry_history WHERE received_at < ?");
  }

  upsert(telemetry, role) {
    this.cleanup();
    this.upsertStatement.run({ deviceId: telemetry.deviceId, timestamp: telemetry.timestamp,
      role, payload: JSON.stringify(telemetry), receivedAt: Date.now() });
  }

  decode(row) {
    return row ? { ...JSON.parse(row.payload_json), role: row.role, receivedAt: row.received_at } : null;
  }

  get(deviceId) { return this.decode(this.getStatement.get(deviceId)); }
  getAll() { return this.allStatement.all().map(row => ({ deviceId: row.device_id, ...this.decode(row) })); }
  getPrimary() { return this.decode(this.primaryStatement.get()); }
  cleanup(now = Date.now()) { return this.cleanupStatement.run(now - 30 * 86400000).changes; }
}

module.exports = { DeviceTelemetryStore };
