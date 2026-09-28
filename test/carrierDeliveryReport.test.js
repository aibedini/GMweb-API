"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { SendStore } = require("../src/sendStore");
const { EveSmsEvents } = require("../src/eveSmsEvents");
const { createHarness } = require("./revocationHarness");

const at = 1_779_000_000_000;
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmweb-dlr-"));
  const dbPath = path.join(dir, "sends.db");
  const store = new SendStore(dbPath);
  const id = store.create({
    to: "+989121234567", text: "sensitive-sms-content", keyName: "eve",
    notification: { source: "eve", serviceKey: "eve:1:uuid", notificationKind: "created",
      generation: 1, eveNotificationId: "eve-notification-42" }
  });
  store.attachGatewayRequest(id, "pull_123");
  return { store, dbPath, id, close() { this.store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
function report(eventId = "dlr_one", status = "delivered") {
  return { eventId, requestId: "pull_123", status, occurredAt: at };
}
function callbacks(store) {
  return store.db.prepare("SELECT * FROM eve_sms_outbox ORDER BY id").all();
}

test("carrier report commits a physical send and PII-free signed Eve event before success", async () => {
  const f = setup();
  try {
    assert.equal(f.store.carrierStatus(f.id).status, "unavailable");
    assert.deepEqual(f.store.recordCarrierReport(report()), { ok: true, duplicate: false,
      carrierStatus: { status: "delivered", occurredAt: new Date(at).toISOString(), evidence: "android_delivery_report" } });
    assert.equal(f.store.byId(f.id).physical_submitted, 1);
    assert.deepEqual(callbacks(f.store).map((x) => x.event_type), ["send.queued", "send.sent", "sms.delivered"]);
    const body = callbacks(f.store)[2].body;
    assert.equal(body.includes("sensitive-sms-content"), false);
    assert.equal(body.includes("+989121234567"), false);
    assert.equal(JSON.parse(body).eve_notification_id, "eve-notification-42");
    for (let attempt = 0; attempt < 10; attempt++) assert.equal(f.store.recordCarrierReport(report()).duplicate, true);
    assert.equal(f.store.carrierReportStats().duplicates, 10);
    assert.equal(callbacks(f.store).length, 3);
    assert.equal(f.store.recordCarrierReport(report("dlr_one", "failed")).error, "event_id_conflict");
    assert.equal(f.store.recordCarrierReport({ ...report(), requestId: "unknown", eventId: "dlr_missing" }).error, "unknown_request_id");
    assert.equal(f.store.carrierReportStats().conflicts, 1);
    assert.equal(f.store.carrierReportStats().unknownRequests, 1);
    assert.equal(f.store.carrierReportStats().total, 1);
    assert.equal(f.store.carrierTimeline(f.id)[0].eventId, "dlr_one");
    const found = f.store.searchCarrierReports({ keyName: "eve", eventId: "dlr_one",
      status: "delivered", requestId: `send_${f.id}`, from: at - 1, to: at + 1 });
    assert.equal(found.length, 1);
    assert.equal(found[0].callbackState, "pending");
    assert.equal(JSON.stringify(found).includes("sensitive-sms-content"), false);
    assert.equal(JSON.stringify(found).includes("+989121234567"), false);
    assert.equal(f.store.searchCarrierReports({ keyName: "different-project" }).length, 0);
    assert.equal(f.store.searchCarrierReports({ callbackState: "dead_letter" }).length, 0);
    const secret = "01234567".repeat(4);
    const sent = [];
    const worker = new EveSmsEvents(f.store.db, { url: "https://eve.example.test/events", secret }, {
      fetch: async (_url, req) => { sent.push(req); return { status: 204 }; }
    });
    for (let i = 0; i < 3; i++) assert.equal(await worker.tick(), true);
    assert.equal(worker.health().delivered, 3);
    assert.equal(worker.health().pending, 0);
    const request = sent.find((x) => JSON.parse(x.body).type === "sms.delivered");
    const ts = request.headers["X-GMweb-Timestamp"];
    const delivery = request.headers["X-GMweb-Delivery-Id"];
    const expected = crypto.createHmac("sha256", secret).update(`${ts}.${delivery}.${request.body}`).digest("hex");
    assert.equal(request.headers["X-GMweb-Signature"], `sha256=${expected}`);
  } finally { f.close(); }
});

test("definitive carrier failure stays separate from recorded modem submission", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport(report("dlr_failure", "failed"));
    assert.equal(f.store.byId(f.id).status, "sent");
    assert.equal(f.store.carrierStatus(f.id).status, "failed");
    assert.deepEqual(callbacks(f.store).map((x) => x.event_type),
      ["send.queued", "send.sent", "sms.delivery_failed"]);
    assert.equal(f.store.carrierReportStats().failed, 1);
    const plan = f.store.db.prepare("EXPLAIN QUERY PLAN SELECT received_at FROM carrier_delivery_reports ORDER BY received_at DESC LIMIT 1").all();
    assert.ok(plan.some((step) => String(step.detail).includes("idx_carrier_reports_received")));
  } finally { f.close(); }
});

test("late contradictory carrier evidence stays in history while delivered remains strongest", () => {
  const f = setup();
  try {
    f.store.recordCarrierReport(report("dlr_first_failure", "failed"));
    f.store.recordCarrierReport({ ...report("dlr_delivered", "delivered"), occurredAt: at + 1 });
    f.store.recordCarrierReport({ ...report("dlr_late_failure", "failed"), occurredAt: at + 2 });
    assert.equal(f.store.carrierStatus(f.id).status, "delivered");
    assert.deepEqual(f.store.carrierTimeline(f.id).map((x) => x.status),
      ["failed", "delivered", "failed"]);
    assert.equal(callbacks(f.store).filter((x) => x.event_type.startsWith("sms.")).length, 3);
  } finally { f.close(); }
});

test("fault before commit leaves neither receipt nor callback; restart replays one event", () => {
  const f = setup();
  try {
    assert.throws(() => f.store.recordCarrierReport(report(), { fault: "beforeCommit" }), /injected/);
    assert.equal(f.store.carrierReportStats().total, 0);
    assert.deepEqual(callbacks(f.store).map((x) => x.event_type), ["send.queued"]);
    f.store.close();
    f.store = new SendStore(f.dbPath);
    assert.equal(f.store.recordCarrierReport(report()).duplicate, false);
    assert.equal(f.store.recordCarrierReport(report()).duplicate, true);
    assert.equal(callbacks(f.store).filter((x) => x.event_type === "sms.delivered").length, 1);
  } finally { f.close(); }
});

test("a carrier receipt after revocation records physical truth and one anomaly", () => {
  const f = setup();
  try {
    f.store.revokeById(f.id, { reason: "renewed" });
    f.store.finalizeSuperseded(f.id, "renewed");
    assert.equal(f.store.recordCarrierReport(report()).ok, true);
    assert.equal(f.store.byId(f.id).status, "sent");
    assert.ok(f.store.byId(f.id).sent_after_revocation_at);
    assert.equal(f.store.counters().sms_sent_after_revocation_total, 1);
    assert.equal(f.store.recordCarrierReport(report()).duplicate, true);
    assert.equal(f.store.counters().sms_sent_after_revocation_total, 1);
  } finally { f.close(); }
});

test("v4 callback table migrates without losing immutable IDs or retry state", () => {
  const f = setup();
  try {
    const before = callbacks(f.store)[0];
    f.store.db.exec(`
      DROP TRIGGER eve_sms_body_immutable;
      DROP TRIGGER eve_sms_queued_on_tag;
      DROP TRIGGER eve_sms_on_status;
      CREATE TABLE eve_sms_outbox_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        delivery_id TEXT NOT NULL UNIQUE, send_id INTEGER NOT NULL,
        event_type TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL, last_attempt_at INTEGER,
        last_http_status INTEGER, last_error TEXT, delivered_at INTEGER,
        created_at INTEGER NOT NULL, UNIQUE(send_id,event_type)
      );
      INSERT INTO eve_sms_outbox_v4 SELECT * FROM eve_sms_outbox;
      DROP TABLE eve_sms_outbox;
      ALTER TABLE eve_sms_outbox_v4 RENAME TO eve_sms_outbox;
      UPDATE eve_sms_outbox SET state='retry_wait', attempt_count=3,
        last_http_status=503, last_error='temporary' WHERE id=1;
    `);
    f.store.close();
    f.store = new SendStore(f.dbPath);
    const migrated = callbacks(f.store)[0];
    assert.equal(migrated.event_id, before.event_id);
    assert.equal(migrated.delivery_id, before.delivery_id);
    assert.equal(migrated.body, before.body);
    assert.equal(migrated.state, "retry_wait");
    assert.equal(migrated.attempt_count, 3);
    assert.equal(migrated.last_http_status, 503);
    f.store.recordCarrierReport(report("dlr_a", "delivered"));
    f.store.recordCarrierReport(report("dlr_b", "delivered"));
    assert.equal(callbacks(f.store).filter((x) => x.event_type === "sms.delivered").length, 2);
    assert.throws(() => f.store.db.prepare("UPDATE eve_sms_outbox SET body='{}' WHERE id=?").run(before.id), /immutable/);
  } finally { f.close(); }
});

test("device route enforces key, budget, body bounds, unknown IDs and idempotency", async () => {
  const h = createHarness();
  try {
    const app = await h.buildGatewayApp();
    const headers = { "x-api-key": h.deviceKey };
    const payload = { eventId: "dlr_route", requestId: "missing", status: "failed", occurredAt: at };
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers: { "x-api-key": "wrong" }, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: { ...payload, eventId: "bad" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: { ...payload, status: "sent" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: { ...payload, occurredAt: Date.now() + 90_000_000 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: { ...payload, filler: "x".repeat(2000) } })).statusCode, 413);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload })).statusCode, 404);
    const id = h.store.create({ to: "+989121234567", text: "route", keyName: "eve", notification: {
      source: "eve", serviceKey: "eve:1:uuid", notificationKind: "created", generation: 1
    } });
    h.store.attachGatewayRequest(id, "pull_route");
    const valid = { ...payload, requestId: "pull_route" };
    const first = await app.inject({ method: "POST", url: "/gateway/delivery-report",
      headers: { ...headers, "x-gateway-device-id": "phone-a" }, payload: valid });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().duplicate, false);
    assert.equal(h.store.db.prepare("SELECT device_id FROM carrier_delivery_reports WHERE event_id='dlr_route'").get().device_id, "phone-a");
    assert.equal(JSON.parse(h.store.db.prepare("SELECT body FROM eve_sms_outbox WHERE event_id='dlr_route'").get().body).device_id, "phone-a");
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: valid })).json().duplicate, true);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers,
      payload: { ...valid, eventId: "dlr_989121234567" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: { ...valid, status: "delivered" } })).statusCode, 409);
    await app.close();
    const limited = await h.buildGatewayApp({ checkRateLimit: () => ({ allowed: false, retryAfterSeconds: 3 }) });
    assert.equal((await limited.inject({ method: "POST", url: "/gateway/delivery-report", headers, payload: valid })).statusCode, 429);
    await limited.close();
  } finally { h.close(); }
});
