"use strict";

/**
 * Live Android runtime metadata, keyed by device id.
 *
 * WHY THIS EXISTS (production incident):
 *   The Android app version was only ever learned from `device_telemetry_history`.
 *   When the phone stopped uploading telemetry, GMweb kept reporting the version
 *   from the last telemetry row (3.4.17, Sep 30) even though the running APK was
 *   newer. Presence said ONLINE while the version said two days old.
 *
 *   It also created a recovery deadlock: the PWA refused to send
 *   REFRESH_DEVICE_TELEMETRY unless *telemetry* advertised the capability — but
 *   stale telemetry is precisely the thing the command exists to fix. A phone
 *   that genuinely supported the command could never be asked to refresh.
 *
 * Three facts are now separate and must never be conflated:
 *   - phone liveness          -> AgentActivityStore (authenticated activity)
 *   - Android runtime/version -> this store (live signed request metadata)
 *   - device/SIM telemetry    -> DeviceTelemetryStore (server receipt time)
 *
 * The runtime block rides along with the high-frequency command poll the phone
 * already performs, so no new endpoint and no extra traffic are introduced.
 *
 * It is FEATURE/RUNTIME EVIDENCE ONLY. It never grants authorization: the
 * request must already have passed AgentAuth, and every route keeps enforcing
 * its own capability and crypto checks.
 */

const MAX_COMMAND_TYPES = 32;
const MAX_COMMAND_TYPE_LENGTH = 64;
const MAX_VERSION_NAME_LENGTH = 64;
const MAX_PROTOCOL_VERSION = 1000;

/**
 * Unchanged polls would otherwise cost one write every ~2s per device. The
 * in-memory value stays exact; the row is rewritten at most this often unless
 * the metadata actually changes, in which case it is persisted immediately.
 */
const RUNTIME_WRITE_INTERVAL_MS = 15_000;

/** Shared with the telemetry ingest path so there is one implementation. */
function normalizeCommandTypes(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const entry of value.slice(0, MAX_COMMAND_TYPES)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || trimmed.length > MAX_COMMAND_TYPE_LENGTH) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Defensive validation. Returns null when the block carries nothing usable, so
 * an empty or malformed runtime never creates a row.
 *
 * `commandTypes` absent stays `[]` (distinct from "no runtime at all"), which is
 * how an older build is correctly read as "remote refresh unsupported".
 */
function normalizeAgentRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const name = typeof value.appVersionName === "string"
    ? value.appVersionName.trim().slice(0, MAX_VERSION_NAME_LENGTH) || null
    : null;
  const code = Number.isSafeInteger(value.appVersionCode) && value.appVersionCode >= 0
    ? value.appVersionCode
    : null;
  const protocolVersion = Number.isSafeInteger(value.protocolVersion)
    && value.protocolVersion >= 0 && value.protocolVersion <= MAX_PROTOCOL_VERSION
    ? value.protocolVersion
    : null;
  const commandTypes = normalizeCommandTypes(value.commandTypes);

  if (name === null && code === null && commandTypes === null) return null;
  return {
    appVersionName: name,
    appVersionCode: code,
    protocolVersion,
    commandTypes: commandTypes ?? [],
  };
}

class AgentRuntimeStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_runtime (
      device_id TEXT PRIMARY KEY,
      app_version_name TEXT,
      app_version_code INTEGER,
      protocol_version INTEGER,
      command_types_json TEXT NOT NULL DEFAULT '[]',
      last_runtime_at INTEGER NOT NULL,
      last_runtime_source TEXT NOT NULL
    );`);
    this.upsertStatement = db.prepare(`INSERT INTO agent_runtime
      (device_id, app_version_name, app_version_code, protocol_version, command_types_json,
       last_runtime_at, last_runtime_source)
      VALUES (@deviceId, @name, @code, @protocol, @types, @at, @source)
      ON CONFLICT(device_id) DO UPDATE SET
        app_version_name = excluded.app_version_name,
        app_version_code = excluded.app_version_code,
        protocol_version = excluded.protocol_version,
        command_types_json = excluded.command_types_json,
        last_runtime_at = excluded.last_runtime_at,
        last_runtime_source = excluded.last_runtime_source`);
    this.getStatement = db.prepare(`SELECT * FROM agent_runtime WHERE device_id = ?`);
    this.allStatement = db.prepare(`SELECT * FROM agent_runtime ORDER BY last_runtime_at DESC`);
    // Coalescing state and the last persisted signature.
    this.cache = new Map();
  }

  /** Reads the durable row once and caches its signature. */
  #load(deviceId) {
    const row = this.getStatement.get(deviceId);
    if (!row) return null;
    let commandTypes = [];
    try {
      const parsed = JSON.parse(row.command_types_json);
      if (Array.isArray(parsed)) commandTypes = parsed;
    } catch {
      // A corrupt column degrades to "no advertised capabilities" rather than
      // throwing on the presence path.
    }
    const entry = {
      appVersionName: row.app_version_name,
      appVersionCode: row.app_version_code,
      protocolVersion: row.protocol_version,
      commandTypes,
      lastRuntimeAt: row.last_runtime_at,
      source: row.last_runtime_source,
      signature: "",
    };
    entry.signature = AgentRuntimeStore.signature(entry);
    this.cache.set(deviceId, entry);
    return entry;
  }

  static signature(runtime) {
    return JSON.stringify([
      runtime.appVersionName ?? null,
      runtime.appVersionCode ?? null,
      runtime.protocolVersion ?? null,
      Array.isArray(runtime.commandTypes) ? runtime.commandTypes : [],
    ]);
  }

  /**
   * Record live runtime metadata from an ALREADY AUTHENTICATED request.
   * @returns {boolean} true when the row was persisted on this call.
   */
  record(deviceId, rawRuntime, source, now = Date.now()) {
    if (!deviceId) return false;
    const runtime = normalizeAgentRuntime(rawRuntime);
    if (!runtime) return false;
    const key = String(deviceId);
    const signature = AgentRuntimeStore.signature(runtime);
    const previous = this.cache.get(key) ?? this.#load(key);
    const changed = !previous || previous.signature !== signature;

    if (!changed && now - previous.lastRuntimeAt < RUNTIME_WRITE_INTERVAL_MS) {
      // Identical metadata: keep the in-memory view exact, skip the write.
      previous.lastRuntimeAt = now;
      previous.source = source;
      this.cache.set(key, previous);
      return false;
    }

    this.upsertStatement.run({
      deviceId: key, name: runtime.appVersionName, code: runtime.appVersionCode,
      protocol: runtime.protocolVersion, types: JSON.stringify(runtime.commandTypes),
      at: now, source,
    });
    this.cache.set(key, { ...runtime, lastRuntimeAt: now, source, signature });
    return true;
  }

  get(deviceId) {
    if (!deviceId) return null;
    const key = String(deviceId);
    const entry = this.cache.get(key) ?? this.#load(key);
    if (!entry) return null;
    return {
      deviceId: key,
      appVersionName: entry.appVersionName,
      appVersionCode: entry.appVersionCode,
      protocolVersion: entry.protocolVersion,
      commandTypes: [...entry.commandTypes],
      receivedAt: entry.lastRuntimeAt,
      source: entry.source,
    };
  }

  getAll() {
    const ids = new Set(this.allStatement.all().map((row) => row.device_id));
    for (const id of this.cache.keys()) ids.add(id);
    return [...ids].map((id) => this.get(id)).filter(Boolean)
      .sort((a, b) => b.receivedAt - a.receivedAt);
  }

  /** True when live runtime metadata advertises `commandType`. */
  supports(deviceId, commandType, now = Date.now(), maxAgeMs = 5 * 60_000) {
    const runtime = this.get(deviceId);
    if (!runtime) return false;
    // A stale runtime snapshot must not authorise a command the phone may no
    // longer support; presence is a separate axis and is checked elsewhere.
    if (now - runtime.receivedAt > maxAgeMs) return false;
    return runtime.commandTypes.includes(commandType);
  }
}

module.exports = {
  AgentRuntimeStore,
  normalizeAgentRuntime,
  normalizeCommandTypes,
  MAX_COMMAND_TYPES,
  MAX_COMMAND_TYPE_LENGTH,
  MAX_VERSION_NAME_LENGTH,
  RUNTIME_WRITE_INTERVAL_MS,
};
