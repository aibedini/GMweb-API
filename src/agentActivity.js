"use strict";

/**
 * Phone liveness, derived from server-observed authenticated agent activity.
 *
 * Why this exists (production incident):
 *   GMweb derived "is the Primary phone online?" solely from the `receivedAt`
 *   of the newest device-telemetry row. When Android stopped uploading
 *   telemetry, every other channel kept working — commands/claim, events/batch
 *   and trust/position were all succeeding every few seconds — yet the Web UI
 *   showed "Phone Offline · last seen 2 days ago".
 *
 *   Telemetry freshness and phone liveness are DIFFERENT facts and must never
 *   be collapsed into one. Liveness is "did this agent authenticate a request
 *   recently?", which only the server can answer, and only with the server's
 *   own clock.
 *
 * Invariants:
 *   - timestamps are SERVER receipt times (`Date.now()`), never phone-supplied
 *   - the phone's `observed_at` is diagnostic data only and never affects presence
 *   - a failure to authenticate records nothing
 */

/** Authenticated activity within this window means the phone is reachable. */
const PHONE_ONLINE_MS = 90_000;
/** Beyond ONLINE but within this, the phone is reachable but lagging. */
const PHONE_STALE_MS = 180_000;

/**
 * Writing one row per authenticated request would mean ~43k writes/day for a
 * 2-second poll. Coalesce to at most one write per device per interval; the
 * in-memory value keeps presence exact between writes, and the DB value
 * survives restarts. 15s is far inside the 90s ONLINE threshold.
 */
const ACTIVITY_WRITE_INTERVAL_MS = 15_000;

/** Activity sources, ordered by how directly they prove the agent is running. */
const ACTIVITY_SOURCES = Object.freeze({
  COMMAND_POLL: "COMMAND_POLL",
  EVENT_UPLOAD: "EVENT_UPLOAD",
  TELEMETRY: "TELEMETRY",
  TRUST: "TRUST",
  IDENTITY: "IDENTITY",
  UNKNOWN: "UNKNOWN",
});

class AgentActivityStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_activity (
      device_id TEXT PRIMARY KEY,
      last_activity_at INTEGER NOT NULL,
      last_source TEXT NOT NULL
    );`);
    this.upsertStatement = db.prepare(`INSERT INTO agent_activity (device_id, last_activity_at, last_source)
      VALUES (@deviceId, @at, @source)
      ON CONFLICT(device_id) DO UPDATE SET
        last_activity_at = excluded.last_activity_at,
        last_source = excluded.last_source`);
    this.getStatement = db.prepare(`SELECT device_id, last_activity_at, last_source
      FROM agent_activity WHERE device_id = ?`);
    this.allStatement = db.prepare(`SELECT device_id, last_activity_at, last_source
      FROM agent_activity ORDER BY last_activity_at DESC`);
    this.cache = new Map();
  }

  /**
   * Record that `deviceId` authenticated a request.
   * @returns {boolean} true when the value was persisted this call.
   */
  record(deviceId, source, now = Date.now()) {
    if (!deviceId) return false;
    const key = String(deviceId);
    const label = ACTIVITY_SOURCES[source] || ACTIVITY_SOURCES.UNKNOWN;
    const cached = this.cache.get(key);
    if (cached && now - cached.lastActivityAt < ACTIVITY_WRITE_INTERVAL_MS) {
      // Keep the in-memory value current so reads are exact, skip the write.
      cached.lastActivityAt = now;
      cached.lastSource = label;
      return false;
    }
    this.upsertStatement.run({ deviceId: key, at: now, source: label });
    this.cache.set(key, { lastActivityAt: now, lastSource: label });
    return true;
  }

  get(deviceId) {
    if (!deviceId) return null;
    const key = String(deviceId);
    const cached = this.cache.get(key);
    if (cached) return { deviceId: key, ...cached };
    const row = this.getStatement.get(key);
    if (!row) return null;
    const value = { deviceId: row.device_id, lastActivityAt: row.last_activity_at, lastSource: row.last_source };
    this.cache.set(key, { lastActivityAt: value.lastActivityAt, lastSource: value.lastSource });
    return value;
  }

  getAll() {
    const merged = new Map();
    for (const row of this.allStatement.all()) {
      merged.set(row.device_id, { deviceId: row.device_id, lastActivityAt: row.last_activity_at, lastSource: row.last_source });
    }
    // In-memory values are never older than what is on disk.
    for (const [deviceId, value] of this.cache) {
      const existing = merged.get(deviceId);
      if (!existing || value.lastActivityAt > existing.lastActivityAt) {
        merged.set(deviceId, { deviceId, lastActivityAt: value.lastActivityAt, lastSource: value.lastSource });
      }
    }
    return [...merged.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * Seed from durable evidence that already exists, so presence is correct
   * immediately after a deploy instead of waiting for the next poll.
   *
   * `sync_events.created_at` is a SERVER timestamp written when an uploaded
   * event was committed, so it is trustworthy evidence of past liveness.
   */
  backfillFromEvents(now = Date.now()) {
    let changes = 0;
    try {
      const rows = this.db.prepare(`SELECT source_device_id AS device_id, MAX(created_at) AS at
        FROM sync_events WHERE source_device_id IS NOT NULL GROUP BY source_device_id`).all();
      for (const row of rows) {
        if (!row.at) continue;
        const current = this.getStatement.get(row.device_id);
        if (current && current.last_activity_at >= row.at) continue;
        this.upsertStatement.run({ deviceId: row.device_id, at: row.at, source: ACTIVITY_SOURCES.EVENT_UPLOAD });
        this.cache.delete(row.device_id);
        changes += 1;
      }
    } catch {
      // A missing/unreadable sync_events table must not stop the server.
    }
    return changes;
  }
}

/**
 * The single place presence is derived. Pure, so it is directly testable.
 *
 * @param {number|null} lastActivityAt server-observed authenticated activity
 * @param {number} now server clock
 */
function derivePhonePresence(lastActivityAt, now = Date.now()) {
  if (!lastActivityAt || !Number.isFinite(lastActivityAt)) return "NEVER_SEEN";
  // A future timestamp means the stored value is corrupt; do not claim ONLINE
  // from it, but do not pretend the phone never existed either.
  if (lastActivityAt > now + 60_000) return "NEVER_SEEN";
  const age = now - lastActivityAt;
  if (age <= PHONE_ONLINE_MS) return "ONLINE";
  if (age <= PHONE_STALE_MS) return "STALE";
  return "OFFLINE";
}

/** Telemetry freshness is a SEPARATE axis from presence. */
function deriveTelemetryFreshness(receivedAt, now = Date.now()) {
  if (!receivedAt || !Number.isFinite(receivedAt)) return "NEVER_REPORTED";
  if (receivedAt > now + 60_000) return "NEVER_REPORTED";
  const age = now - receivedAt;
  if (age <= PHONE_ONLINE_MS) return "FRESH";
  if (age <= 24 * 3600_000) return "STALE";
  return "OLD";
}

module.exports = {
  AgentActivityStore,
  ACTIVITY_SOURCES,
  ACTIVITY_WRITE_INTERVAL_MS,
  PHONE_ONLINE_MS,
  PHONE_STALE_MS,
  derivePhonePresence,
  deriveTelemetryFreshness,
};
