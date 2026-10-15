"use strict";
// Phone liveness vs telemetry freshness.
//
// Production incident this pins down: the Web UI showed
//   "Phone Offline · Samsung SM-G998B · last seen 2 days ago"
// while the phone was authenticating command polls every few seconds and
// uploading events successfully. Presence was derived from the newest
// device-telemetry row, so a single stalled channel made a live phone look dead.
const test = require("node:test");
const assert = require("node:assert/strict");
const Database = require("better-sqlite3");

const {
  AgentActivityStore, ACTIVITY_SOURCES, PHONE_ONLINE_MS, PHONE_STALE_MS,
  derivePhonePresence, deriveTelemetryFreshness,
} = require("../src/agentActivity.js");
const { DeviceTelemetryStore } = require("../src/deviceTelemetry.js");

const NOW = 1_800_000_000_000;
const DEVICE = "8238ea53dd4bb0f0";

function newDb() { return new Database(":memory:"); }

// ------------------------------------------------------------- presence bands

test("presence bands use server-observed activity age", () => {
  assert.equal(derivePhonePresence(NOW, NOW), "ONLINE");
  assert.equal(derivePhonePresence(NOW - PHONE_ONLINE_MS, NOW), "ONLINE");
  assert.equal(derivePhonePresence(NOW - PHONE_ONLINE_MS - 1, NOW), "STALE");
  assert.equal(derivePhonePresence(NOW - PHONE_STALE_MS, NOW), "STALE");
  assert.equal(derivePhonePresence(NOW - PHONE_STALE_MS - 1, NOW), "OFFLINE");
  assert.equal(derivePhonePresence(NOW - 2 * 86400_000, NOW), "OFFLINE");
});

test("no activity at all is NEVER_SEEN, not OFFLINE", () => {
  for (const value of [null, undefined, 0, NaN, Infinity, "x"]) {
    assert.equal(derivePhonePresence(value, NOW), "NEVER_SEEN", `for ${String(value)}`);
  }
});

test("a corrupt future activity timestamp never claims ONLINE", () => {
  assert.equal(derivePhonePresence(NOW + 10 * 86400_000, NOW), "NEVER_SEEN");
  assert.equal(derivePhonePresence(NOW + 30_000, NOW), "ONLINE", "small skew within tolerance");
});

test("telemetry freshness is a separate axis with its own bands", () => {
  assert.equal(deriveTelemetryFreshness(NOW, NOW), "FRESH");
  assert.equal(deriveTelemetryFreshness(NOW - PHONE_ONLINE_MS - 1, NOW), "STALE");
  assert.equal(deriveTelemetryFreshness(NOW - 25 * 3600_000, NOW), "OLD");
  assert.equal(deriveTelemetryFreshness(null, NOW), "NEVER_REPORTED");
  assert.equal(deriveTelemetryFreshness(NOW + 10 * 86400_000, NOW), "NEVER_REPORTED");
});

// ============================================================ THE INCIDENT ===

test("REGRESSION: fresh activity + 2-day-old telemetry => phone ONLINE, telemetry STALE", () => {
  const db = newDb();
  const activity = new AgentActivityStore(db);
  const telemetry = new DeviceTelemetryStore(db);

  // The phone uploaded one telemetry report two days ago...
  telemetry.upsert({ deviceId: DEVICE, timestamp: NOW - 2 * 86400_000, device: { model: "SM-G998B" } }, "PRIMARY_TRUST_AGENT");
  // ...and has been polling commands 3 seconds ago (the real production state).
  activity.record(DEVICE, ACTIVITY_SOURCES.COMMAND_POLL, NOW - 3_000);

  const lastActivityAt = activity.get(DEVICE).lastActivityAt;
  const receivedAt = telemetry.get(DEVICE).receivedAt;

  // Old behaviour: presence came from telemetry -> OFFLINE. That was the bug.
  assert.equal(derivePhonePresence(receivedAt, NOW), "OFFLINE", "telemetry age alone looks offline");
  // New behaviour: presence comes from activity -> ONLINE, telemetry reported honestly.
  assert.equal(derivePhonePresence(lastActivityAt, NOW), "ONLINE");
  assert.equal(deriveTelemetryFreshness(receivedAt, NOW), "OLD");
  db.close();
});

test("presence survives every channel that actually proves liveness", () => {
  for (const source of Object.values(ACTIVITY_SOURCES)) {
    const db = newDb();
    const store = new AgentActivityStore(db);
    store.record(DEVICE, source, NOW - 1_000);
    assert.equal(derivePhonePresence(store.get(DEVICE).lastActivityAt, NOW), "ONLINE", `via ${source}`);
    assert.equal(store.get(DEVICE).lastSource, source);
    db.close();
  }
});

// ------------------------------------------------------------ activity store

test("activity store records, reads back and coalesces writes", () => {
  const db = newDb();
  const store = new AgentActivityStore(db);
  assert.equal(store.get(DEVICE), null);

  assert.equal(store.record(DEVICE, ACTIVITY_SOURCES.COMMAND_POLL, NOW), true, "first write persists");
  // Within the coalescing window: in-memory stays exact, no extra row write.
  assert.equal(store.record(DEVICE, ACTIVITY_SOURCES.EVENT_UPLOAD, NOW + 1_000), false);
  assert.equal(store.get(DEVICE).lastActivityAt, NOW + 1_000);
  assert.equal(store.get(DEVICE).lastSource, ACTIVITY_SOURCES.EVENT_UPLOAD);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_activity").get().n, 1);

  // Beyond the window the value is persisted.
  assert.equal(store.record(DEVICE, ACTIVITY_SOURCES.TRUST, NOW + 60_000), true);
  assert.equal(store.get(DEVICE).lastActivityAt, NOW + 60_000);

  // A fresh store instance (process restart) still sees the durable value.
  const reopened = new AgentActivityStore(db);
  assert.equal(reopened.get(DEVICE).lastActivityAt, NOW + 60_000, "survives restart");
  assert.equal(reopened.get(DEVICE).lastSource, ACTIVITY_SOURCES.TRUST);
  db.close();
});

test("activity store ignores an empty device id and never regresses", () => {
  const db = newDb();
  const store = new AgentActivityStore(db);
  for (const bad of [null, undefined, ""]) assert.equal(store.record(bad, ACTIVITY_SOURCES.COMMAND_POLL, NOW), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_activity").get().n, 0);

  store.record(DEVICE, ACTIVITY_SOURCES.COMMAND_POLL, NOW);
  store.record(DEVICE, ACTIVITY_SOURCES.EVENT_UPLOAD, NOW + 120_000);
  assert.equal(store.get(DEVICE).lastActivityAt, NOW + 120_000, "newer activity wins");
  db.close();
});

test("getAll reports newest first across devices", () => {
  const db = newDb();
  const store = new AgentActivityStore(db);
  store.record("dev-a", ACTIVITY_SOURCES.COMMAND_POLL, NOW - 5_000);
  store.record("dev-b", ACTIVITY_SOURCES.EVENT_UPLOAD, NOW - 1_000);
  const all = store.getAll();
  assert.deepEqual(all.map(entry => entry.deviceId), ["dev-b", "dev-a"]);
  db.close();
});

test("backfill seeds presence from durable event evidence after a deploy", () => {
  const db = newDb();
  const store = new AgentActivityStore(db);
  db.exec(`CREATE TABLE sync_events (sequence INTEGER PRIMARY KEY, source_device_id TEXT, created_at INTEGER)`);
  db.prepare("INSERT INTO sync_events VALUES (1, ?, ?)").run(DEVICE, NOW - 4_000);
  db.prepare("INSERT INTO sync_events VALUES (2, ?, ?)").run(DEVICE, NOW - 2_000);
  db.prepare("INSERT INTO sync_events VALUES (3, ?, ?)").run("other", NOW - 900_000);

  assert.equal(store.backfillFromEvents(NOW), 2);
  assert.equal(store.get(DEVICE).lastActivityAt, NOW - 2_000, "takes the newest event");
  assert.equal(store.get(DEVICE).lastSource, ACTIVITY_SOURCES.EVENT_UPLOAD);
  assert.equal(derivePhonePresence(store.get(DEVICE).lastActivityAt, NOW), "ONLINE");
  assert.equal(derivePhonePresence(store.get("other").lastActivityAt, NOW), "OFFLINE");
  assert.equal(store.backfillFromEvents(NOW), 0, "idempotent: does not regress or duplicate");
  db.close();
});

test("backfill tolerates a missing sync_events table", () => {
  const db = newDb();
  const store = new AgentActivityStore(db);
  assert.equal(store.backfillFromEvents(NOW), 0);
  db.close();
});

// ------------------------------------------------- DeviceTelemetryStore fix

test("latest telemetry is chosen by SERVER receipt time", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const db2 = db;
  // Insert directly so we control received_at independently of observed_at.
  const insert = db2.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`);
  insert.run(DEVICE, NOW - 10_000, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: DEVICE, timestamp: NOW - 10_000 }), NOW - 10_000);
  insert.run(DEVICE, NOW - 5_000, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: DEVICE, timestamp: NOW - 5_000 }), NOW - 5_000);

  assert.equal(store.get(DEVICE).receivedAt, NOW - 5_000, "newest receipt wins");
  assert.equal(store.getPrimary().receivedAt, NOW - 5_000);
  db.close();
});

test("LATENT BUG: an ahead phone clock cannot shadow newer telemetry", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const insert = db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`);

  // The phone clock was 2 days ahead: observed_at is in the future, but the
  // server received it 2 days AGO.
  const futureObserved = NOW + 2 * 86400_000;
  insert.run(DEVICE, futureObserved, "PRIMARY_TRUST_AGENT",
    JSON.stringify({ deviceId: DEVICE, timestamp: futureObserved }), NOW - 2 * 86400_000);
  // Every subsequent report carries a NORMAL (smaller) observed_at.
  insert.run(DEVICE, NOW - 1_000, "PRIMARY_TRUST_AGENT",
    JSON.stringify({ deviceId: DEVICE, timestamp: NOW - 1_000 }), NOW - 1_000);

  // Old query (ORDER BY observed_at DESC) would have returned the future row.
  const byObserved = db.prepare(`SELECT received_at FROM device_telemetry_history
    WHERE device_id = ? ORDER BY observed_at DESC LIMIT 1`).get(DEVICE);
  assert.equal(byObserved.received_at, NOW - 2 * 86400_000, "demonstrates the old shadowing");

  // The fixed query returns the genuinely newest report.
  assert.equal(store.get(DEVICE).receivedAt, NOW - 1_000, "fixed: newest receipt wins");
  assert.equal(store.getPrimary().receivedAt, NOW - 1_000);
  db.close();
});

test("getAll picks each device's newest receipt, not its largest observed_at", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const insert = db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`);
  insert.run("dev-a", NOW + 9_000_000, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: "dev-a", timestamp: NOW }), NOW - 9_000_000);
  insert.run("dev-a", NOW - 1_000, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: "dev-a", timestamp: NOW - 1_000 }), NOW - 1_000);
  insert.run("dev-b", NOW - 2_000, "LEGACY_AGENT", JSON.stringify({ deviceId: "dev-b", timestamp: NOW - 2_000 }), NOW - 2_000);

  const all = store.getAll();
  const a = all.find(entry => entry.deviceId === "dev-a");
  assert.equal(a.receivedAt, NOW - 1_000);
  assert.deepEqual(all.map(entry => entry.deviceId), ["dev-a", "dev-b"]);
  db.close();
});

test("clock skew is exposed as diagnostics and never changes freshness", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const phoneClock = NOW + 600_000; // phone is 10 minutes ahead
  store.upsert({ deviceId: DEVICE, timestamp: phoneClock }, "PRIMARY_TRUST_AGENT");
  const row = store.get(DEVICE);
  assert.equal(row.clockSkewMs > 500_000, true, "skew reported");
  // Presence/freshness derive from receivedAt, which is server time.
  assert.equal(deriveTelemetryFreshness(row.receivedAt, Date.now()), "FRESH");
  db.close();
});

test("hasNewerThan proves a REFRESH_TELEMETRY command actually produced new data", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const before = store.upsert({ deviceId: DEVICE, timestamp: NOW }, "PRIMARY_TRUST_AGENT");
  assert.equal(store.hasNewerThan(DEVICE, before), false, "no new report yet");

  // The phone's next report arrives 3s later (inserted directly to keep the
  // test deterministic instead of sleeping).
  db.prepare(`INSERT OR REPLACE INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DEVICE, NOW, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: DEVICE, timestamp: NOW }), before + 3_000);

  assert.equal(store.hasNewerThan(DEVICE, before), true, "newer receipt proves the refresh");
  assert.equal(store.hasNewerThan("nobody", 0), false);
  db.close();
});

test("a refresh that re-sends the SAME snapshot still advances receivedAt", () => {
  // The phone clock is frozen, so observed_at is identical. INSERT OR REPLACE
  // must still move received_at forward: that is the proof the phone answered
  // the refresh command, and it is why received_at — not observed_at — is the
  // freshness signal.
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  // Real clock here: upsert() stamps received_at with Date.now().
  const real = Date.now();
  db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`)
    .run(DEVICE, real, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: DEVICE, timestamp: real }), real - 60_000);
  assert.equal(store.get(DEVICE).receivedAt, real - 60_000);

  const advanced = store.upsert({ deviceId: DEVICE, timestamp: real }, "PRIMARY_TRUST_AGENT");
  assert.equal(advanced > real - 60_000, true, "receipt advanced");
  assert.equal(store.get(DEVICE).receivedAt, advanced);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_telemetry_history").get().n, 1);
  db.close();
});

test("an unchanged telemetry row is replaced in place, never duplicated", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  store.upsert({ deviceId: DEVICE, timestamp: NOW }, "PRIMARY_TRUST_AGENT");
  store.upsert({ deviceId: DEVICE, timestamp: NOW }, "PRIMARY_TRUST_AGENT");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM device_telemetry_history").get().n, 1,
    "same (device_id, observed_at) is one row");
  db.close();
});

test("telemetry landing in the same millisecond picks deterministically", () => {
  // Two reports can share a received_at. `observed_at` is the tiebreaker, so
  // the choice is stable instead of depending on row order.
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const insert = db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`);
  const sameReceipt = NOW - 1_000;
  insert.run(DEVICE, 1, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: DEVICE, timestamp: 1, n: "older" }), sameReceipt);
  insert.run(DEVICE, 2, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: DEVICE, timestamp: 2, n: "newer" }), sameReceipt);

  assert.equal(store.get(DEVICE).n, "newer", "higher observed_at breaks the tie");
  assert.equal(store.getPrimary().n, "newer");
  assert.equal(store.getAll().find(entry => entry.deviceId === DEVICE).n, "newer");
  db.close();
});

test("getAll yields exactly one row per device even with receipt ties", () => {
  const db = newDb();
  const store = new DeviceTelemetryStore(db);
  const insert = db.prepare(`INSERT INTO device_telemetry_history
    (device_id, observed_at, role, payload_json, received_at) VALUES (?, ?, ?, ?, ?)`);
  for (const n of [1, 2, 3]) {
    insert.run("dev-a", n, "PRIMARY_TRUST_AGENT", JSON.stringify({ deviceId: "dev-a", timestamp: n }), NOW);
  }
  insert.run("dev-b", 1, "LEGACY_AGENT", JSON.stringify({ deviceId: "dev-b", timestamp: 1 }), NOW - 5_000);
  const all = store.getAll();
  assert.equal(all.length, 2, "one entry per device");
  assert.equal(all.find(entry => entry.deviceId === "dev-a").timestamp, 3);
  db.close();
});
